// =============================================================================
// slideshow.js — Photo slideshow, video playback, image preloading,
//                photo metadata helpers (date, device, location)
// =============================================================================


/* ============================================================
   IMAGE PRELOADER
   ============================================================ */

const PRELOAD_CACHE_MAX = 100;

function preloadImage(url) {
    if (preloadCache[url]) return preloadCache[url];
    // Evict oldest entry once we hit the cap
    const keys = Object.keys(preloadCache);
    if (keys.length >= PRELOAD_CACHE_MAX) delete preloadCache[keys[0]];
    const img     = new Image();
    img.src       = url;
    preloadCache[url] = img;
    return img;
}

function preloadUpcoming(forwardCount = 6, backCount = 2) {
    for (let i = 1; i <= forwardCount; i++) {
        const idx = (currentPhotoIndex + i) % photos.length;
        if (photos[idx]) preloadImage(photos[idx].url);
    }
    for (let i = 1; i <= backCount; i++) {
        const idx = (currentPhotoIndex - i + photos.length) % photos.length;
        if (photos[idx]) preloadImage(photos[idx].url);
    }
}


/* ============================================================
   ORIENTATION HELPER
   ============================================================ */

// Derives effective orientation from width/height at runtime.
// Avoids storing 'square' in the DB — portrait/landscape from the DB
// are used as-is; square is detected here with a 2% tolerance to handle
// near-square crops from real cameras.
const SQUARE_TOLERANCE = 0.02;
function getOrientation(p) {
    if (p.width > 0 && p.height > 0 &&
        Math.abs(p.width - p.height) / Math.max(p.width, p.height) <= SQUARE_TOLERANCE)
        return 'square';
    return p.orientation; // 'portrait' | 'landscape' from DB
}


/* ============================================================
   SLIDESHOW
   ============================================================ */

function startSlideshow() {
    if (window.slideshowTimer) clearTimeout(window.slideshowTimer);
    // Only hide video if it's still active (not already cleared by hybrid fade-out)
    if (_vplayers.a && _vplayers.a.style.display !== 'none') _hideVideoPlayer();
    runSlideshowCycle();
}

// Add 'direction' parameter and 'skipAnimation' for post-swipe renders
async function runSlideshowCycle(direction = 'next', skipAnimation = false) {
    if (cfg.mode !== "photo" && cfg.mode !== "hybrid") return;

    // --- HYBRID: interleave a video every N photos ---
    if (cfg.mode === 'hybrid' && videos.length > 0) {
        const every = cfg.video?.every ?? 5; // show a video every N photo advances
        photosSinceLastVideo = (photosSinceLastVideo ?? 0) + 1;
        if (photosSinceLastVideo >= every) {
            photosSinceLastVideo = 0;
            playOneVideo();  // hands control to video; video calls startSlideshow() when done
            return;
        }
    }

    // Pass direction and skipAnimation down the chain
    const count = await renderCurrentSlide(direction, skipAnimation); 
    
    if (window.slideshowTimer) clearTimeout(window.slideshowTimer);
    const duration = (cfg.photo.duration || 10) * 1000;
    window.slideshowTimer = setTimeout(() => {
        currentPhotoIndex = (currentPhotoIndex + count) % photos.length;
        runSlideshowCycle('next'); // Auto-advance is always 'next'
    }, duration);
}

async function renderCurrentSlide(direction = 'next', skipAnimation = false) {
    if (isRendering) return 0;
    isRendering = true;

    const container = document.getElementById('slideshow-container');
    if (!photos || photos.length === 0) { isRendering = false; return 0; }

    // --- PAIRING LOGIC ---
    // Landscape screen: pair two portraits OR two squares side by side
    // Portrait screen:  stack two landscapes OR two squares vertically
    // Mixed orientations are never paired — always show one photo
    const isLandscapeScreen = window.innerWidth > window.innerHeight;
    const p1          = photos[currentPhotoIndex];
    let photosToShow  = [p1];

    const nextIdx = (currentPhotoIndex + 1) % photos.length;
    const p2      = photos[nextIdx];

    const o1 = getOrientation(p1);
    const o2 = p2 ? getOrientation(p2) : null;

    if (isLandscapeScreen) {
        // On landscape screen: pair portraits side by side, or squares side by side
        if ((o1 === 'portrait' && o2 === 'portrait') ||
            (o1 === 'square'   && o2 === 'square'))   photosToShow.push(p2);
    } else {
        // On portrait screen: stack landscapes vertically, or stack squares vertically
        if ((o1 === 'landscape' && o2 === 'landscape') ||
            (o1 === 'square'    && o2 === 'square'))   photosToShow.push(p2);
    }

    // Wait for preloaded images (fall back to fresh load if not cached)
    const loadPromises = photosToShow.map(p => new Promise(resolve => {
        const cached = preloadCache[p.url];
        if (cached && cached.complete && cached.naturalWidth > 0) {
            resolve(cached);
        } else {
            const img   = preloadImage(p.url);
            img.onload  = () => resolve(img);
            img.onerror = () => resolve(img);
        }
    }));

    const loadedImgs = await Promise.all(loadPromises);
    const elementsToShow = loadedImgs.map(img => {
        const el = img.cloneNode();
        // Skip animation class when swipe already handled the visual transition
        el.className = skipAnimation ? 'slide-photo' : `slide-photo slide-${direction}`;
        el.style.objectFit = cfg.photo.fit || "cover";
        return el;
    });

    // Pass fit to finalizeRender so it can set the CSS variable on the container
    await finalizeRender(container, elementsToShow, photosToShow, direction, skipAnimation, cfg.photo.fit || 'cover');
    preloadUpcoming();

    isRendering = false;
    return photosToShow.length;
}

