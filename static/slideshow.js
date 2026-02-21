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
    runSlideshowCycle();
}

// Add 'direction' parameter and 'skipAnimation' for post-swipe renders
async function runSlideshowCycle(direction = 'next', skipAnimation = false) {
    if (cfg.mode !== "photo" && cfg.mode !== "hybrid") return;
    
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

    await finalizeRender(container, elementsToShow, photosToShow, direction, skipAnimation);
    preloadUpcoming();

    isRendering = false;
    return photosToShow.length;
}

// Add 'skipAnimation' as the 5th parameter — used after swipe commits
async function finalizeRender(container, elements, photoDataArray, direction = 'next', skipAnimation = false) {
    container.innerHTML = '';
    container.className = `slideshow-container layout-${elements.length}`;
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
        row.innerHTML = `<span>🖼️${dateStr} </span><span>📱${deviceModel}</span>`;
        infoStack.appendChild(row);

        // LOCATION LOGIC
        if (data.location) {
            // BEST CASE: Location already in DB. Show it immediately.
            row.innerHTML = `<span>🖼️${dateStr} </span><span>📱${deviceModel} </span><span>🛣️${data.location}</span>`;
        } else if (data.lat && data.lon) {
            // SECOND BEST: We have coords but no name. Fetch it, then it will save to DB.
            getLocationName(data.lat, data.lon, data.url).then(locName => {
                if (locName) {
                    row.innerHTML = `<span>🖼️${dateStr} </span><span>📱${deviceModel} </span><span>🛣️${locName}</span> `;
                }
            });
        }
    }
}


/* ============================================================
   VIDEO
   ============================================================ */

function initVideo() {
    const videoEl = document.getElementById('bg-video');
    if (videos.length === 0) { console.log("❌ No videos found."); return; }

    videoEl.volume = (cfg.video.volume || 20) / 100;

    const playNextVideo = () => {
        if (videos.length === 0) return;
        videoEl.src = videos[currentVideoIndex];
        console.log("🎬 Playing:", videos[currentVideoIndex]);
        videoEl.play().catch(() => console.warn("Video autoplay blocked."));
        currentVideoIndex = (currentVideoIndex + 1) % videos.length;
    };

    videoEl.onended = playNextVideo;
    playNextVideo();
}


/* ============================================================
   PHOTO HELPERS
   ============================================================ */

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