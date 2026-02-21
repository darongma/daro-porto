// =============================================================================
// music.js — Music player, lyrics, playlist
// No longer depends on jsmediatags — all metadata comes from the server.
// Album art is served as a static file URL from /music_art/
// =============================================================================

// --- MUSIC STATE ---
let musicAudio      = null;
let isShuffled      = false;
let repeatMode      = 0;         // 0=off, 1=all, 2=one
let currentLyrics   = [];        // [{time: seconds, text: string}]
let isMusicExpanded = false;
let isLyricsOpen    = true;
let isPlaylistOpen  = true;

// Populated by fetchMedia() in app.js from /api/content
// { [url]: { title, artist, album, duration, has_art, art_url } }
const trackMetaCache = {};


/* ============================================================
   WIDGET TOGGLE
   ============================================================ */

function toggleMusicWidget(e) {
    isMusicExpanded = !isMusicExpanded;
    const panel = document.getElementById('music-expanded');
    const arrow = document.getElementById('music-expand-arrow');
    panel.classList.toggle('music-expanded--visible', isMusicExpanded);
    arrow.classList.toggle('music-expand-hint--open', isMusicExpanded);
}

function toggleMusicSection(section) {
    const body  = document.getElementById(`section-${section}`);
    const arrow = document.getElementById(`arrow-${section}`);
    const isOpen = body.classList.toggle('music-section-body--open');
    arrow.classList.toggle('music-section-arrow--open', isOpen);
    if (section === 'lyrics')   isLyricsOpen   = isOpen;
    if (section === 'playlist') isPlaylistOpen = isOpen;
}


/* ============================================================
   PLAYBACK CONTROLS
   ============================================================ */

function togglePlayPause() {
    if (!musicAudio) return;
    if (musicAudio.paused) {
        musicAudio.play();
        document.querySelector('#btn-play-pause i').className = 'fas fa-pause';
    } else {
        musicAudio.pause();
        document.querySelector('#btn-play-pause i').className = 'fas fa-play';
    }
}

function playNext() {
    if (!music.length) return;
    currentMusicIndex = (currentMusicIndex + 1) % music.length;
    loadAndPlayTrack(currentMusicIndex);
}

function playPrevious() {
    if (!musicAudio) return;
    if (musicAudio.currentTime > 3) {
        musicAudio.currentTime = 0;
    } else {
        currentMusicIndex = (currentMusicIndex - 1 + music.length) % music.length;
        loadAndPlayTrack(currentMusicIndex);
    }
}

function playFromPlaylist(index) {
    currentMusicIndex = index;
    loadAndPlayTrack(index);
    setTimeout(() => scrollPlaylistToActive(), 300);
}

function toggleShuffle() {
    isShuffled = !isShuffled;
    document.getElementById('btn-shuffle').classList.toggle('mc-btn--active', isShuffled);
    if (isShuffled) music = shuffle([...music]);
}

function cycleRepeat() {
    repeatMode = (repeatMode + 1) % 3;
    const btn  = document.getElementById('btn-repeat');
    const icon = btn.querySelector('i');
    btn.classList.toggle('mc-btn--active', repeatMode > 0);
    icon.className = 'fas fa-repeat';
    btn.title      = ['Repeat Off', 'Repeat All', 'Repeat One'][repeatMode];
    btn.setAttribute('data-repeat', repeatMode === 2 ? '1' : '');
}

function seekTo(value) {
    if (musicAudio) musicAudio.currentTime = parseFloat(value);
}

function setVolume(value) {
    if (musicAudio) musicAudio.volume = value / 100;
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}


/* ============================================================
   PROGRESS TRACKER
   ============================================================ */

function startProgressTracker() {
    if (!musicAudio) return;
    musicAudio.addEventListener('timeupdate', () => {
        const cur  = musicAudio.currentTime;
        const dur  = musicAudio.duration || 0;
        const seek = document.getElementById('music-seek');
        if (seek) { seek.max = Math.floor(dur); seek.value = Math.floor(cur); }
        const ct = document.getElementById('music-current-time');
        const dt = document.getElementById('music-duration');
        if (ct) ct.textContent = formatTime(cur);
        if (dt) dt.textContent = formatTime(dur);
        scrollLyrics(cur);
    });
}