// Add 'skipAnimation' as the 5th parameter — used after swipe commits
// 'fit' drives the CSS variable --photo-fit on the container, which overrides
// the class-level object-fit rules for single-photo (layout-1) slides.
async function finalizeRender(container, elements, photoDataArray, direction = 'next', skipAnimation = false, fit = 'cover') {
    container.innerHTML = '';
    const fromVideo = container.classList.contains('from-video');
    container.className = `slideshow-container layout-${elements.length}${fromVideo ? ' from-video' : ''}`;
    // Expose fit as a data-attribute so CSS can target it
    container.dataset.fit = fit;
    // Strip from-video after the animation plays so it doesn't re-trigger on next photo
    if (fromVideo) setTimeout(() => container.classList.remove('from-video'), 700);
    const infoStack     = document.getElementById('photo-info-stack');
    infoStack.innerHTML = '';

    elements.forEach(img => {
        const wrapper = document.createElement('div');
        wrapper.className = 'photo-wrapper';
        
        // Skip the slide animation when swipe already did the visual work
        img.className = skipAnimation ? 'slide-photo' : `slide-photo slide-${direction}`;
        
        const blurBg = new Image();
        blurBg.src = img.src;
        blurBg.className = 'blur-bg';
        wrapper.appendChild(blurBg);
        wrapper.appendChild(img);
        container.appendChild(wrapper);
    });

    for (let i = 0; i < photoDataArray.length; i++) {
        const data        = photoDataArray[i];
        const dateStr     = formatSingleDate(data.date);
        const deviceModel = cleanDeviceName(data.device);
        const row         = document.createElement('div');
        row.className     = 'info-row';
        
        // Add altitude if it exists (optional flare)
        const altStr = data.alt ? ` 🏔️${Math.round(data.alt)}m` : '';

        // Initial render: Date and Device
        row.innerHTML = `<span>🌄${dateStr} </span><span>📱${deviceModel}</span>`;
        infoStack.appendChild(row);

        // LOCATION LOGIC
        if (data.location) {
            // BEST CASE: Location already in DB. Show it immediately.
            row.innerHTML = `<span>🌄${dateStr} </span><span>📱${deviceModel} </span><span>🗺️${data.location}</span>`;
        } else if (data.lat && data.lon) {
            // SECOND BEST: We have coords but no name. Fetch it, then it will save to DB.
            getLocationName(data.lat, data.lon, data.url).then(locName => {
                if (locName) {
                    row.innerHTML = `<span>🌄${dateStr} </span><span>📱${deviceModel} </span><span>🗺️${locName}</span> `;
                }
            });
        }
    }
}


/* ============================================================
   VIDEO  —  Dual-Slot + Single Shared Blur Architecture
   ─────────────────────────────────────────────────────────────
   Elements created once:
     · #video-blur     z-index 3  — shared blurred background (always shows
                                    the NEXT slot's video, already buffered)
     · #video-player-a z-index 4  — slot A sharp player
     · #video-player-b z-index 4  — slot B sharp player

   Total loads at any moment = 2 (current + next).
   The blur is pointed at the next slot's already-loading src — zero extra
   network cost. On transition the blur instantly switches to the new next.

   Flow:
     1. Slot A plays video N.  Blur = slot B's src (video N+1, loading).
     2. Clip ends → fade out A, slot B fades in (already buffered = instant).
     3. Blur switches to what will be slot A (video N+2, now loading into A).
     4. Repeat alternating A ↔ B — always 2 video loads, 1 blur (free).
   ============================================================ */

let videoClipTimer       = null;
let videoExpanded        = false;
let photosSinceLastVideo = 0;
let _tapHintTimer        = null;

const VIDEO_FADE_MS = 2000; // cinematic crossfade

// Two player slots + one shared blur
const _vplayers = { a: null, b: null }; // <video> elements
let _vloaded    = { a: null, b: null }; // url currently loaded in each
let _activeSlot = 'a';
let _vblur      = null; // single shared blur <video>
let _vTransitioning = false; // guard against overlapping transitions

