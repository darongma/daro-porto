from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from config import show_message


def mount_multiple(app: FastAPI, path_list: list, prefix: str) -> list[Path]:
    """
    Mounts each folder in path_list as a static route.
    Returns a list of valid resolved Path objects.
    e.g. /media/photos_0, /media/music_0, etc.
    """
    valid_paths = []
    for i, path_str in enumerate(path_list):
        p = Path(path_str).resolve()
        if p.exists():
            mount_point = f"/media/{prefix}_{i}"
            app.mount(mount_point, StaticFiles(directory=str(p)), name=f"{prefix}_{i}")
            valid_paths.append(p)
            show_message(f"✅ MOUNTED {prefix.upper()} [{i}]: {p} -> {mount_point}")
        else:
            show_message(f"⚠️ WARNING: Path not found, skipping: {p}")
    return valid_paths


def list_media_files(paths: list[Path], prefix: str, valid_ext: list[str]) -> list[str]:
    """
    Iterates mounted folders and returns a list of served URL strings
    for all files matching the given extensions.
    """
    found   = []
    ext_set = set(e.lower() for e in valid_ext)
    for i, folder in enumerate(paths):
        if not folder.exists():
            continue
        for f in folder.iterdir():
            if f.is_file() and f.suffix.lower() in ext_set:
                found.append(f"/media/{prefix}_{i}/{f.name}")
    return found


def get_size_format(b: int, factor: int = 1024, suffix: str = "B") -> str:
    """Converts bytes to a human-readable string (e.g. 1.25GB)."""
    for unit in ["", "K", "M", "G", "T", "P"]:
        if b < factor:
            return f"{b:.2f}{unit}{suffix}"
        b /= factor
    return f"{b:.2f}P{suffix}"


def get_folder_stats(paths: list[Path], valid_ext: list[str]) -> dict:
    """
    Returns total count, total size, and per-folder breakdown
    for a list of mounted paths.
    """
    ext_set     = set(e.lower() for e in valid_ext)
    total_count = 0
    total_bytes = 0
    detail_list = []

    for p in paths:
        if not p.exists():
            continue
        files   = [f for f in p.iterdir() if f.is_file() and f.suffix.lower() in ext_set]
        f_count = len(files)
        f_size  = sum(f.stat().st_size for f in files)
        total_count += f_count
        total_bytes += f_size
        detail_list.append({
            "path":  str(p),
            "count": f_count,
            "size":  get_size_format(f_size)
        })

    return {
        "total_count": total_count,
        "total_size":  get_size_format(total_bytes),
        "details":     detail_list,
        "formats":     sorted(list(ext_set))
    }