/* ============================================================
   LYRICS  (parsed from embedded LRC/SYLT in MP3 via fetch)
   Note: jsmediatags is gone. Lyrics are fetched directly by
   reading the binary ID3 tags via a lightweight fetch+ArrayBuffer
   approach only for the USLT/SYLT frames we care about.
   For most users with no embedded lyrics, this shows the
   placeholder gracefully.
   ============================================================ */


async function fetchLyricsFromTrack(trackUrl) {
    const el = document.getElementById('music-lyrics');
    if (el) el.innerHTML = `<span class="lyrics-placeholder">🔍 Checking file for lyrics...</span>`;
    
    currentLyrics = []; // Reset global state

    try {
        // --- TIER 1: Check Embedded ID3 Tags ---
        // Using your existing ArrayBuffer range request
        const res = await fetch(trackUrl, { headers: { Range: 'bytes=0-131072' } });
        const buffer = await res.arrayBuffer();
        const view = new DataView(buffer);
        const embeddedParsed = parseID3Lyrics(view, buffer);

        if (embeddedParsed && embeddedParsed.length > 0) {
            console.log("✅ Found embedded lyrics in ID3 tag.");
            currentLyrics = embeddedParsed;
        } else {
            // --- TIER 2: Fallback to Backend Waterfall ---
            if (el) el.innerHTML = `<span class="lyrics-placeholder">🌐 Searching online...</span>`;
            await fetchLyricsFromBackend(trackUrl);
        }
    } catch (e) {
        console.log('Error in initial check, trying backend:', e.message);
        await fetchLyricsFromBackend(trackUrl);
    }

    renderLyrics();
}

async function fetchLyricsFromBackend(trackUrl) {
    try {
        const meta = trackMetaCache[trackUrl] || {};
        const artist = meta.artist || 'Unknown Artist';
        const title = meta.title || '';
        const fileName = trackUrl.split(/[/\\]/).pop().replace(/\.[^/.]+$/, "");

        const query = new URLSearchParams({
            artist: artist,
            title: title,
            name: fileName
        });

        const res = await fetch(`/api/lyrics?${query.toString()}`);
        const data = await res.json();

        if (data.type === 'synced') {
            currentLyrics = parseLRC(data.lyrics);
        } else if (data.type === 'static') {
            // Format static text for your existing renderer
            currentLyrics = data.lyrics.split('\n')
                .map(t => t.trim())
                .filter(Boolean)
                .map(text => ({ time: -1, text }));
        }
    } catch (e) {
        console.error('Backend fallback failed:', e);
    }
}


function parseID3Lyrics(view, buffer) {
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return [];

    const version = view.getUint8(3);
    const tagSize = ((view.getUint8(6) & 0x7f) << 21) | ((view.getUint8(7) & 0x7f) << 14) |
                    ((view.getUint8(8) & 0x7f) << 7)  | (view.getUint8(9) & 0x7f);
    let offset = 10;

    while (offset < tagSize + 10) {
        if (offset + 10 > buffer.byteLength) break;

        const frameId = String.fromCharCode(
            view.getUint8(offset), view.getUint8(offset+1),
            view.getUint8(offset+2), view.getUint8(offset+3)
        );
        
        if (frameId === '\0\0\0\0') break;

        // Frame size calculation (Syncsafe for v4)
        const frameSize = version === 4
            ? ((view.getUint8(offset+4) & 0x7f) << 21) | ((view.getUint8(offset+5) & 0x7f) << 14) |
              ((view.getUint8(offset+6) & 0x7f) << 7)  | (view.getUint8(9) & 0x7f)
            : view.getUint32(offset + 4); // v3 uses standard Uint32

        const dataStart = offset + 10;
        const dataEnd = dataStart + frameSize;

        if (frameId === 'USLT') {
            const encoding = view.getUint8(dataStart);
            // Skip encoding (1) and Language (3) = 4 bytes
            let lyricsData = new Uint8Array(buffer.slice(dataStart + 4, dataEnd));
            
            let text = "";
            if (encoding === 1 || encoding === 2) { // UTF-16
                // Find the null terminator for the descriptor (\0\0 in UTF-16)
                let descriptorEnd = 0;
                for (let i = 0; i < lyricsData.length; i += 2) {
                    if (lyricsData[i] === 0 && lyricsData[i+1] === 0) {
                        descriptorEnd = i + 2;
                        break;
                    }
                }
                text = new TextDecoder('utf-16').decode(lyricsData.slice(descriptorEnd));
            } else { // UTF-8 or ISO-8859-1
                // Find single null terminator for descriptor
                let descriptorEnd = lyricsData.indexOf(0) + 1;
                text = new TextDecoder(encoding === 3 ? 'utf-8' : 'iso-8859-1').decode(lyricsData.slice(descriptorEnd));
            }

            const lrc = parseLRC(text);
            return lrc.length ? lrc : text.split('\n').map(t => ({ time: -1, text: t.trim() })).filter(o => o.text);
        }

        offset = dataEnd;
        if (frameSize <= 0) break;
    }
    return [];
}