// ── One-time element creation ─────────────────────────────────────────────
function _ensureVideoSlots() {
    if (!_vblur) {
        const blur         = document.createElement('video');
        blur.id            = 'video-blur';
        blur.muted         = true;
        blur.playsInline   = true;
        blur.loop          = true;
        blur.preload       = 'auto';
        blur.style.cssText = `
            position:fixed; inset:0;
            width:112%; height:112%; top:-6%; left:-6%;
            object-fit:cover;
            filter:blur(40px) brightness(0.45);
            z-index:3; display:none; opacity:1;
            transition:opacity ${VIDEO_FADE_MS}ms ease;
            pointer-events:none;
        `;
        document.body.appendChild(blur);
        _vblur = blur;
    }

    ['a', 'b'].forEach(id => {
        if (!_vplayers[id]) {
            const p         = document.createElement('video');
            p.id            = `video-player-${id}`;
            p.playsInline   = true;
            p.preload       = 'auto';
            p.style.cssText = `
                position:fixed; inset:0;
                width:100%; height:100%;
                object-fit:contain;
                z-index:4; display:none; opacity:0;
                transition:opacity ${VIDEO_FADE_MS}ms ease;
                cursor:pointer; background:transparent;
                touch-action:none;
            `;
            p.addEventListener('click', _expandVideo);
            document.body.appendChild(p);
            _vplayers[id] = p;
        }
    });
}

// ── Load a URL into a player slot (background buffering, no play) ─────────
function _loadPlayer(slotId, url) {
    if (_vloaded[slotId] === url) return;
    _vloaded[slotId]    = url;
    _vplayers[slotId].src = url;
    _vplayers[slotId].load();
    console.log(`📦 Buffering slot-${slotId}:`, url);
}

// ── Point the shared blur at a url (already buffering in a player slot) ───
function _setBlur(url) {
    if (!_vblur) return;
    if (_vblur.src !== url) {
        _vblur.src = url;
        _vblur.load();
    }
    _vblur.style.display = 'block';
    _vblur.play().catch(() => {});
}

// ── Show a player slot ────────────────────────────────────────────────────
// readyState:  0=HAVE_NOTHING  1=HAVE_METADATA  2=HAVE_CURRENT_DATA
//              3=HAVE_FUTURE_DATA  4=HAVE_ENOUGH_DATA
// For a pre-buffered slot the events already fired, so we act immediately
// instead of waiting for events that will never come again.
function _showPlayer(slotId, url, videoData) {
    if (_vloaded[slotId] !== url) _loadPlayer(slotId, url); // safety net

    const p            = _vplayers[slotId];
    p.oncanplay        = null;
    p.onloadedmetadata = null;
    p.onended          = null;
    p.style.display    = 'block';
    p.style.opacity    = '0';

    function _onReady() {
        p.volume = (cfg.video?.volume ?? 20) / 100;
        p.play().catch(() => console.warn('⚠️ Autoplay blocked'));
        p.style.opacity = '1';
        // Defer info render by one frame so the DOM settles
        // (prevents race where _clearVideoInfo from a prior transition wipes this)
        requestAnimationFrame(() => _renderVideoInfo(videoData));
    }

    function _onMeta() {
        const clipLimit = cfg.video?.duration ?? 30;
        const clipEnd   = Math.min(p.duration, clipLimit);
        console.log(`⏱ slot-${slotId}: ${clipEnd.toFixed(1)}s / ${p.duration.toFixed(1)}s`);
        p.onended = () => { _clearVideoTimer(); if (!videoExpanded) _transition(); };
        videoClipTimer = setTimeout(() => { if (!videoExpanded) _transition(); }, clipEnd * 1000);
        // Defer hint so it appears after any transition cleanup has settled
        if (clipEnd < p.duration) requestAnimationFrame(_showTapHint);
    }

    // Already has enough data to play — act now, don't wait for events
    if (p.readyState >= 3) {
        _onReady();
    } else {
        p.oncanplay = () => { p.oncanplay = null; _onReady(); };
    }

    // Already has metadata — act now
    if (p.readyState >= 1) {
        _onMeta();
    } else {
        p.onloadedmetadata = () => { p.onloadedmetadata = null; _onMeta(); };
    }
}

// ── Hide a player slot (fade, pause, keep src) ────────────────────────────
function _hidePlayer(slotId) {
    const p              = _vplayers[slotId];
    p.style.opacity      = '0';
    p.oncanplay          = null;
    p.onloadedmetadata   = null;
    p.onended            = null;
    setTimeout(() => {
        p.pause();
        p.style.display  = 'none';
    }, VIDEO_FADE_MS);
}

