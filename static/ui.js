// =============================================================================
// ui.js — Overlay, menu, settings panel, status dashboard, credits,
//         shared UI component helpers (createCard, createSettingRow, etc.)
// =============================================================================


/* ============================================================
   SHARED UI HELPERS
   ============================================================ */

const createSettingRow = (label, control, rowId = '', display = 'flex') => `
    <div class="setting-row" ${rowId ? `id="${rowId}"` : ''} style="display:${display}">
        <span class="setting-label">${label}</span>
        ${control}
    </div>
`;

const createCard = (title, icon, content, subText = "") => `
    <div class="status-card">
        <div class="category-header">
            <span>${icon} ${title}</span>
            ${subText ? `<span style="font-size:0.8em; color:#888;">${subText}</span>` : ''}
        </div>
        ${content}
    </div>
`;

const createStatBox = (icon, label, value) => `
    <div class="stat-item">
        <div style="font-size:1.5em">${icon}</div>
        <div style="font-size:0.7em; color:#888; text-transform:uppercase;">${label}</div>
        <div style="font-weight:bold">${value}</div>
    </div>
`;

function checkMarquee(elementOrId) {
    const targets = Array.isArray(elementOrId) ? elementOrId : [elementOrId];
    targets.forEach(target => {
        const el = typeof target === 'string' ? document.getElementById(target) : target;
        if (!el) return;
        const isOverflowing = el.scrollWidth > el.parentElement.clientWidth;
        el.classList.toggle('overflowing', isOverflowing);
        if (isOverflowing) {
            el.style.setProperty('--wrapper-width', `${el.parentElement.clientWidth}px`);
        }
    });
}


/* ============================================================
   OVERLAY & MENU
   ============================================================ */

function toggleMenu()   { document.getElementById("side-menu").style.height = "100%"; }
function closeMenu()    { document.getElementById("side-menu").style.height = "0"; }
function closeOverlay() { document.getElementById("modal-overlay").style.display = "none"; }

function toggleFullScreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => alert(`Error: ${err.message}`));
    } else {
        if (document.exitFullscreen) document.exitFullscreen();
    }
    closeMenu();
}

async function showOverlay(type) {
    const overlay = document.getElementById("modal-overlay");
    const title   = document.getElementById("modal-title");
    const body    = document.getElementById("modal-body");
    overlay.style.display = "flex";
    closeMenu();
    if      (type === 'status')   renderStatus(title, body);
    else if (type === 'credit')   renderCredits(title, body);
    else if (type === 'settings') renderSettings(title, body);
}

async function refreshLibrary() {
    try {
        await fetch('/api/refresh', { method: 'POST' });
        location.reload();
    } catch (e) { alert('❌ Failed to refresh library.'); }
}


/* ============================================================
   SETTINGS
   ============================================================ */

function renderPathRows(paths) {
    return paths.map(p => `
        <div class="path-item">
            <span style="font-size:0.8em">📁</span>
            <input type="text" class="path-entry" value="${p}" spellcheck="false">
            <button class="btn-remove" onclick="this.parentElement.remove()">×</button>
        </div>
    `).join('');
}