function parseLRC(raw) {
    const lines = [];
    const tagRegex = /\[(\d{2,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
    const offsetRegex = /^\[offset:\s*(-?\d+)\]/i;
    
    let offset = 0;
    const rawLines = raw.split(/\r?\n/);

    // 1. Check for global offset (shifting the whole song)
    for (let line of rawLines) {
        const offsetMatch = line.match(offsetRegex);
        if (offsetMatch) {
            offset = parseInt(offsetMatch[1]) / 1000; // convert ms to seconds
            break;
        }
    }

    for (let line of rawLines) {
        const timeTags = [];
        let match;
        
        // 2. Extract all timestamps on this line
        while ((match = tagRegex.exec(line)) !== null) {
            const mins = parseInt(match[1]);
            const secs = parseInt(match[2]);
            let ms = 0;
            
            if (match[3]) {
                // Handle .1, .12, and .123 correctly
                const msStr = match[3];
                ms = parseInt(msStr) / Math.pow(10, msStr.length);
            }
            
            timeTags.push(mins * 60 + secs + ms + offset);
        }

        // 3. Extract text (remove everything inside brackets)
        const text = line.replace(/\[.*?\]/g, '').trim();

        if (text && timeTags.length > 0) {
            for (let time of timeTags) {
                // Ensure we don't have negative time after offset
                lines.push({ time: Math.max(0, time), text });
            }
        }
    }

    // 4. Sort and filter out empty text
    return lines.sort((a, b) => a.time - b.time);
}

function renderLyrics() {
    const el = document.getElementById('music-lyrics');
    if (!el) return;
    if (!currentLyrics.length) {
        el.innerHTML = `<span class="lyrics-placeholder">♪ No lyrics available</span>`;
        return;
    }
    const isTimed = currentLyrics[0].time >= 0;
    el.innerHTML  = currentLyrics.map((l, i) =>
        `<div class="lyric-line ${isTimed ? 'lyric-timed' : ''}" data-idx="${i}">${l.text}</div>`
    ).join('');
}

function scrollLyrics(currentTime) {
    if (!currentLyrics.length || currentLyrics[0].time < 0) return;
    let activeIdx = 0;
    for (let i = 0; i < currentLyrics.length; i++) {
        if (currentLyrics[i].time <= currentTime) activeIdx = i;
        else break;
    }
    const el    = document.getElementById('music-lyrics');
    const lines = el?.querySelectorAll('.lyric-line');
    if (!lines) return;
    lines.forEach((l, i) => l.classList.toggle('lyric-active', i === activeIdx));
    const active = lines[activeIdx];
    if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
}


/* ============================================================
   ALBUM ART (served from /music_art/ by the server)
   ============================================================ */

function applyAlbumArt(trackUrl) {
    const albumArtEl  = document.getElementById('music-album-art');
    const defaultIcon = document.getElementById('music-default-icon');
    const meta        = trackMetaCache[trackUrl];

    if (meta?.art_url) {
        // 1. Set the source
        albumArtEl.src = meta.art_url;
        
        // 2. Wait for the load event to ensure pixels are ready
        albumArtEl.onload = () => {
            updateVisualizerColor();
        };

        albumArtEl.style.display  = 'block';
        defaultIcon.style.display = 'none';
    } else {
        albumArtEl.style.display  = 'none';
        defaultIcon.style.display = 'block';
        
        // 3. Optional: Reset to default color if no art exists
        const visualizerSpans = document.querySelectorAll('.music-visualizer span');
        visualizerSpans.forEach(span => {
            span.style.background = '#1db954'; // Or your default theme color
            span.style.boxShadow = 'none';
        });
    }
}


/* ============================================================
   METADATA DISPLAY
   ============================================================ */

function applyTrackMeta(trackUrl) {
    const meta     = trackMetaCache[trackUrl];
    const filename = decodeURIComponent(trackUrl.split('/').pop().replace(/\.[^/.]+$/, ''));

    document.getElementById('song-title').innerText  = meta?.title  || filename;
    document.getElementById('song-artist').innerText = meta?.artist || 'Unknown Artist';
    document.getElementById('song-album').innerText  = meta?.album  || '';
    checkMarquee(['song-title', 'song-artist', 'song-album']);
}


/* ============================================================
   INIT
   ============================================================ */

function initMusic() {
    if (!music.length) { console.log("❌ No music found."); return; }

    musicAudio        = new Audio();
    musicAudio.volume = (cfg.music.volume || 50) / 100;
    const volSlider   = document.getElementById('music-volume');
    if (volSlider) volSlider.value = cfg.music.volume || 50;

    musicAudio.addEventListener('ended', () => {
        if (repeatMode === 2) {
            musicAudio.currentTime = 0;
            musicAudio.play();
        } else {
            playNext();
        }
    });

    // Whenever the audio starts playing (no matter who triggered it)
musicAudio.addEventListener('play', () => {
    updateVisualizer(true);
    //document.querySelector('#btn-play-pause i').className = 'fas fa-pause';
});

// Whenever the audio pauses
musicAudio.addEventListener('pause', () => {
    updateVisualizer(false);
    //document.querySelector('#btn-play-pause i').className = 'fas fa-play';
});

    startProgressTracker();
    renderPlaylist();
    loadAndPlayTrack(currentMusicIndex);

    // Open both sections by default
    toggleMusicSection('lyrics');
    toggleMusicSection('playlist');
}

function loadMusicOnly() {
    if (!music.length) return;

    musicAudio        = new Audio();
    musicAudio.volume = (cfg.music.volume || 50) / 100;
    const volSlider   = document.getElementById('music-volume');
    if (volSlider) volSlider.value = cfg.music.volume || 50;
    startProgressTracker();

    const track    = music[currentMusicIndex];
    const trackUrl = track.url;

    musicAudio.src = trackUrl;
    document.getElementById('music-info').classList.add('show');
    document.querySelector('#btn-play-pause i').className = 'fas fa-play';

    applyTrackMeta(trackUrl);
    applyAlbumArt(trackUrl);
    fetchLyricsFromTrack(trackUrl);
    renderPlaylist();

    toggleMusicSection('lyrics');
    toggleMusicSection('playlist');
}

function loadAndPlayTrack(index) {
    const track    = music[index];
    const trackUrl = track.url;

    musicAudio.src = trackUrl;
    musicAudio.play().catch(() => console.log("🔈 Autoplay blocked."));

    document.querySelector('#btn-play-pause i').className = 'fas fa-pause';
    document.getElementById('song-title').innerText       = 'Loading...';
    document.getElementById('song-artist').innerText      = '';
    document.getElementById('song-album').innerText       = '';
    document.getElementById('music-info').classList.add('show');

    currentLyrics = [];
    renderLyrics();

    // Apply metadata + art immediately from cache (no waiting)
    applyTrackMeta(trackUrl);
    applyAlbumArt(trackUrl);

    // Fetch lyrics from the audio file in the background
    fetchLyricsFromTrack(trackUrl);

    // Update playlist highlight
    updatePlaylistHighlight();
}


/* ============================================================
   PLAYLIST
   ============================================================ */

function renderPlaylist() {
    const list  = document.getElementById('playlist-list');
    const count = document.getElementById('playlist-count');
    if (!list) return;

    if (count) count.textContent = `(${music.length})`;

    list.innerHTML = music.map((track, i) => {
        const meta     = trackMetaCache[track.url] || {};
        const title    = meta.title    || decodeURIComponent(track.url.split('/').pop().replace(/\.[^/.]+$/, ''));
        const artist   = meta.artist   || '';
        const duration = meta.duration || '';
        const isActive = i === currentMusicIndex;
        return `
            <div class="playlist-item ${isActive ? 'playlist-item--active' : ''}"
                 data-idx="${i}" onclick="playFromPlaylist(${i})">
                <div class="playlist-item-num">
                    ${isActive
                        ? '<i class="fas fa-volume-high playlist-playing-icon"></i>'
                        : `<span class="playlist-num">${i + 1}</span>`}
                </div>
                <div class="playlist-item-info">
                    <span class="playlist-item-title">${title}</span>
                    ${artist ? `<span class="playlist-item-artist">${artist}</span>` : ''}
                </div>
                <span class="playlist-item-duration">${duration}</span>
            </div>`;
    }).join('');
}

function filterPlaylist(query) {
    const q     = query.toLowerCase();
    const items = document.querySelectorAll('.playlist-item');
    items.forEach(item => {
        const title  = item.querySelector('.playlist-item-title')?.textContent.toLowerCase()  || '';
        const artist = item.querySelector('.playlist-item-artist')?.textContent.toLowerCase() || '';
        item.style.display = (title.includes(q) || artist.includes(q)) ? '' : 'none';
    });
}

function updatePlaylistHighlight() {
    document.querySelectorAll('.playlist-item').forEach(item => {
        const idx      = parseInt(item.dataset.idx);
        const isActive = idx === currentMusicIndex;
        item.classList.toggle('playlist-item--active', isActive);
        const numEl = item.querySelector('.playlist-item-num');
        if (numEl) {
            numEl.innerHTML = isActive
                ? '<i class="fas fa-volume-high playlist-playing-icon"></i>'
                : `<span class="playlist-num">${idx + 1}</span>`;
        }
    });
    scrollPlaylistToActive();
}

function scrollPlaylistToActive() {
    const active = document.querySelector('.playlist-item--active');
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}



function updateVisualizer(isPlaying) {
    const visualizer = document.getElementById('music-visualizer');
    if (isPlaying) {
        visualizer.classList.add('is-playing');
    } else {
        visualizer.classList.remove('is-playing');
    }
}


function updateVisualizerColor() {
    const img = document.getElementById('music-album-art');
    const visualizerSpans = document.querySelectorAll('.music-visualizer span');
    const expandedPanel = document.getElementById('music-info');

    if (!img.src || img.style.display === 'none' || img.src.includes('blob:')) {
        const defaultColor = '#1db954';
        visualizerSpans.forEach(span => {
            span.style.background = defaultColor;
            span.style.boxShadow = `0 -2px 10px rgba(29, 185, 84, 0.3)`;
        });
        return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 1;
    canvas.height = 1;

    const getColor = () => {
        try {
            ctx.drawImage(img, 0, 0, 1, 1);
            let [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;

            // Ensure color isn't too dark for the glow to be visible
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            if (brightness < 60) {
                r += 40; g += 40; b += 40;
            }

            const color = `rgb(${r}, ${g}, ${b})`;
            const glowColor = `rgba(${r}, ${g}, ${b}, 0.6)`;
            const ambientColor = `rgba(${r}, ${g}, ${b}, 0.15)`;

            // 1. Apply to Visualizer Bars
            visualizerSpans.forEach(span => {
                span.style.background = color;
                span.style.boxShadow = `0 -4px 15px ${glowColor}`;
            });

            // 2. Apply Ambient Glow to the background
            // This creates a subtle "halo" effect behind the lyrics
            if (expandedPanel) {
                expandedPanel.style.background = `radial-gradient(circle at top, ${ambientColor} 0%, #121212 80%)`;
            }

        } catch (e) {
            console.warn("CORS/Canvas issue:", e);
        }
    };

    if (img.complete) getColor();
    else img.onload = getColor;
}