// ── Fully clear a player slot ─────────────────────────────────────────────
function _clearPlayer(slotId) {
    const p            = _vplayers[slotId];
    if (!p) return;
    p.oncanplay        = null;
    p.onloadedmetadata = null;
    p.onended          = null;
    p.pause();
    p.src              = '';
    p.style.display    = 'none';
    p.style.opacity    = '0';
    _vloaded[slotId]   = null;
}

// ── Init ──────────────────────────────────────────────────────────────────
function initVideo() {
    if (videos.length === 0) { console.log('❌ No videos found.'); return; }
    _ensureVideoSlots();
    videoExpanded   = false;
    _activeSlot     = 'a';
    _vTransitioning = false;
    _clearVideoTimer();

    // Clear photo layer immediately — prevents it bleeding through during video
    const container = document.getElementById('slideshow-container');
    if (container) container.innerHTML = '';

    const curData  = videos[currentVideoIndex];
    const nextData = videos.length > 1 ? videos[(currentVideoIndex + 1) % videos.length] : null;

    // Buffer current into slot A, next into slot B simultaneously
    _loadPlayer('a', curData.url);
    if (nextData) _loadPlayer('b', nextData.url);

    // Blur shows the NEXT video (already buffering in slot B — free)
    if (nextData) _setBlur(nextData.url);
    else          _setBlur(curData.url); // only one video: blur = same

    console.log(`🎬 Playing ${currentVideoIndex + 1}/${videos.length}: slot-a →`, curData.url);
    _showPlayer('a', curData.url, curData);
    _initVideoSwipe();
}

// ── Transition: swap A ↔ B ────────────────────────────────────────────────
function _transition(direction = 'next') {
    if (_vTransitioning) return; // prevent overlapping fades
    _vTransitioning = true;
    _clearVideoTimer();
    videoExpanded = false;
    _hideTapHint();

    const outSlot = _activeSlot;
    _activeSlot   = _activeSlot === 'a' ? 'b' : 'a';
    const inSlot  = _activeSlot;

    if (direction === 'prev') {
        currentVideoIndex = (currentVideoIndex - 1 + videos.length) % videos.length;
    } else {
        currentVideoIndex = (currentVideoIndex + 1) % videos.length;
    }

    if (cfg.mode === 'hybrid') {
        // Fade out all video elements, THEN hand control to photos
        const pOut = _vplayers[outSlot];
        if (pOut) pOut.style.opacity = '0';
        if (_vblur) _vblur.style.opacity = '0';
        setTimeout(() => {
            _clearPlayer('a');
            _clearPlayer('b');
            if (_vblur) {
                _vblur.pause();
                _vblur.src             = '';
                _vblur.style.display   = 'none';
                _vblur.style.opacity   = '1';
            }
            _clearVideoInfo();
            _vTransitioning = false;
            const c = document.getElementById('slideshow-container');
            if (c) c.classList.add('from-video');
            startSlideshow();
        }, VIDEO_FADE_MS);
        return;
    }

    const curData  = videos[currentVideoIndex];
    // For prev, pre-load the video before current; for next, the one after
    const preloadIdx = direction === 'prev'
        ? (currentVideoIndex - 1 + videos.length) % videos.length
        : (currentVideoIndex + 1) % videos.length;
    const preloadData = videos.length > 1 ? videos[preloadIdx] : null;

    console.log(`🎬 Transition ${direction} → slot-${inSlot}:`, curData.url);

    // Load the new video into the incoming slot and show it
    _loadPlayer(inSlot, curData.url);
    _showPlayer(inSlot, curData.url, curData);

    // Fade out outgoing slot simultaneously
    _hidePlayer(outSlot);

    // After fade, load the next-to-play into the idle slot and update blur
    if (preloadData) {
        setTimeout(() => {
            _loadPlayer(outSlot, preloadData.url);
            _setBlur(preloadData.url);
            _vTransitioning = false;
        }, VIDEO_FADE_MS + 100);
    } else {
        setTimeout(() => { _vTransitioning = false; }, VIDEO_FADE_MS + 100);
    }
}

// ── Expand (tap to watch past clip limit) ────────────────────────────────
function _expandVideo() {
    if (videoExpanded) return;
    videoExpanded = true;
    _clearVideoTimer();
    _hideTapHint();
    console.log('👆 Watching full video');
}

// ── Public entry points ───────────────────────────────────────────────────
function playOneVideo() {
    if (videos.length === 0) { startSlideshow(); return; }
    initVideo();
}

function _hideVideoPlayer() {
    if (!_vplayers.a) return;
    _destroyVideoSwipe();
    _clearPlayer('a');
    _clearPlayer('b');
    if (_vblur) { _vblur.pause(); _vblur.src = ''; _vblur.style.display = 'none'; }
    _clearVideoInfo();
    _hideTapHint();
    _clearVideoTimer();
}

function _showVideoPlayer() { _ensureVideoSlots(); }

