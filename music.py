import json
import hashlib
from pathlib import Path
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC
from mutagen.easyid3 import EasyID3
from config import show_message


def extract_album_art(file: Path, art_dir: Path) -> str | None:
    """
    Extracts embedded album art from an audio file and saves it to art_dir.
    Uses MD5 hash of the image bytes as filename — identical art across
    an album shares a single file on disk, no duplication.
    Returns the served URL path (/music_art/<hash>.jpg) or None if no art.
    """
    try:
        id3 = ID3(file)
        for tag in id3.values():
            if isinstance(tag, APIC):
                img_hash = hashlib.md5(tag.data).hexdigest()
                ext      = "jpg" if "jpeg" in tag.mime.lower() else "png"
                filename = f"{img_hash}.{ext}"
                out_path = art_dir / filename
                if not out_path.exists():
                    out_path.write_bytes(tag.data)
                    show_message(f"🖼️  Art saved: {filename}")
                return f"/music_art/{filename}"
    except:
        pass
    return None


def get_audio_duration(path: Path) -> str:
    """Returns track duration as m:ss string."""
    try:
        audio   = MP3(path)
        total   = int(audio.info.length)
        m, s    = divmod(total, 60)
        return f"{m}:{s:02d}"
    except:
        return ""


def get_file_hash(path: Path) -> str:
    """Fast change-detection using file size + mtime. No content reading needed."""
    stat = path.stat()
    return f"{stat.st_size}_{stat.st_mtime}"


def read_tags(file: Path, art_dir: "Path | None" = None) -> dict:
    """
    Reads ID3 tags from an audio file.
    If art_dir is provided, extracts album art and saves it there.
    Returns title, artist, album, has_art, art_url.
    """
    meta = {
        "title":   None,
        "artist":  None,
        "album":   None,
        "has_art": False,
        "art_url": None,
    }
    try:
        tags           = EasyID3(file)
        meta["title"]  = tags.get("title",  [None])[0]
        meta["artist"] = tags.get("artist", [None])[0]
        meta["album"]  = tags.get("album",  [None])[0]
    except:
        pass
    try:
        id3             = ID3(file)
        has_art         = any(isinstance(t, APIC) for t in id3.values())
        meta["has_art"] = has_art
        if has_art and art_dir:
            meta["art_url"] = extract_album_art(file, art_dir)
    except:
        pass
    return meta


def scan_music_metadata(music_folders: list, cache_path: Path, extensions: list[str], art_dir: "Path | None" = None) -> dict:
    """
    Scans all music folders and extracts ID3 tags.
    Only processes files matching the extensions defined in config.
    If art_dir is provided, extracts and saves album art as image files.
    Loads existing cache and only re-processes new or changed files.
    Removes stale entries for files that no longer exist.
    Returns dict keyed by absolute file path string.
    """
    ext_set = set(e.lower() for e in extensions)
    if art_dir:
        art_dir.mkdir(parents=True, exist_ok=True)
    show_message(f"🎵 Scanning music with extensions: {ext_set}")

    # Load existing cache
    cache = {}
    if cache_path.exists():
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cache = json.load(f)
            show_message(f"📂 Music cache loaded: {len(cache)} tracks")
        except Exception as e:
            show_message(f"⚠️ Could not load music cache: {e}")
            cache = {}

    updated = False

    for folder_path in music_folders:
        folder = Path(folder_path).resolve()
        if not folder.exists():
            show_message(f"⚠️ Music folder not found, skipping: {folder}")
            continue

        for ext in ext_set:
            for file in folder.rglob(f"*{ext}"):
                key      = str(file)
                filehash = get_file_hash(file)

                # Skip if cached and file is unchanged
                if key in cache and cache[key].get("_hash") == filehash:
                    continue

                show_message(f"🎵 Indexing: {file.name}")
                tags = read_tags(file, art_dir=art_dir)

                cache[key] = {
                    "_hash":    filehash,
                    "path":     key,
                    "title":    tags["title"],
                    "artist":   tags["artist"],
                    "album":    tags["album"],
                    "duration": get_audio_duration(file),
                    "has_art":  tags["has_art"],
                    "art_url":  tags["art_url"],
                }
                updated = True

    # Remove stale entries for files that no longer exist
    missing = [k for k in cache if not Path(k).exists()]
    if missing:
        for k in missing:
            show_message(f"🗑️ Removing stale entry: {Path(k).name}")
            del cache[k]
        updated = True

    # Persist to disk if anything changed
    if updated:
        try:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False, indent=2)
            show_message(f"✅ Music metadata saved — {len(cache)} tracks indexed")
        except Exception as e:
            show_message(f"❌ Failed to save music cache: {e}")

    return cache


def get_track_meta(cache: dict, file_path: Path) -> dict:
    """Look up a single track's metadata from the cache by absolute file path."""
    return cache.get(str(file_path), {
        "title":    None,
        "artist":   None,
        "album":    None,
        "duration": "",
        "has_art":  False,
        "art_url":  None,
    })


def build_music_list(music_paths: list[Path], music_exts: list[str], cache: dict) -> list[dict]:
    """
    Builds the full music list with metadata attached, ready to serve to the frontend.
    Each item: { url, title, artist, album, duration, has_art }
    """
    ext_set    = set(e.lower() for e in music_exts)
    music_list = []

    for i, folder in enumerate(music_paths):
        if not folder.exists():
            continue
        for f in folder.iterdir():
            if not f.is_file() or f.suffix.lower() not in ext_set:
                continue
            url  = f"/media/music_{i}/{f.name}"
            meta = get_track_meta(cache, f)
            music_list.append({
                "url":      url,
                "title":    meta.get("title"),
                "artist":   meta.get("artist"),
                "album":    meta.get("album"),
                "duration": meta.get("duration", ""),
                "has_art":  meta.get("has_art", False),
                "art_url":  meta.get("art_url"),
            })

    return music_list