function addPathRow(containerId) {
    const container   = document.getElementById(containerId);
    const div         = document.createElement('div');
    div.className     = 'path-item';
    div.innerHTML     = `
        <span style="font-size:0.8em">📁</span>
        <input type="text" class="path-entry" placeholder="C:\\New\\Path..." spellcheck="false">
        <button class="btn-remove" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(div);
}

async function renderSettings(titleEl, bodyEl) {
    titleEl.innerHTML = "⚙️ System Configuration";
    bodyEl.innerHTML  = "<div style='text-align:center; padding:40px;'>🛰️ Retrieving Config...</div>";

    try {
        const res = await fetch('/api/config');
        const cfg = await res.json();

        const preferences = createCard("Display Preferences", "🎨", `
            ${createSettingRow("Playback Mode", `
                <select id="set-mode" class="setting-control">
                    <option value="photo"  ${cfg.mode === 'photo'  ? 'selected' : ''}>🖼️ Photos Only</option>
                    <option value="video"  ${cfg.mode === 'video'  ? 'selected' : ''}>🎬 Videos Only</option>
                    <option value="hybrid" ${cfg.mode === 'hybrid' ? 'selected' : ''}>🔄 Hybrid Mix</option>
                </select>`)}
            ${createSettingRow("Cache Mode", `
                <select id="set-dev" class="setting-control" onchange="document.getElementById('version-row').style.display=this.value==='false'?'flex':'none'">
                    <option value="true"  ${cfg.dev !== false ? 'selected' : ''}>🔧 Dev — bust cache on every restart</option>
                    <option value="false" ${cfg.dev === false ? 'selected' : ''}>🚀 Prod — use fixed version string</option>
                </select>`)}
            ${createSettingRow("Version String", `
                <input type="text" id="set-version" class="setting-control" style="width:100px"
                    value="${cfg.version ?? '1.0.0'}" placeholder="e.g. 1.0.0">`,
                'version-row', cfg.dev !== false ? 'none' : 'flex')}
        `);

        const photoCard = createCard("Photo Settings", "📸", `
            ${createSettingRow("Slide Duration", `
                <div style="display:flex; align-items:center; gap:10px;">
                    <input type="number" id="set-duration" class="setting-control" style="width:70px"
                        value="${cfg.photo?.duration ?? 10}" min="1">
                    <span style="font-size:0.8em; color:#888;">sec</span>
                </div>`)}
            ${createSettingRow("Shuffle", `
                <select id="set-photo-shuffle" class="setting-control">
                    <option value="true"  ${cfg.photo?.shuffle  ? 'selected' : ''}>🔀 On</option>
                    <option value="false" ${!cfg.photo?.shuffle ? 'selected' : ''}>➡️ Off</option>
                </select>`)}
            ${createSettingRow("Fit Mode", `
                <select id="set-photo-fit" class="setting-control">
                    <option value="cover"   ${cfg.photo?.fit === 'cover'   ? 'selected' : ''}>🔲 Cover (crop to fill)</option>
                    <option value="contain" ${cfg.photo?.fit === 'contain' ? 'selected' : ''}>🖼️ Contain (show full)</option>
                </select>`)}
        `);

        const musicCard = createCard("Music Settings", "🎵", `
            ${createSettingRow("Auto-Play", `
                <select id="set-music-play" class="setting-control">
                    <option value="auto"   ${cfg.music?.play === 'auto'   ? 'selected' : ''}>🎵 Auto-Play</option>
                    <option value="manual" ${cfg.music?.play === 'manual' ? 'selected' : ''}>🖐️ Manual</option>
                    <option value="no"     ${cfg.music?.play === 'no'     ? 'selected' : ''}>🔇 Muted</option>
                </select>`)}
            ${createSettingRow("Volume", `
                <div style="display:flex; align-items:center; gap:10px;">
                    <input type="number" id="set-music-volume" class="setting-control" style="width:70px"
                        value="${cfg.music?.volume ?? 50}" min="0" max="100">
                    <span style="font-size:0.8em; color:#888;">%</span>
                </div>`)}
            ${createSettingRow("Shuffle", `
                <select id="set-music-shuffle" class="setting-control">
                    <option value="true"  ${cfg.music?.shuffle  ? 'selected' : ''}>🔀 On</option>
                    <option value="false" ${!cfg.music?.shuffle ? 'selected' : ''}>➡️ Off</option>
                </select>`)}
        `);

        const videoCard = createCard("Video Settings", "🎬", `
            ${createSettingRow("Clip Duration", `
                <div style="display:flex; align-items:center; gap:10px;">
                    <input type="number" id="set-video-duration" class="setting-control" style="width:70px"
                        value="${cfg.video?.duration ?? 30}" min="1">
                    <span style="font-size:0.8em; color:#888;">sec</span>
                </div>`)}
            ${createSettingRow("Volume", `
                <div style="display:flex; align-items:center; gap:10px;">
                    <input type="number" id="set-video-volume" class="setting-control" style="width:70px"
                        value="${cfg.video?.volume ?? 20}" min="0" max="100">
                    <span style="font-size:0.8em; color:#888;">%</span>
                </div>`)}
            ${createSettingRow("Shuffle", `
                <select id="set-video-shuffle" class="setting-control">
                    <option value="true"  ${cfg.video?.shuffle  ? 'selected' : ''}>🔀 On</option>
                    <option value="false" ${!cfg.video?.shuffle ? 'selected' : ''}>➡️ Off</option>
                </select>`)}
            ${createSettingRow("Photos Between Video (Hybrid Mode)", `
                <div style="display:flex; align-items:center; gap:10px;">
                    <input type="number" id="set-video-every" class="setting-control" style="width:70px"
                        value="${cfg.video?.every ?? 7}" min="1">
                    <span style="font-size:0.8em; color:#888;">Photos</span>
                </div>`)}
        `);

        const sources = createCard("Media Source", "📂", `
            <div class="path-section">
                <label>📸 Photo Libraries</label>
                <div id="path-list-photos">${renderPathRows(cfg.photo?.folders ?? [])}</div>
                <button class="btn-add" onclick="addPathRow('path-list-photos')">+ Add Photo Folder</button>
            </div>
            <div class="path-section" style="margin-top:20px;">
                <label>🎬 Video Libraries</label>
                <div id="path-list-videos">${renderPathRows(cfg.video?.folders ?? [])}</div>
                <button class="btn-add" onclick="addPathRow('path-list-videos')">+ Add Video Folder</button>
            </div>
            <div class="path-section" style="margin-top:20px;">
                <label>🎵 Music Libraries</label>
                <div id="path-list-music">${renderPathRows(cfg.music?.folders ?? [])}</div>
                <button class="btn-add" onclick="addPathRow('path-list-music')">+ Add Music Folder</button>
            </div>
        `, "");

        bodyEl.innerHTML = `
            <div class="settings-container">
                ${preferences}
                ${photoCard}
                ${musicCard}
                ${videoCard}
                ${sources}
                <div class="save-bar">
                    <button class="btn-refresh" onclick="saveSettings()">
                        💾 Save Settings & Restart
                    </button>
                </div>
            </div>
        `;
    } catch (e) {
        console.error(e);
        bodyEl.innerHTML = "❌ Connection Error.";
    }
}

async function saveSettings() {
    const newConfig = {
        dev:     document.getElementById('set-dev').value === 'true',
        version: document.getElementById('set-version').value.trim() || '1.0.0',
        mode: document.getElementById('set-mode').value,
        photo: {
            duration:   parseInt(document.getElementById('set-duration').value),
            shuffle:    document.getElementById('set-photo-shuffle').value === 'true',
            fit:        document.getElementById('set-photo-fit').value,
            folders:    [...document.querySelectorAll('#path-list-photos .path-entry')].map(i => i.value).filter(Boolean),
            extensions: [...new Set([".jpg", ".jpeg", ".png", ".webp"])]
        },
        music: {
            play:       document.getElementById('set-music-play').value,
            volume:     parseInt(document.getElementById('set-music-volume').value),
            shuffle:    document.getElementById('set-music-shuffle').value === 'true',
            folders:    [...document.querySelectorAll('#path-list-music .path-entry')].map(i => i.value).filter(Boolean),
            extensions: [".mp3"]
        },
        video: {
            duration:   parseInt(document.getElementById('set-video-duration').value),
            volume:     parseInt(document.getElementById('set-video-volume').value),
            shuffle:    document.getElementById('set-video-shuffle').value === 'true',
            every:      parseInt(document.getElementById('set-video-every').value),
            folders:    [...document.querySelectorAll('#path-list-videos .path-entry')].map(i => i.value).filter(Boolean),
            extensions: [".mp4", ".mov"]
        }
    };

    try {
        const res = await fetch('/api/settings', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(newConfig)
        });
        if (res.ok) { closeOverlay(); location.reload(); }
        else alert('❌ Failed to save settings.');
    } catch (e) {
        alert('❌ Connection error.');
    }
}


/* ============================================================
   STATUS DASHBOARD
   ============================================================ */

async function renderStatus(titleEl, bodyEl) {
    titleEl.innerHTML = "📊 System Dashboard";
    bodyEl.innerHTML  = "<div style='text-align:center; padding:20px;'>🔍 Analyzing...</div>";

    try {
        const res  = await fetch('/api/status');
        const data = await res.json();

        let html = `<div class="hw-stats">
            ${createStatBox("💻", "CPU Load", data.system.cpu_load)}
            ${createStatBox("📊", "Memory",   data.system.memory)}
        </div>`;

        for (const [category, info] of Object.entries(data.media_summary)) {
            const icon = category.toLowerCase().includes('music') ? '🎵'
                       : category.toLowerCase().includes('video') ? '🎬' : '🖼️';

            const tableContent = `
                <table class="folder-table" style="table-layout:fixed; width:100%;">
                    <thead>
                        <tr style="font-size:0.7em; color:#555; text-transform:uppercase;">
                            <th style="text-align:left;">Path</th>
                            <th style="text-align:right; width:60px;">Files</th>
                            <th style="text-align:right; width:90px;">Size</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${info.details.map(f => `
                            <tr>
                                <td style="word-break:break-all; padding:8px 0; font-size:0.9em;">📁 ${f.path}</td>
                                <td style="text-align:right; color:#50fa7b; font-family:monospace; vertical-align:top; padding-top:8px; width:60px;">${f.count}</td>
                                <td style="text-align:right; color:#888; font-size:0.85em; font-family:monospace; vertical-align:top; padding-top:8px; width:90px;">${f.size}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>`;

            html += createCard(category, icon, tableContent, `${info.total_count} files • ${info.total_size}`);
        }

        bodyEl.innerHTML = html + `<button class="btn-refresh" onclick="refreshLibrary()">🔄 Re-scan Libraries</button>`;
    } catch (e) {
        console.error(e);
        bodyEl.innerHTML = "❌ Failed to load status.";
    }
}


