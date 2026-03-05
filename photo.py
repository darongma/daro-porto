import json
import sqlite3
from pathlib import Path
from datetime import datetime
from PIL import Image
from PIL.ExifTags import TAGS
from config import show_message

DB_PATH = Path(__file__).parent / "photo.db"

def init_photo_db():
    """Initializes the photo table in SQLite."""
    with sqlite3.connect(DB_PATH, timeout=10) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS photos (
                filepath TEXT PRIMARY KEY,
                url TEXT,
                date TEXT,
                lat REAL,
                lon REAL,
                alt REAL,
                width INTEGER,
                height INTEGER,
                device TEXT,
                orientation TEXT,
                location TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_url ON photos(url)")

def get_decimal_from_exif(rational_triple, ref) -> float | None:
    try:
        d = float(rational_triple[0])
        m = float(rational_triple[1])
        s = float(rational_triple[2])
        decimal = d + (m / 60.0) + (s / 3600.0)
        if ref in ['S', 'W']: decimal = -decimal
        return decimal
    except: return None

def get_photo_metadata(file_path: Path) -> dict:
    photo_date = datetime.fromtimestamp(file_path.stat().st_mtime).strftime('%Y:%m:%d %H:%M:%S')
    lat, lon, alt = None, None, None
    device = "Unknown Device"
    orientation = "landscape"
    w, h = 0, 0

    try:
        with Image.open(file_path) as img:
            w, h = img.size
            exif = img._getexif()
            is_portrait = h > w
            if exif:
                for tag, value in exif.items():
                    decoded = TAGS.get(tag, tag)
                    if decoded == 'Orientation':
                        if value in [5, 6, 7, 8]: is_portrait = w > h
                    elif decoded == 'DateTimeOriginal': photo_date = value
                    elif decoded == 'Model': device = value
                    elif decoded == 'GPSInfo':
                        lat = get_decimal_from_exif(value.get(2), value.get(1))
                        lon = get_decimal_from_exif(value.get(4), value.get(3))
                        if value.get(6) is not None:
                            try:
                                alt = float(value.get(6))
                                if value.get(5) == 1: alt = -alt
                            except: pass
            orientation = "portrait" if is_portrait else "landscape"
    except Exception as e:
        show_message(f"⚠️ Error reading EXIF for {file_path.name}: {e}")

    return {
        "date": photo_date, "lat": lat, "lon": lon, "alt": alt,
        "width": w, "height": h, "device": device, "orientation": orientation
    }

def scan_photos(photo_paths: list[Path], photo_exts: set) -> list[dict]:

    ext_set = set(e.lower() for e in photo_exts)
    
    existing_data = {}
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute("SELECT * FROM photos")
        for row in cursor:
            existing_data[row["filepath"]] = dict(row)

    final_photos = []
    to_insert = []
    to_update_url = []

    for i, folder in enumerate(photo_paths):
        if not folder.exists(): continue
        for f in folder.iterdir():
            if not f.is_file() or f.suffix.lower() not in ext_set: continue

            abs_path = str(f.absolute())
            current_url = f"/media/photos_{i}/{f.name}"

            if abs_path in existing_data:
                photo_obj = existing_data[abs_path]
                if photo_obj["url"] != current_url:
                    photo_obj["url"] = current_url
                    to_update_url.append((current_url, abs_path))
                final_photos.append(photo_obj)
            else:
                meta = get_photo_metadata(f)
                photo_obj = {
                    "filepath": abs_path, "url": current_url, "location": None, **meta
                }
                # Safer: Explicitly map keys to match DB column order
                to_insert.append((
                    photo_obj['filepath'], photo_obj['url'], photo_obj['date'],
                    photo_obj['lat'], photo_obj['lon'], photo_obj['alt'],
                    photo_obj['width'], photo_obj['height'], photo_obj['device'],
                    photo_obj['orientation'], photo_obj['location']
                ))
                final_photos.append(photo_obj)
                show_message(f"📸 New photo: {f.name}")

    with sqlite3.connect(DB_PATH) as conn:
        if to_insert:
            conn.executemany("INSERT INTO photos VALUES (?,?,?,?,?,?,?,?,?,?,?)", to_insert)
        if to_update_url:
            conn.executemany("UPDATE photos SET url = ? WHERE filepath = ?", to_update_url)
            
    return final_photos

def update_photo_location_db(url: str, location: str) -> bool:
    """The helper for main.py to call via threadpool"""
    try:
        with sqlite3.connect(DB_PATH, timeout=10) as conn:
            cursor = conn.execute("UPDATE photos SET location = ? WHERE url = ?", (location, url))
            return cursor.rowcount > 0
    except Exception as e:
        show_message(f"❌ DB Update Error: {e}")
        return False
    


def print_photos_with_location():
    
    """Prints all photo entries that have a location assigned."""
    if not DB_PATH.exists():
        print(f"❌ Error: {DB_PATH} not found.")
        return

    try:
        with sqlite3.connect(DB_PATH) as conn:
            # We filter for rows where location is NOT NULL and not an empty string
            query = """
                SELECT filepath, location, lat, lon 
                FROM photos 
                WHERE location IS NOT NULL AND location != ''
            """
            cursor = conn.execute(query)
            rows = cursor.fetchall()

            if not rows:
                print("📂 No photos have locations set yet.")
                return

            print(f"{'FILENAME':<30} | {'LOCATION':<40} | {'COORDS'}")
            print("-" * 90)

            # enumerate(rows, 1) starts the counter at 1
            for index, (path, loc, lat, lon) in enumerate(rows, 1):
                filename = Path(path).name
                coords = f"{lat}, {lon}"
                
                # Print row with index
                print(f"{index:<4} | {filename[:30]:<30} | {loc[:40]:<40} | {coords}")

            print("-" * 90)
            print(f"Total photos with locations: {len(rows)}")

    except sqlite3.Error as e:
        print(f"❌ SQLite Error: {e}")