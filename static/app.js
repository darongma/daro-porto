// =============================================================================
// app.js — Global state, boot sequence, wake lock
// Depends on: weather.js, music.js, slideshow.js
// =============================================================================

// --- CONFIG & MEDIA ---
let cfg    = null;
let photos = [];
let music  = [];
let videos = [];

// --- LIVE STATE ---
let currentPhotoIndex = 0;
let currentMusicIndex = 0;
let currentVideoIndex = 0;
let slideshowTimer    = null;
let isRendering       = false;
const locationCache   = {};
const preloadCache    = {};
let wakeLock          = null;


// --- BOOT ---
document.addEventListener("DOMContentLoaded", async () => {
    await fetchMedia();
    startClock();
    initSplashLocation();
    window.addEventListener("resize", renderCurrentSlide);
});


async function fetchMedia() {
    try {
        const response = await fetch('/api/content');
        const data     = await response.json();

        cfg    = data.config;
        photos = cfg.photo.shuffle ? shuffle(data.photos) : data.photos;
        music  = cfg.music.shuffle ? shuffle(data.music)  : data.music;
        videos = cfg.video.shuffle ? shuffle(data.videos) : data.videos;

        // Pre-populate music metadata cache from server — no client-side tag scanning needed
        music.forEach(track => {
            trackMetaCache[track.url] = {
                title:    track.title,
                artist:   track.artist,
                album:    track.album,
                duration: track.duration,
                has_art:  track.has_art,
                art_url:  track.art_url,
            };
        });

        console.log(`--- Media Sync Report ---`);
        console.log(`Photos: ${photos.length} (Shuffle: ${cfg.photo.shuffle})`);
        console.log(`Music:  ${music.length}  (Shuffle: ${cfg.music.shuffle})`);
        console.log(`Videos: ${videos.length} (Shuffle: ${cfg.video.shuffle})`);
        console.log(`Mode:   ${cfg.mode}`);

    } catch (e) {
        console.error("Error fetching media:", e);
    }
}


async function startApp() {
    // 1. Fullscreen
    const elem = document.documentElement;
    try {
        if (elem.requestFullscreen)            await elem.requestFullscreen();
        else if (elem.webkitRequestFullscreen) await elem.webkitRequestFullscreen();
    } catch (err) {
        console.warn("Fullscreen blocked:", err);
    }

    // 2. Hide splash
    const splash = document.getElementById('splash-screen');
    if (splash) {
        splash.style.opacity = '0';
        setTimeout(() => { splash.style.display = 'none'; }, 1000);
    }

    // 3. Music
    if (cfg.music.play === "auto") {
        initMusic();
    } else {
        console.log("Music set to Manual/Off — preparing widget only.");
        loadMusicOnly();
    }

    // 4. Display mode
    switch (cfg.mode) {
        case "photo":  startSlideshow(); break;
        case "video":  initVideo();      break;
        case "hybrid": initVideo(); startSlideshow(); break;
        default:
            console.warn("Unknown mode, defaulting to photo.");
            startSlideshow();
    }

    startWeatherService();
    await requestWakeLock();
}


function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
}


// --- WAKE LOCK ---
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log("Screen wake lock active.");
        }
    } catch (err) {
        console.error(`${err.name}, ${err.message}`);
    }
}

document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});