function _clearVideoTimer() {
    if (videoClipTimer) { clearTimeout(videoClipTimer); videoClipTimer = null; }
}

function _hidePhotoSlideshow() {
    if (window.slideshowTimer) { clearTimeout(window.slideshowTimer); window.slideshowTimer = null; }
    const c = document.getElementById('slideshow-container');
    if (c) c.innerHTML = '';
    // Note: do NOT clear video info here — video renders its own info when ready
}

// ── Video info stack — mirrors photo layout exactly ───────────────────────
function _renderVideoInfo(data) {
    const stack = document.getElementById('photo-info-stack');
    if (!stack || !data) return;
    stack.innerHTML = '';

    const row       = document.createElement('div');
    row.className   = 'info-row';
    const dateStr   = formatSingleDate(data.date);         // reuse photo helper
    const deviceStr = cleanDeviceName(data.device);        // reuse photo helper

    // Initial render: date + device (same pattern as photos)
    row.innerHTML = `<span>🎬${dateStr} </span><span>📱${deviceStr}</span>`;
    stack.appendChild(row);

    // Location: same three-tier logic as photos
    if (data.location) {
        row.innerHTML = `<span>🎬${dateStr} </span><span>📱${deviceStr} </span><span>🗺️${data.location}</span>`;
    } else if (data.lat && data.lon) {
        getLocationName(data.lat, data.lon, data.url).then(locName => {
            if (locName) {
                row.innerHTML = `<span>🎬${dateStr} </span><span>📱${deviceStr} </span><span>🗺️${locName}</span>`;
            }
        });
    }
}

function _clearVideoInfo() {
    const stack = document.getElementById('photo-info-stack');
    if (stack) stack.innerHTML = '';
}

// ── Tap hint ──────────────────────────────────────────────────────────────
function _showTapHint() {
    let hint = document.getElementById('video-tap-hint');
    if (!hint) {
        hint             = document.createElement('div');
        hint.id          = 'video-tap-hint';
        hint.textContent = '👆 Tap to watch full video';
        document.body.appendChild(hint);
    }
    hint.classList.add('visible');
    if (_tapHintTimer) clearTimeout(_tapHintTimer);
    _tapHintTimer = setTimeout(_hideTapHint, 3000);
}

function _hideTapHint() {
    const hint = document.getElementById('video-tap-hint');
    if (hint) hint.classList.remove('visible');
}







// ── Video swipe gestures ──────────────────────────────────────────────────
// Horizontal swipe on the video players directly (not body) to avoid the
// browser's native video touch handling stealing events.
const VSWIPE = {
    active:     false,
    startX:     0,
    startY:     0,
    deltaX:     0,
    isVertical: false,
    THRESHOLD:  0.20, // fraction of screen width to commit
    FLING_VEL:  0.25, // px/ms
    lastX:      0,
    lastTs:     0,
    velocityX:  0,
};

function _videoSwipeStart(e) {
    const t          = e.changedTouches[0];
    VSWIPE.active    = true;
    VSWIPE.isVertical = false;
    VSWIPE.deltaX    = 0;
    VSWIPE.velocityX = 0;
    VSWIPE.startX    = t.clientX;
    VSWIPE.startY    = t.clientY;
    VSWIPE.lastX     = t.clientX;
    VSWIPE.lastTs    = e.timeStamp;
}

