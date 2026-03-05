import os
import sys
import socket
import psutil
import mimetypes
from pathlib import Path
from fastapi import FastAPI, Request, BackgroundTasks, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, StreamingResponse, Response
from fastapi.concurrency import run_in_threadpool
from contextlib import asynccontextmanager

from config       import BASE_DIR, load_config, save_config, show_message
from media_mounter import mount_multiple, list_media_files, get_folder_stats
from photo        import scan_photos, update_photo_location_db, init_photo_db
from music        import scan_music_metadata, build_music_list
from video        import scan_videos, update_video_location_db, init_video_db
import lyrics

import httpx
import geo

# --- PATHS ---
STATIC_DIR       = BASE_DIR / "static"
MUSIC_META_FILE  = BASE_DIR / "music_meta.json"
MUSIC_ART_DIR    = BASE_DIR / "music_art"
MUSIC_ART_DIR.mkdir(exist_ok=True)


def list_video_paths(folders: list) -> list[Path]:
    """Convert video folder strings to Path objects (no StaticFiles mount needed —
    videos are served by the range-streaming endpoint)."""
    return [Path(f) for f in folders if Path(f).exists()]

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

    # Mount folders — photos and music via StaticFiles (small files, no range needed)
    # Videos are served by the range-streaming endpoint below, NOT StaticFiles
    PHOTO_PATHS = mount_multiple(app, config_data.get("photo", {}).get("folders", []), "photos")
    MUSIC_PATHS = mount_multiple(app, config_data.get("music", {}).get("folders", []), "music")
    VIDEO_PATHS = list_video_paths(config_data.get("video", {}).get("folders", []))

    init_photo_db()
    init_video_db()

    # Scan music metadata — respects extensions from config
    music_metadata = scan_music_metadata(
        config_data.get("music", {}).get("folders", []),
        MUSIC_META_FILE,
        config_data.get("music", {}).get("extensions", [".mp3"]),
        art_dir=MUSIC_ART_DIR
    )

    # Full media scan
    _run_scan()


    # Start a timer to open the browser 1.5 seconds after uvicorn starts
    # This ensures the server is actually "up" before the window opens
    Timer(3.0, _open_browser, args=[server_url]).start()

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


# =====================================================================
# VIDEO STREAMING  — proper HTTP Range support for smooth playback
# Replaces StaticFiles for /media/videos_* — same URL pattern, but
# responds with 206 Partial Content so browsers can:
#   · start playback immediately from first bytes
#   · pre-buffer efficiently without downloading whole files
#   · seek without re-downloading from the start
# =====================================================================

VIDEO_CHUNK = 1024 * 512  # 512 KB chunks


@app.get("/media/videos_{folder_index}/{filename}")
async def stream_video(folder_index: int, filename: str, request: Request):
    # Resolve file path from the in-memory VIDEO_PATHS list
    if folder_index >= len(VIDEO_PATHS):
        raise HTTPException(status_code=404, detail="Video folder not found")

    file_path = VIDEO_PATHS[folder_index] / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Video file not found")

    file_size   = file_path.stat().st_size
    mime_type   = mimetypes.guess_type(filename)[0] or "video/mp4"
    range_header = request.headers.get("Range")

    # ── No Range header → send full file (rare, but handle it) ──────────
    if not range_header:
        def full_iter():
            with open(file_path, "rb") as f:
                while chunk := f.read(VIDEO_CHUNK):
                    yield chunk

        return StreamingResponse(
            full_iter(),
            status_code=200,
            media_type=mime_type,
            headers={
                "Content-Length":      str(file_size),
                "Accept-Ranges":       "bytes",
                "Cache-Control":       "no-cache",
            }
        )

    # ── Parse Range: bytes=start-end ────────────────────────────────────
    try:
        range_val   = range_header.replace("bytes=", "")
        range_start, range_end = range_val.split("-")
        range_start = int(range_start)
        range_end   = int(range_end) if range_end else file_size - 1
    except Exception:
        raise HTTPException(status_code=416, detail="Invalid Range header")

    # Clamp to file bounds
    range_end  = min(range_end, file_size - 1)
    chunk_size = range_end - range_start + 1

    if range_start > range_end or range_start >= file_size:
        raise HTTPException(
            status_code=416,
            detail="Range Not Satisfiable",
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    def range_iter():
        remaining = chunk_size
        with open(file_path, "rb") as f:
            f.seek(range_start)
            while remaining > 0:
                data = f.read(min(VIDEO_CHUNK, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        range_iter(),
        status_code=206,
        media_type=mime_type,
        headers={
            "Content-Range":  f"bytes {range_start}-{range_end}/{file_size}",
            "Content-Length": str(chunk_size),
            "Accept-Ranges":  "bytes",
            "Cache-Control":  "no-cache",
        }
    )


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
    videos = scan_videos(VIDEO_PATHS, video_exts)

    media_cache = {"photos": photos, "music": music, "videos": videos}
    show_message(f"✅ Scan complete — {len(photos)} photos, {len(music)} tracks, {len(videos)} videos")


# =====================================================================
# ROUTES
# =====================================================================




import time

def _get_cache_bust() -> str:
    """In dev mode: timestamp changes every restart, busting the cache.
       In prod mode: use the fixed version string from config.json."""
    if config_data.get("dev", False):
        return str(int(time.time()))
    return config_data.get("version", "1.0.0")

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "v": _get_cache_bust()})


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
        
            await run_in_threadpool(update_photo_location_db, url, location_name)
            await run_in_threadpool(update_video_location_db, url, location_name)
            
            # Update the memory cache so the UI sees it immediately
            for media_type in ["photos", "videos"]:
                for item in media_cache.get(media_type, []):
                    if item["url"] == url:
                        item["location"] = location_name
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
        VIDEO_PATHS = list_video_paths(config_data.get("video", {}).get("folders", []))

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



    uvicorn.run(app, host="0.0.0.0", port=8000)