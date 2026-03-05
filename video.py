import sqlite3
import re
from pathlib import Path
from datetime import datetime
from config import show_message

DB_PATH = Path(__file__).parent / "video.db"

def init_video_db():
    with sqlite3.connect(DB_PATH, timeout=10) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS videos (
                filepath TEXT PRIMARY KEY,
                url TEXT,
                date TEXT,
                lat REAL,
                lon REAL,
                width INTEGER,
                height INTEGER,
                duration REAL,
                device TEXT,
                location TEXT
            )
        """)


# =============================================================================
# TIER 1: ExifTool — deepest metadata, GPS, all tags. Requires user install.
# =============================================================================

def _extract_with_exiftool(file_path: Path) -> dict | None:
    """Returns a partial metadata dict, or None if exiftool is unavailable."""
    try:
        import exiftool
        exiftool_path = r"C:\exiftool-13.51_64\exiftool(-k).exe"

        with exiftool.ExifToolHelper(executable=exiftool_path) as et:
            meta = et.get_metadata(str(file_path))[0]

        w        = meta.get('QuickTime:ImageWidth')  or meta.get('SourceImageWidth')  or 0
        h        = meta.get('QuickTime:ImageHeight') or meta.get('SourceImageHeight') or 0
        duration = meta.get('QuickTime:Duration') or 0.0
        lat, lon = None, None
        device   = ""

        raw_date = meta.get('QuickTime:CreationDate') or meta.get('QuickTime:CreateDate')
        date     = str(raw_date)[:19].replace('-', ':') if raw_date else None

        gps = meta.get('QuickTime:GPSCoordinates') or meta.get('Composite:GPSPosition')
        if gps:
            match = re.findall(r'[+-]?\d+\.?\d*', str(gps))
            if len(match) >= 2:
                lat, lon = float(match[0]), float(match[1])

        found_make, found_model = "", ""
        for tag, value in meta.items():
            tag_lower = tag.lower()
            val_str   = str(value).strip()
            if "make" in tag_lower or "manufacturer" in tag_lower:
                found_make = val_str
            if "model" in tag_lower and val_str.lower() not in ["android", "iphone", "unknown", ""]:
                found_model = val_str

        if found_model:
            device = f"{found_make} {found_model}" if found_make and found_make.lower() not in found_model.lower() else found_model

        return {"date": date, "lat": lat, "lon": lon,
                "width": w, "height": h, "duration": duration, "device": device}

    except Exception as e:
        print(f"⚠️  ExifTool unavailable or errored for {file_path.name}: {e}")
        return None


# =============================================================================
# TIER 2: pymediainfo — pure pip, no extra downloads, bundled libmediainfo.
#          Extracts dimensions, duration, recorded date, and device make/model
#          from container atoms (works well with .mp4 / .mov from phones).
#          GPS is rarely stored in a MediaInfo-readable atom, so we skip it here
#          rather than guess.
# =============================================================================

def _extract_with_mediainfo(file_path: Path) -> dict | None:
    """Returns a partial metadata dict, or None if pymediainfo is unavailable."""
    try:
        from pymediainfo import MediaInfo

        info    = MediaInfo.parse(str(file_path))
        general = next((t for t in info.tracks if t.track_type == 'General'), None)
        video   = next((t for t in info.tracks if t.track_type == 'Video'),   None)

        if not general and not video:
            return None

        # --- Dimensions & duration ---
        w        = int(video.width)    if video and video.width    else 0
        h        = int(video.height)   if video and video.height   else 0
        # duration from MediaInfo is in milliseconds
        duration = (general.duration / 1000.0) if general and general.duration else 0.0

        # --- Date ---
        # MediaInfo exposes recorded_date or encoded_date on the General track.
        # Formats seen: "UTC 2022-11-04 18:32:10", "2022-11-04T18:32:10+0000"
        date = None
        raw  = getattr(general, 'recorded_date', None) or getattr(general, 'encoded_date', None)
        if raw:
            raw = str(raw).strip()
            # Strip timezone prefix like "UTC " or "UTC+0000"
            raw = re.sub(r'^UTC\s*', '', raw).strip()
            # Normalise separators to match the rest of the codebase: YYYY:MM:DD HH:MM:SS
            raw = raw[:19].replace('T', ' ').replace('-', ':')
            if re.match(r'\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}', raw):
                date = raw

        # --- Device (make / model stored in com.apple.quicktime.* or XMP atoms) ---
        device     = ""
        make_val   = (getattr(general, 'com_apple_quicktime_make',  None) or
                      getattr(general, 'make',                       None) or
                      getattr(general, 'manufacturer',               None) or "")
        model_val  = (getattr(general, 'com_apple_quicktime_model', None) or
                      getattr(general, 'model',                      None) or "")

        make_val  = str(make_val).strip()
        model_val = str(model_val).strip()

        # Ignore generic/useless values
        if model_val and model_val.lower() not in ["android", "iphone", "unknown", ""]:
            device = f"{make_val} {model_val}".strip() if make_val and make_val.lower() not in model_val.lower() else model_val
        elif make_val and make_val.lower() not in ["unknown", ""]:
            device = make_val

        return {"date": date, "lat": None, "lon": None,
                "width": w, "height": h, "duration": duration, "device": device}

    except ImportError:
        print(f"⚠️  pymediainfo not installed — skipping tier 2 for {file_path.name}")
        return None
    except Exception as e:
        print(f"⚠️  pymediainfo error for {file_path.name}: {e}")
        return None


# =============================================================================
# TIER 3: Smart path / filename inference — no packages needed, always works.
# =============================================================================

def _infer_device_from_path(file_path: Path) -> str:
    folder_name = file_path.parent.name
    file_name   = file_path.name.upper()

    if "PIXEL" in folder_name.upper():
        clean_name = re.sub(r'(?i)\s*\d+GB.*$', '', folder_name).strip()
        return f"Google {clean_name}" if "Google" not in clean_name else clean_name
    if "IPHONE" in folder_name.upper():
        clean_name = re.sub(r'(?i)\s*\d+GB.*$', '', folder_name).strip()
        return clean_name if clean_name else "Apple iPhone"
    if file_name.startswith("PXL_"):
        return "Google Pixel"
    if file_name.startswith("IMG_") and file_path.suffix.lower() == ".mov":
        return "Apple iPhone"
    return "Android/Generic"


# =============================================================================
# MAIN ENTRY POINT — merges all three tiers
# =============================================================================

def get_video_metadata(file_path: Path) -> dict:
    """
    Three-tier metadata extraction:
      1. ExifTool    — richest (GPS, all atoms). Requires user install.
      2. pymediainfo — good (dimensions, date, device). Pure pip, no extra download.
      3. Path/name   — last resort device guess from folder & filename conventions.

    Each tier fills in only what the previous tier missed, so a partial ExifTool
    result (e.g. no device tag) is topped up by pymediainfo before path inference.
    """
    # Base defaults
    fallback_date = datetime.fromtimestamp(file_path.stat().st_mtime).strftime('%Y:%m:%d %H:%M:%S')
    result = {"date": fallback_date, "lat": None, "lon": None,
              "width": 0, "height": 0, "duration": 0.0, "device": ""}

    # --- Tier 1: ExifTool ---
    exif = _extract_with_exiftool(file_path)
    if exif:
        # Merge — only overwrite if exiftool gave us something useful
        if exif.get("date"):           result["date"]     = exif["date"]
        if exif.get("lat") is not None: result["lat"]     = exif["lat"]
        if exif.get("lon") is not None: result["lon"]     = exif["lon"]
        if exif.get("width"):          result["width"]    = exif["width"]
        if exif.get("height"):         result["height"]   = exif["height"]
        if exif.get("duration"):       result["duration"] = exif["duration"]
        if exif.get("device"):         result["device"]   = exif["device"]

    # --- Tier 2: pymediainfo (fill gaps exiftool missed or exiftool wasn't available) ---
    still_missing = not result["width"] or not result["device"] or not result["date"] or result["date"] == fallback_date
    if still_missing:
        mi = _extract_with_mediainfo(file_path)
        if mi:
            if not result["width"]  and mi.get("width"):    result["width"]    = mi["width"]
            if not result["height"] and mi.get("height"):   result["height"]   = mi["height"]
            if not result["duration"] and mi.get("duration"): result["duration"] = mi["duration"]
            if (not result["device"] or result["device"] in ["Android", "iPhone"]) and mi.get("device"):
                result["device"] = mi["device"]
            if result["date"] == fallback_date and mi.get("date"):
                result["date"] = mi["date"]

    # --- Tier 3: path inference (device only, last resort) ---
    if not result["device"] or result["device"] in ["Android", "iPhone"]:
        result["device"] = _infer_device_from_path(file_path)

    return result


def scan_videos(video_paths: list[Path], video_exts: set) -> list[dict]:
    """Scans folders for videos and updates the SQLite database."""
    ext_set = set(e.lower() for e in video_exts)
    existing_data = {}
    
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute("SELECT * FROM videos")
        for row in cursor:
            existing_data[row["filepath"]] = dict(row)

    final_videos = []
    to_insert    = []
    to_update_url = []

    for i, folder in enumerate(video_paths):
        if not folder.exists(): continue
        for f in folder.iterdir():
            if not f.is_file() or f.suffix.lower() not in ext_set: continue

            abs_path    = str(f.absolute())
            current_url = f"/media/videos_{i}/{f.name}"

            if abs_path in existing_data:
                video_obj = existing_data[abs_path]
                if video_obj["url"] != current_url:
                    video_obj["url"] = current_url
                    to_update_url.append((current_url, abs_path))
                final_videos.append(video_obj)
            else:
                meta      = get_video_metadata(f)
                video_obj = {"filepath": abs_path, "url": current_url, "location": None, **meta}
                to_insert.append((
                    video_obj['filepath'], video_obj['url'], video_obj['date'],
                    video_obj['lat'],      video_obj['lon'], video_obj['width'],
                    video_obj['height'],   video_obj['duration'], video_obj['device'],
                    video_obj['location']
                ))
                final_videos.append(video_obj)
                show_message(f"📹 Scanned Video: {f.name}")

    with sqlite3.connect(DB_PATH) as conn:
        if to_insert:
            conn.executemany("INSERT INTO videos VALUES (?,?,?,?,?,?,?,?,?,?)", to_insert)
        if to_update_url:
            conn.executemany("UPDATE videos SET url = ? WHERE filepath = ?", to_update_url)
            
    return final_videos


def update_video_location_db(url: str, location: str) -> bool:
    """Updates the readable location name (e.g. 'Los Angeles, CA') in the DB."""
    try:
        with sqlite3.connect(DB_PATH, timeout=10) as conn:
            cursor = conn.execute("UPDATE videos SET location = ? WHERE url = ?", (location, url))
            return cursor.rowcount > 0
    except Exception as e:
        show_message(f"❌ Video DB Update Error: {e}")
        return False


def print_all_video_entries():
    """Prints every column for every entry in the video database."""
    if not DB_PATH.exists():
        print(f"❌ Error: {DB_PATH} not found.")
        return

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT * FROM videos")
            rows   = cursor.fetchall()

            if not rows:
                print("📂 Database is empty. Run a scan first.")
                return

            header = (
                f"{'#':<3} | {'FILENAME':<20} | {'DATE':<19} | "
                f"{'LAT/LON':<20} | {'DIMENSIONS':<12} | {'DUR':<6} | {'DEVICE':<15} | {'LOCATION'}"
            )
            print("\n" + header)
            print("-" * 150)

            for index, row in enumerate(rows, 1):
                filename = Path(row['filepath']).name
                coords   = f"{row['lat']:.4f}, {row['lon']:.4f}" if row['lat'] is not None else "No GPS"
                dims     = f"{row['width']}x{row['height']}"
                dur_sec  = row['duration'] or 0
                duration = f"{int(dur_sec // 60)}:{int(dur_sec % 60):02d}"
                device   = (row['device'][:15]   if row['device']   else "Unknown")
                loc      = (row['location'][:25] if row['location'] else "None")

                print(
                    f"{index:<3} | {filename[:20]:<20} | {row['date']:<19} | "
                    f"{coords:<20} | {dims:<12} | {duration:<6} | {device:<15} | {loc}"
                )

            print("-" * 150)
            print(f"Total entries in video.db: {len(rows)}\n")

    except sqlite3.Error as e:
        print(f"❌ SQLite Error: {e}")