/* ============================================================
   CREDITS
   ============================================================ */

function renderCredits(titleEl, bodyEl) {
    titleEl.innerHTML = "📜 Credits";

    const header = `
        <div style="text-align:center; padding:10px 0;">
            <div style="font-size:3.5em; margin-bottom:10px;">📸</div>
            <h2 style="margin:5px 0; color:#50fa7b; letter-spacing:1px;">Daro Porto</h2>
            <p style="color:#aaa; font-size:0.95em; font-style:italic;">"Let's Celebrate Your Photo Memory."</p>
        </div>`;

    const devContent = `
        <div style="line-height:1.8;">
            <div><span style="color:#50fa7b">🧑‍💼</span> <b>Name:</b> Darong Ma</div>
            <div><span style="color:#50fa7b">📧</span> <b>Email:</b> <a href="mailto:darongma@yahoo.com" style="color:#8be9fd; text-decoration:none;">darongma@yahoo.com</a></div>
            <div><span style="color:#50fa7b">🌐</span> <b>Web:</b> <a href="https://darongma.com" target="_blank" style="color:#8be9fd; text-decoration:none;">darongma.com</a></div>
        </div>`;

    const gitContent = `
        <div style="line-height:1.6;">
            <div style="margin-bottom:8px;"><b>GitHub:</b> <a href="#" style="color:#ff79c6; text-decoration:none;">github.com/darongma/daro-porto</a></div>
            <p style="font-size:0.85em; color:#888; margin:0;">⭐ Star the project if it brings joy to your home!</p>
        </div>`;

    const techContent = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; font-size:0.8em;">
            ${["⚡ FastAPI", "🎨 Vanilla CSS", "🐍 Python 3.12", "⛓️‍💥 Javascript"].map(t =>
                `<div class="stat-item" style="padding:8px; background:rgba(255,255,255,0.05); border-radius:8px;">${t}</div>`
            ).join('')}
        </div>`;

    bodyEl.innerHTML = `
        ${createCard("Our Project",     "✨",  header)}
        ${createCard("The Creator",     "👨‍💻", devContent)}
        ${createCard("Source Code",     "📦",  gitContent)}
        ${createCard("Engineered With", "🛠️",  techContent)}
        <div style="text-align:center; margin-top:30px; padding-bottom:10px;">
            <div style="color:#ff5555; font-size:1.5em; margin-bottom:5px;">❤️</div>
            <div style="color:#eee; font-weight:500;">Built With Love For Portal Display</div>
            <div style="color:#444; font-size:0.75em; margin-top:10px;">Version 1.0.0 • © 2026 Darong Ma</div>
        </div>
    `;
}