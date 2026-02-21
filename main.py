import os
import sys
import socket
import psutil
from pathlib import Path
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
from fastapi.concurrency import run_in_threadpool
from contextlib import asynccontextmanager

from config       import BASE_DIR, load_config, save_config, show_message
from media_mounter import mount_multiple, list_media_files, get_folder_stats
from photo        import scan_photos, update_photo_location_db, init_photo_db
from music        import scan_music_metadata, build_music_list
import lyrics

import httpx
import geo

# --- PATHS ---
STATIC_DIR       = BASE_DIR / "static"
PHOTO_META_FILE  = BASE_DIR / "photo_meta.json"
MUSIC_META_FILE  = BASE_DIR / "music_meta.json"
MUSIC_ART_DIR    = BASE_DIR / "music_art"
MUSIC_ART_DIR.mkdir(exist_ok=True)

# --- GLOBALS ---
config_data    = load_config()
media_cache    = {"photos": [], "music": [], "videos": []}
music_metadata = {}
PHOTO_PATHS    = []
MUSIC_PATHS    = []
VIDEO_PATHS    = []


# --- LIFESPAN ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    global media_cache, music_metadata, PHOTO_PATHS, MUSIC_PATHS, VIDEO_PATHS

    # Mount folders
    PHOTO_PATHS = mount_multiple(app, config_data.get("photo", {}).get("folders", []), "photos")
    MUSIC_PATHS = mount_multiple(app, config_data.get("music", {}).get("folders", []), "music")
    VIDEO_PATHS = mount_multiple(app, config_data.get("video", {}).get("folders", []), "videos")

    init_photo_db()

    # Scan music metadata — respects extensions from config
    music_metadata = scan_music_metadata(
        config_data.get("music", {}).get("folders", []),
        MUSIC_META_FILE,
        config_data.get("music", {}).get("extensions", [".mp3"]),
        art_dir=MUSIC_ART_DIR
    )

    # Full media scan
    _run_scan()

    yield

    show_message("--- SHUTTING DOWN ---")
    await lyrics.http_client.aclose()
    await async_client.aclose()
    show_message("✅ Lyrics HTTP client closed.")


# --- APP ---
app = FastAPI(lifespan=lifespan)
app.mount("/static",     StaticFiles(directory=str(STATIC_DIR)),    name="static")
app.mount("/music_art",  StaticFiles(directory=str(MUSIC_ART_DIR)), name="music_art")
templates = Jinja2Templates(directory=str(STATIC_DIR))


# --- INTERNAL SCAN LOGIC ---
def _run_scan():
    """Runs a full media scan and updates media_cache. Extensions come from config."""
    global media_cache
    show_message("--- STARTING SCAN ---")

    photo_exts = set(config_data.get("photo", {}).get("extensions", []))
    music_exts =     config_data.get("music", {}).get("extensions", [])
    video_exts =     config_data.get("video", {}).get("extensions", [])

    photos = scan_photos(PHOTO_PATHS, photo_exts)
    music  = build_music_list(MUSIC_PATHS, music_exts, music_metadata)
    videos = list_media_files(VIDEO_PATHS, "videos", video_exts)

    media_cache = {"photos": photos, "music": music, "videos": videos}
    show_message(f"✅ Scan complete — {len(photos)} photos, {len(music)} tracks, {len(videos)} videos")


# =====================================================================
# ROUTES
# =====================================================================




@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/lyrics")
async def get_lyrics_route(
    artist: str = Query(...), 
    title: str = Query(...),
    name: str = Query(...)
):
    # This now runs the 4-tier check (Local -> LRCLIB -> NetEase -> Static OVH)
    return await lyrics.fetch_lyrics_waterfall(artist, title, name)

# Initialize a global client to reuse connections (faster)
async_client = httpx.AsyncClient()


@app.get("/api/geocode")
async def proxy_geocode(lat: float, lon: float, url: str):
    global media_cache
    
    try:
        # 1. Try Local Cache (Threaded for SQLite)
        location_name = await run_in_threadpool(geo.get_location_from_cache, lat, lon)
        
        # 2. If not in cache, call API
        if not location_name:
            location_name = await geo.fetch_from_nominatim(lat, lon, async_client)
            if location_name:
                # Save to local cache for next time
                await run_in_threadpool(geo.save_to_geo_cache, lat, lon, location_name)

        # 3. Handle successful finding (either from cache or API)
        if location_name:
            # Update your existing photo DB
            await run_in_threadpool(update_photo_location_db, url, location_name)
            
            # Update Memory Cache for UI
            for photo in media_cache.get("photos", []):
                if photo["url"] == url:
                    photo["location"] = location_name
                    break
            
            return {"location": location_name}
        
        return {"error": "Location not found"}

    except Exception as e:
        return {"error": str(e)}