function _videoSwipeMove(e) {
    if (!VSWIPE.active) return;
    const t  = e.changedTouches[0];
    const dx = t.clientX - VSWIPE.startX;
    const dy = t.clientY - VSWIPE.startY;

    // Axis lock — wait for 8px of movement before deciding direction
    if (!VSWIPE.isVertical && Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (!VSWIPE.isVertical) {
        if (Math.abs(dy) > Math.abs(dx)) { VSWIPE.isVertical = true; return; }
    }
    if (VSWIPE.isVertical) return;

    e.preventDefault();
    const dt         = Math.max(e.timeStamp - VSWIPE.lastTs, 1);
    VSWIPE.velocityX = (t.clientX - VSWIPE.lastX) / dt;
    VSWIPE.lastX     = t.clientX;
    VSWIPE.lastTs    = e.timeStamp;
    VSWIPE.deltaX    = dx;
}

function _videoSwipeEnd(e) {
    if (!VSWIPE.active || VSWIPE.isVertical) { VSWIPE.active = false; return; }
    VSWIPE.active = false;
    if (videos.length <= 1) return;

    const dx  = VSWIPE.deltaX;
    const vel = VSWIPE.velocityX;
    const w   = window.innerWidth;

    const distCommit = Math.abs(dx) > w * VSWIPE.THRESHOLD;
    const velCommit  = Math.abs(vel) > VSWIPE.FLING_VEL;

    if (distCommit || velCommit) {
        _vTransitioning = false; // allow swipe to override an in-progress auto-transition
        _transition(dx < 0 ? 'next' : 'prev');
    }
}

function _initVideoSwipe() {
    // Attach to both player elements directly — this avoids the browser's
    // native video touch handling (timeline scrub etc.) consuming the events
    ['a', 'b'].forEach(id => {
        const p = _vplayers[id];
        if (!p) return;
        p.addEventListener('touchstart',  _videoSwipeStart,  { passive: true });
        p.addEventListener('touchmove',   _videoSwipeMove,   { passive: false });
        p.addEventListener('touchend',    _videoSwipeEnd,    { passive: true });
        p.addEventListener('touchcancel', () => { VSWIPE.active = false; }, { passive: true });
    });
}

function _destroyVideoSwipe() {
    ['a', 'b'].forEach(id => {
        const p = _vplayers[id];
        if (!p) return;
        p.removeEventListener('touchstart',  _videoSwipeStart);
        p.removeEventListener('touchmove',   _videoSwipeMove);
        p.removeEventListener('touchend',    _videoSwipeEnd);
    });
    // Also clean up body listeners from any legacy calls
    document.body.removeEventListener('touchstart',  _videoSwipeStart);
    document.body.removeEventListener('touchmove',   _videoSwipeMove);
    document.body.removeEventListener('touchend',    _videoSwipeEnd);
}

function cleanDeviceName(name) {
    if (!name || name === "Unknown Device") return "Camera";
    return name.replace("United States of America", "")
               .replace("NIKON CORPORATION", "Nikon")
               .replace("SONY", "Sony")
               .replace(/iPhone\d+,\d+/, "iPhone")
               .trim();
}

function formatSingleDate(dStr) {
    if (!dStr) return "Recent Memory";
    const d     = new Date(dStr.split(' ')[0].replace(/:/g, '-'));
    const month = d.toLocaleDateString('en-US', { month: 'short' });
    const day   = String(d.getDate()).padStart(2, '0');
    const year  = d.getFullYear();
    return `${month} ${day}, ${year}`;
}

async function getLocationName(lat, lon, photoUrl) {
    if (lat == null || lon == null) return null;

    // --- 1. Build cache key using truncation toward zero (not rounding) ---
    // Math.trunc(-118.749 * 1000) / 1000  =>  -118.749  ✓
    // Math.floor(-118.749 * 1000) / 1000  =>  -118.750  ✗ (wrong cell)
    const PRECISION = 4;
    const factor    = 10 ** PRECISION;
    const latKey    = Math.trunc(lat * factor) / factor;
    const lonKey    = Math.trunc(lon * factor) / factor;
    const cacheKey  = `${latKey},${lonKey}`;

    // --- 2. In-memory cache hit ---
    if (locationCache[cacheKey]) return locationCache[cacheKey];

    // --- 3. Backend call ---
    try {
        const response = await fetch(
            `/api/geocode?lat=${lat}&lon=${lon}&url=${encodeURIComponent(photoUrl)}`
        );

        if (!response.ok) {
            console.warn(`Geocode API returned ${response.status} for (${lat}, ${lon})`);
            return null;
        }

        const data = await response.json();

        // --- 4. Store in JS cache ---
        if (data.location) {
            locationCache[cacheKey] = data.location;
            return data.location;
        }
    } catch (e) {
        console.error("Geocoding failed:", e);
    }

    return null;
}






// =============================================================================
// IPHONE-STYLE SWIPE GESTURE SYSTEM
// Features: live drag tracking, velocity-based fling, rubber-band edges,
//           outgoing + incoming photos move together like a real photo viewer
// =============================================================================

function goToNextSlide() {
    if (isRendering) return;
    const container = document.getElementById('slideshow-container');
    const currentCount = container.classList.contains('layout-2') ? 2 : 1;
    currentPhotoIndex = (currentPhotoIndex + currentCount) % photos.length;
    runSlideshowCycle('next');
}

function goToPrevSlide() {
    if (isRendering) return;
    // If the two photos before the current index would have formed a pair,
    // step back by 2 so we land on the start of that pair rather than its second photo.
    const isLandscapeScreen = window.innerWidth > window.innerHeight;
    const prevPairIdx = (currentPhotoIndex - 2 + photos.length) % photos.length;
    const pA = photos[prevPairIdx];
    const pB = photos[(prevPairIdx + 1) % photos.length];
    const oA = pA ? getOrientation(pA) : null;
    const oB = pB ? getOrientation(pB) : null;
    const wouldPair = oA && oB && (
        (oA === 'square'    && oB === 'square')                          ||
        ( isLandscapeScreen && oA === 'portrait'  && oB === 'portrait') ||
        (!isLandscapeScreen && oA === 'landscape' && oB === 'landscape')
    );
    const step = wouldPair ? 2 : 1;
    currentPhotoIndex = (currentPhotoIndex - step + photos.length) % photos.length;
    runSlideshowCycle('prev');
}

// ── Gesture state ──────────────────────────────────────────────────────────
const SWIPE = {
    active:        false,
    startX:        0,
    startY:        0,
    lastX:         0,
    lastTimestamp: 0,
    velocityX:     0,
    deltaX:        0,
    direction:     null,  // 'next' | 'prev' — locked on axis detection
    isDragging:    false, // locked in as horizontal
    isVertical:    false, // locked in as vertical — hands off
    THRESHOLD:     0.30,  // fraction of screen width to commit
    FLING_VEL:     0.35,  // px/ms — fast flick always commits
    RUBBER_MAX:    70,    // max rubber-band pixels at edges
};

let peekEl = null;

// ── Peek layer helpers ─────────────────────────────────────────────────────
function _getPeekPhoto(direction) {
    const container = document.getElementById('slideshow-container');
    const step = container.classList.contains('layout-2') ? 2 : 1;
    const idx = direction === 'next'
        ? (currentPhotoIndex + step) % photos.length
        : (currentPhotoIndex - 1 + photos.length) % photos.length;
    return photos[idx] || null;
}

function _createPeekLayer(direction) {
    if (peekEl) _destroyPeekLayer();
    const peekData = _getPeekPhoto(direction);
    if (!peekData) return;

    const w = window.innerWidth;
    // Peek starts fully off-screen: to the right for 'next', left for 'prev'
    const startLeft = direction === 'next' ? w : -w;

    const wrapper = document.createElement('div');
    wrapper.id = 'swipe-peek';
    wrapper.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: ${w}px;
        height: 100vh;
        z-index: 5;
        overflow: hidden;
        pointer-events: none;
        background: #000;
        transform: translateX(${startLeft}px);
        will-change: transform;
    `;

    const blurImg = new Image();
    blurImg.src = peekData.url;
    blurImg.style.cssText = `
        position: absolute; top: 0; left: 0;
        width: 100%; height: 100%;
        object-fit: cover;
        filter: blur(40px) brightness(0.5);
        transform: scale(1.1);
    `;

    const img = new Image();
    img.src = peekData.url;
    img.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        z-index: 2;
        width: 100%;
        height: 100%;
        object-fit: contain;
    `;

    wrapper.appendChild(blurImg);
    wrapper.appendChild(img);
    document.body.appendChild(wrapper);
    peekEl = wrapper;
}

function _destroyPeekLayer() {
    if (peekEl) { peekEl.remove(); peekEl = null; }
}

// ── Physics ────────────────────────────────────────────────────────────────
function _rubberBand(x) {
    const sign = x > 0 ? 1 : -1;
    return sign * SWIPE.RUBBER_MAX * (1 - Math.exp(-Math.abs(x) / (SWIPE.RUBBER_MAX * 2.5)));
}

// ── Core drag/snap/commit ──────────────────────────────────────────────────
function _applyDrag(rawDelta) {
    const container = document.getElementById('slideshow-container');
    const w = window.innerWidth;
    const atFirst = currentPhotoIndex === 0;
    const atLast  = currentPhotoIndex >= photos.length - 1;

    // Rubber-band at edges
    let tx = rawDelta;
    if ((rawDelta > 0 && atFirst) || (rawDelta < 0 && atLast)) {
        tx = _rubberBand(rawDelta);
    }

    // Current photo follows finger
    container.style.transition = 'none';
    container.style.transform  = `translateX(${tx}px)`;

    // Peek layer: starts at ±w, also moves by tx so it closes in
    if (peekEl) {
        const peekStart = SWIPE.direction === 'next' ? w : -w;
        peekEl.style.transition = 'none';
        peekEl.style.transform  = `translateX(${peekStart + tx}px)`;
    }
}

function _snapBack() {
    const container = document.getElementById('slideshow-container');
    const easing = 'transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)';

    container.style.transition = easing;
    container.style.transform  = 'translateX(0)';

    if (peekEl) {
        const w = window.innerWidth;
        const peekStart = SWIPE.direction === 'next' ? w : -w;
        peekEl.style.transition = easing;
        peekEl.style.transform  = `translateX(${peekStart}px)`;
    }

    setTimeout(() => {
        _destroyPeekLayer();
        container.style.transition = '';
        container.style.transform  = '';
    }, 420);
}

function _commitSwipe(direction) {
    const container = document.getElementById('slideshow-container');
    const w = window.innerWidth;
    const exitX = direction === 'next' ? -w : w;
    const easing = 'transform 0.32s cubic-bezier(0.25, 1, 0.5, 1)';

    // Current slide exits
    container.style.transition = easing;
    container.style.transform  = `translateX(${exitX}px)`;

    // Peek layer finishes sliding into center (translateX = 0)
    if (peekEl) {
        peekEl.style.transition = easing;
        peekEl.style.transform  = 'translateX(0)';
    }

    setTimeout(() => {
        // Destroy peek, reset container, then swap to the real new photo (no animation)
        _destroyPeekLayer();
        container.style.transition = '';
        container.style.transform  = '';

        if (direction === 'next') {
            const step = container.classList.contains('layout-2') ? 2 : 1;
            currentPhotoIndex = (currentPhotoIndex + step) % photos.length;
        } else {
            // Mirror goToPrevSlide: step back 2 if the prior pair would have been a pair
            const isLandscapeScreen = window.innerWidth > window.innerHeight;
            const prevPairIdx = (currentPhotoIndex - 2 + photos.length) % photos.length;
            const pA = photos[prevPairIdx];
            const pB = photos[(prevPairIdx + 1) % photos.length];
            const oA = pA ? getOrientation(pA) : null;
            const oB = pB ? getOrientation(pB) : null;
            const wouldPair = oA && oB && (
                (oA === 'square'   && oB === 'square')                          ||
                ( isLandscapeScreen && oA === 'portrait'  && oB === 'portrait') ||
                (!isLandscapeScreen && oA === 'landscape' && oB === 'landscape')
            );
            const step = wouldPair ? 2 : 1;
            currentPhotoIndex = (currentPhotoIndex - step + photos.length) % photos.length;
        }
        // skipAnimation=true — swipe already provided the visual transition
        runSlideshowCycle(direction, true);
    }, 340);
}

// ── Touch event handlers ───────────────────────────────────────────────────
function _onTouchStart(e) {
    if (isRendering) return;
    const t = e.changedTouches[0];
    SWIPE.active        = true;
    SWIPE.isDragging    = false;
    SWIPE.isVertical    = false;
    SWIPE.direction     = null;
    SWIPE.startX        = t.clientX;
    SWIPE.startY        = t.clientY;
    SWIPE.lastX         = t.clientX;
    SWIPE.lastTimestamp = e.timeStamp;
    SWIPE.velocityX     = 0;
    SWIPE.deltaX        = 0;
}

function _onTouchMove(e) {
    if (!SWIPE.active) return;
    const t  = e.changedTouches[0];
    const dx = t.clientX - SWIPE.startX;
    const dy = t.clientY - SWIPE.startY;

    // Axis lock: wait for at least 8px of movement before deciding
    if (!SWIPE.isDragging && !SWIPE.isVertical) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // not enough movement yet
        if (Math.abs(dx) > Math.abs(dy)) {
            // Horizontal drag — take over
            SWIPE.isDragging = true;
            SWIPE.direction  = dx < 0 ? 'next' : 'prev';
            _createPeekLayer(SWIPE.direction);
        } else {
            // Vertical scroll — let browser handle it
            SWIPE.isVertical = true;
            return;
        }
    }

    if (!SWIPE.isDragging) return;

    // Prevent page scroll / browser back-forward nav
    e.preventDefault();

    // Rolling velocity
    const dt = Math.max(e.timeStamp - SWIPE.lastTimestamp, 1);
    SWIPE.velocityX     = (t.clientX - SWIPE.lastX) / dt;
    SWIPE.lastX         = t.clientX;
    SWIPE.lastTimestamp = e.timeStamp;
    SWIPE.deltaX        = dx;

    _applyDrag(dx);
}

