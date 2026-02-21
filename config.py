import json
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).resolve().parent

DEFAULT_CONFIG = {
    "mode": "photo",
    "music": {
        "play":       "auto",
        "volume":     65,
        "shuffle":    True,
        "folders":    ["./media/music"],
        "extensions": [".mp3"]
    },
    "photo": {
        "duration":   30,
        "shuffle":    True,
        "fit":        "cover",
        "folders":    ["./media/photos"],
        "extensions": [".jpg", ".jpeg", ".png", ".webp"]
    },
    "video": {
        "volume":     20,
        "shuffle":    True,
        "folders":    ["./media/videos"],
        "extensions": [".mp4", ".mov", ".avi"]
    }
}


def show_message(msg: str):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {msg}")


def load_config() -> dict:
    config_path = BASE_DIR / "config.json"
    show_message(f"DEBUG: Looking for config at: {config_path}")

    if not config_path.exists():
        show_message("⚠️ config.json NOT FOUND. Creating with defaults...")
        try:
            with open(config_path, "w") as f:
                json.dump(DEFAULT_CONFIG, f, indent=4)
        except Exception as e:
            show_message(f"!!! ERROR: Could not create config.json: {e}")
        return DEFAULT_CONFIG

    # --- ADD THIS BLOCK ---
    # Automatically create the default media folders for the user
    for category in ["photos", "music", "videos"]:
        media_path = BASE_DIR / "media" / category
        if not media_path.exists():
            media_path.mkdir(parents=True, exist_ok=True)
            show_message(f"📁 Created missing folder: {media_path}")
    # ----------------------

    try:
        with open(config_path, "r") as f:
            data = json.load(f)
        show_message("✅ config.json loaded successfully.")
        return data
    except Exception as e:
        show_message(f"!!! ERROR: Could not parse config.json: {e}")
        return DEFAULT_CONFIG


def save_config(new_config: dict):
    config_path = BASE_DIR / "config.json"
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(new_config, f, indent=4)
    show_message("✅ config.json saved.")