# 🖼️ Portal Photo Frame & Media Hub

Transform your Facebook Portal, tablet, or smart TV into a professional, location-aware digital photo frame and a full-featured music station.

## ✨ Core Features

### 📸 Smart Photo Frame
* **Auto-Geolocation:** The server reads GPS data from your photos and automatically looks up the address (e.g., "Nanshan District, Shenzhen" or "Santa Monica, California").
* **Smart Stacking:** Advanced logic ensures that even complex international addresses are formatted beautifully.
* **Photo Meta:** Automatically detects camera models, dates, and photo orientation.

### 🎵 Intelligent Music Player
* **Auto-Lyrics:** While a song plays, the server automatically searches the web to find and sync lyrics for your tracks.
* **Album Art extraction:** Automatically pulls artwork hidden inside your music files to display on your screen.
* **Full Media Info:** Reads ID3 tags to show Title, Artist, and Album info.

### 🗓️ Dashboard Widgets
* **Weather Forecast:** Stay updated with current weather conditions integrated into the frame.
* **Calendar:** A sleek digital calendar keeps you on track.
* **System Stats:** A built-in dashboard monitors your server's health (CPU/Memory usage).

---

## 🛠️ How to Install

### 1. Download the Project
Download this repository to your computer and open your terminal in the project folder.

### 2. Install the Requirements
You will need Python installed. Run this command to install the necessary "engines" for the server:
```bash
pip install fastapi uvicorn httpx mutagen pillow psutil jinja2


3. Add Your Media
Place your files in the following folders:

📷 Photos: /media/photos

🎵 Music: /media/music

🎥 Videos: /media/videos

🚀 How to Run
1. Launch the Server
In your terminal, run:

Bash
python main.py
2. Find Your Address
The terminal will display your Local IP address, which looks like this:
🚀 Server started at http://192.168.1.50:8000

3. Open on Your Device
Open the Browser app on your Facebook Portal, Tablet, or Phone.

Ensure your device is on the same Wi-Fi as your computer.

Type in the address shown in your terminal (e.g., http://192.168.1.50:8000).

📜 Privacy Note
This is a Local First application. Your personal photos and music are never uploaded to a cloud. Geolocation and Lyric lookups are done anonymously to protect your privacy.

⚖️ License
MIT License - Feel free to use and modify for your own personal home setup!