function _onTouchEnd(e) {
    if (!SWIPE.active || !SWIPE.isDragging) {
        SWIPE.active = false;
        return;
    }
    SWIPE.active = false;

    const w   = window.innerWidth;
    const dx  = SWIPE.deltaX;
    const vel = SWIPE.velocityX;
    const atFirst = currentPhotoIndex === 0;
    const atLast  = currentPhotoIndex >= photos.length - 1;

    const distanceCommit = Math.abs(dx) > w * SWIPE.THRESHOLD;
    const velocityCommit = Math.abs(vel) > SWIPE.FLING_VEL;

    if ((distanceCommit || velocityCommit) && dx < 0 && !atLast)  { _commitSwipe('next'); return; }
    if ((distanceCommit || velocityCommit) && dx > 0 && !atFirst) { _commitSwipe('prev'); return; }

    _snapBack();
}

function _onTouchCancel() {
    if (!SWIPE.active) return;
    SWIPE.active = false;
    if (SWIPE.isDragging) _snapBack();
}

// ── Init ───────────────────────────────────────────────────────────────────
function initGalleryGestures() {
    const container = document.getElementById('slideshow-container');
    if (!container) return;

    // touchstart/end can be passive; touchmove cannot (we call preventDefault)
    container.addEventListener('touchstart',  _onTouchStart,  { passive: true });
    container.addEventListener('touchmove',   _onTouchMove,   { passive: false });
    container.addEventListener('touchend',    _onTouchEnd,    { passive: true });
    container.addEventListener('touchcancel', _onTouchCancel, { passive: true });
}

document.addEventListener('DOMContentLoaded', initGalleryGestures);