@app.get("/api/content")
async def get_content():
    """Returns all media + config to the frontend. Served from memory — instant."""
    return {
        "photos": media_cache["photos"],
        "music":  media_cache["music"],
        "videos": media_cache["videos"],
        "config": config_data
    }


@app.get("/api/config")
async def get_config():
    """Returns the current config.json."""
    try:
        return load_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/settings")
async def update_settings(request: Request):
    """Saves new settings, re-mounts paths, re-scans music metadata."""
    global config_data, music_metadata, PHOTO_PATHS, MUSIC_PATHS, VIDEO_PATHS
    try:
        new_config = await request.json()
        save_config(new_config)
        config_data = load_config()

        PHOTO_PATHS = mount_multiple(app, config_data.get("photo", {}).get("folders", []), "photos")
        MUSIC_PATHS = mount_multiple(app, config_data.get("music", {}).get("folders", []), "music")
        VIDEO_PATHS = mount_multiple(app, config_data.get("video", {}).get("folders", []), "videos")

        # Re-index music with updated extensions from new config
        music_metadata = scan_music_metadata(
            config_data.get("music", {}).get("folders", []),
            MUSIC_META_FILE,
            config_data.get("music", {}).get("extensions", []),
            art_dir=MUSIC_ART_DIR
        )

        show_message("--- CONFIG UPDATED & PATHS RE-MAPPED ---")
        return {"status": "success"}

    except Exception as e:
        show_message(f"Error saving config: {e}")
        raise HTTPException(status_code=500, detail="Failed to save settings")


@app.get("/api/refresh")
async def trigger_refresh(background_tasks: BackgroundTasks):
    """Triggers a background media re-scan without blocking the UI."""
    background_tasks.add_task(_run_scan)
    return {"status": "Scan started in background"}


@app.post("/api/rescan-music")
async def rescan_music():
    """Re-indexes music metadata only (faster than a full scan)."""
    global music_metadata, media_cache
    music_exts             = config_data.get("music", {}).get("extensions", [])
    music_metadata         = scan_music_metadata(
        config_data.get("music", {}).get("folders", []),
        MUSIC_META_FILE,
        music_exts,
        art_dir=MUSIC_ART_DIR
    )
    media_cache["music"]   = build_music_list(MUSIC_PATHS, music_exts, music_metadata)
    return {"status": "ok", "tracks": len(media_cache["music"])}


@app.get("/api/status")
async def get_status():
    """Returns system stats and per-folder media counts."""
    show_message("Status requested by client.")
    sections = [
        ("Photos", PHOTO_PATHS, config_data.get("photo", {}).get("extensions", [])),
        ("Music",  MUSIC_PATHS, config_data.get("music", {}).get("extensions", [])),
        ("Videos", VIDEO_PATHS, config_data.get("video", {}).get("extensions", [])),
    ]
    folder_stats = {
        name: get_folder_stats(paths, exts)
        for name, paths, exts in sections
    }
    return {
        "system": {
            "cpu_load": f"{psutil.cpu_percent()}%",
            "memory":   f"{psutil.virtual_memory().percent}% used",
        },
        "media_summary": folder_stats,
        "mode": config_data.get("mode", "photo")
    }


@app.post("/api/restart")
async def trigger_restart():
    """Restarts the server process."""
    try:
        from threading import Timer
        Timer(1.0, _restart_server).start()
        return {"status": "restarting"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =====================================================================
# HELPERS
# =====================================================================

def _restart_server():
    show_message("🔄 SERVER RESTARTING...")
    os.execv(sys.executable, ['python'] + sys.argv)


def _get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except:
        return '127.0.0.1'
    finally:
        s.close()


# =====================================================================
# ENTRY POINT
# =====================================================================




import webbrowser
from threading import Timer

def _open_browser(url: str):
    """Helper to open the default web browser."""
    show_message(f"🌐 Opening browser to {url}")
    webbrowser.open(url)

if __name__ == "__main__":
    import uvicorn
    ip = _get_local_ip()
    server_url = f"http://{ip}:8000"
    
    show_message("\n" + "=" * 50)
    show_message("DARO PORTO SERVER STARTING")
    show_message(f"Local IP : {ip}")
    show_message(f"URL      : {server_url}")
    show_message("=" * 50)

    # Start a timer to open the browser 1.5 seconds after uvicorn starts
    # This ensures the server is actually "up" before the window opens
    Timer(3.0, _open_browser, args=[server_url]).start()

    uvicorn.run(app, host="0.0.0.0", port=8000)