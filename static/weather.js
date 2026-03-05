// =============================================================================
// weather.js — Weather config, splash location setup, forecast, clock,
//              calendar, and lunar date calculations
// =============================================================================


/* ============================================================
   WEATHER CONFIG (localStorage)
   ============================================================ */

const WEATHER_DEFAULTS = { unit: 'F', frequency: 6 };

function getWeatherConfig() {
    try {
        const raw = localStorage.getItem('weather');
        return raw ? { ...WEATHER_DEFAULTS, ...JSON.parse(raw) } : null;
    } catch (e) { return null; }
}

function saveWeatherConfig(obj) {
    const existing = getWeatherConfig() || {};
    const merged   = { ...WEATHER_DEFAULTS, ...existing, ...obj };
    localStorage.setItem('weather', JSON.stringify(merged));
    return merged;
}


/* ============================================================
   SPLASH LOCATION
   ============================================================ */

function initSplashLocation() {
    const saved = getWeatherConfig();
    if (saved && saved.lat) {
        document.getElementById('splash-city-name').textContent    = saved.city;
        document.getElementById('splash-unit-display').textContent = saved.unit === 'C' ? '°C Celsius' : '°F Fahrenheit';
        document.getElementById('splash-freq-display').textContent = saved.frequency + 'h refresh';
        document.getElementById('splash-location-saved').style.display = 'block';
    } else {
        document.getElementById('splash-location-input').style.display = 'block';
    }
}

function showLocationInput() {
    const saved = getWeatherConfig();
    document.getElementById('splash-location-saved').style.display = 'none';
    if (saved) {
        document.getElementById('splash-unit-select').value = saved.unit      || 'F';
        document.getElementById('splash-freq-select').value = saved.frequency || 6;
    }
    document.getElementById('splash-location-input').style.display = 'block';
    document.getElementById('splash-zip-input').value              = '';
    document.getElementById('splash-location-error').style.display = 'none';
    setTimeout(() => document.getElementById('splash-zip-input').focus(), 100);
}

async function saveLocation() {
    const input     = document.getElementById('splash-zip-input').value.trim();
    const unit      = document.getElementById('splash-unit-select').value;
    const frequency = parseInt(document.getElementById('splash-freq-select').value, 10);
    const errorEl   = document.getElementById('splash-location-error');
    const loadingEl = document.getElementById('splash-location-loading');

    if (!input) {
        errorEl.textContent   = 'Please enter a ZIP code or city name.';
        errorEl.style.display = 'block';
        return;
    }

    errorEl.style.display   = 'none';
    loadingEl.style.display = 'block';

    let locationData = null;
    if (/^\d{5}$/.test(input)) locationData = await getCoordsFromZip(input);
    if (!locationData)          locationData = await getCoordsFromCity(input);

    loadingEl.style.display = 'none';

    if (!locationData) {
        errorEl.textContent   = '❌ Could not find that location. Try a ZIP code or "City, State".';
        errorEl.style.display = 'block';
        return;
    }

    const saved = saveWeatherConfig({ ...locationData, unit, frequency });
    console.log('🌤️ Weather config saved:', saved);

    document.getElementById('splash-city-name').textContent    = saved.city;
    document.getElementById('splash-unit-display').textContent = saved.unit === 'C' ? '°C Celsius' : '°F Fahrenheit';
    document.getElementById('splash-freq-display').textContent = saved.frequency + 'h refresh';
    document.getElementById('splash-location-input').style.display = 'none';
    document.getElementById('splash-location-saved').style.display = 'block';
}

// Called by the "Skip & Enter" button.
// If the user typed a location, attempt to look it up and save it first,
// then start the app regardless of whether the lookup succeeded.
async function skipAndEnter() {
    const input = document.getElementById('splash-zip-input').value.trim();
    if (input) {
        const unit      = document.getElementById('splash-unit-select').value;
        const frequency = parseInt(document.getElementById('splash-freq-select').value, 10);
        const loadingEl = document.getElementById('splash-location-loading');
        const errorEl   = document.getElementById('splash-location-error');

        errorEl.style.display   = 'none';
        loadingEl.style.display = 'block';

        let locationData = null;
        if (/^\d{5}$/.test(input)) locationData = await getCoordsFromZip(input);
        if (!locationData)          locationData = await getCoordsFromCity(input);

        loadingEl.style.display = 'none';

        if (locationData) {
            saveWeatherConfig({ ...locationData, unit, frequency });
            console.log('🌤️ Location saved on skip:', locationData);
        } else {
            console.warn('🌤️ Could not resolve location on skip — continuing without it.');
        }
    }
    startApp();
}

async function getCoordsFromZip(zip) {
    try {
        const response = await fetch(`https://api.zippopotam.us/us/${zip}`);
        if (!response.ok) return null;
        const data  = await response.json();
        const place = data.places[0];
        return { lat: place['latitude'], lon: place['longitude'], city: place['place name'] };
    } catch (e) {
        console.error("ZIP API Error:", e);
        return null;
    }
}

async function getCoordsFromCity(cityInput) {
    try {
        const encoded = encodeURIComponent(cityInput);
        const res     = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encoded}&count=1&language=en&format=json`);
        const data    = await res.json();
        if (!data.results || data.results.length === 0) return null;
        const r    = data.results[0];
        const city = r.name + (r.admin1 ? `, ${r.admin1}` : '');
        return { lat: r.latitude, lon: r.longitude, city };
    } catch (e) {
        console.error('City geocoding error:', e);
        return null;
    }
}


/* ============================================================
   WEATHER SERVICE
   ============================================================ */

let weatherIntervalId = null;

function startWeatherService() {
    if (weatherIntervalId) clearInterval(weatherIntervalId);
    fetchWeather();
    const wCfg  = getWeatherConfig();
    const hours = (wCfg && wCfg.frequency) ? wCfg.frequency : WEATHER_DEFAULTS.frequency;
    const ms    = hours * 60 * 60 * 1000;
    weatherIntervalId = setInterval(() => {
        console.log(`🌤️ Refreshing weather (every ${hours}h)...`);
        fetchWeather();
    }, ms);
}

async function fetchWeather() {
    const wCfg = getWeatherConfig();
    const lat  = wCfg?.lat  ?? 34.00;
    const lon  = wCfg?.lon  ?? -117.85;
    const city = wCfg?.city ?? "Walnut";
    const unit = wCfg?.unit ?? 'F';

    try {
        const res = await fetch(
            `https://api.open-meteo.com/v1/forecast` +
            `?latitude=${lat}&longitude=${lon}` +
            `&current_weather=true` +
            `&daily=weathercode,temperature_2m_max,temperature_2m_min` +
            `&temperature_unit=${unit === 'C' ? 'celsius' : 'fahrenheit'}` +
            `&timezone=auto` +
            `&past_days=1` +
            `&forecast_days=7`
        );
        const data    = await res.json();
        const cw      = data.current_weather;
        const tempNow = Math.round(cw.temperature);
        const emoji   = weatherEmoji(cw.weathercode, cw.is_day);

        document.getElementById('weather').innerHTML = `${emoji} ${tempNow}°${unit} in ${city}`;
        renderForecast(data.daily, unit);

    } catch (e) {
        document.getElementById('weather').innerText = "Weather Error";
    }
}

function weatherEmoji(code, isDay = 1) {
    if (code === 0)  return isDay ? '☀️' : '🌙';
    if (code <= 2)   return isDay ? '⛅' : '🌙';
    if (code === 3)  return '☁️';
    if (code <= 49)  return '🌫️';
    if (code <= 59)  return '🌦️';
    if (code <= 69)  return '🌧️';
    if (code <= 79)  return '❄️';
    if (code <= 84)  return '🌧️';
    if (code <= 86)  return '🌨️';
    if (code <= 99)  return '⛈️';
    return '🌡️';
}

function renderForecast(daily, unit) {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const el   = document.getElementById('weather-forecast');
    if (!el) return;

    el.innerHTML = daily.time.map((dateStr, i) => {
        const d    = new Date(dateStr + 'T12:00:00');
        const name = i === 0 ? 'Yesterday' : i === 1 ? 'Today' : days[d.getDay()];
        const hi   = Math.round(daily.temperature_2m_max[i]);
        const lo   = Math.round(daily.temperature_2m_min[i]);
        const icon = weatherEmoji(daily.weathercode[i], 1);
        const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `
            <div class="forecast-day">
                <span class="forecast-label">${name}</span>
                <span class="forecast-icon">${icon}</span>
                <span class="forecast-hi">${hi}°</span>
                <span class="forecast-lo">${lo}°</span>
                <span class="forecast-date">${date}</span>
            </div>`;
    }).join('');
}

function toggleForecast() {
    document.getElementById('weather-forecast').classList.toggle('forecast-visible');
}

function toggleCalendar() {
    const el = document.getElementById('calendar-widget');
    if (el.classList.toggle('calendar-visible')) renderCalendar();
}


/* ============================================================
   CLOCK
   ============================================================ */

function startClock() {
    const update = () => {
        const now = new Date();
        document.getElementById('clock').innerText = now.toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit'
        });
        document.getElementById('date').innerText = now.toLocaleDateString([], {
            weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
        });
    };
    update();
    setInterval(update, 1000);
}


/* ============================================================
   CALENDAR
   ============================================================ */

function renderCalendar() {
    const el          = document.getElementById('calendar-widget');
    const now         = new Date();
    const year        = now.getFullYear();
    const month       = now.getMonth();
    const today       = now.getDate();
    const monthName   = now.toLocaleDateString([], { month: 'long', year: 'numeric' });
    const firstDay    = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const headers = ['Su','Mo','Tu','We','Th','Fr','Sa']
        .map(d => `<span class="cal-header">${d}</span>`).join('');

    let cells = Array(firstDay).fill(`<span></span>`);
    for (let d = 1; d <= daysInMonth; d++) {
        const isToday = d === today;
        const lunar   = getLunarDate(new Date(year, month, d));
        cells.push(`
            <span class="cal-day ${isToday ? 'cal-today' : ''}">
                <span class="cal-solar">${d}</span>
                <span class="cal-lunar">${lunar}</span>
            </span>`);
    }

    el.innerHTML = `
        <div class="cal-month">${monthName}</div>
        <div class="cal-grid">${headers}${cells.join('')}</div>
    `;
}


/* ============================================================
   LUNAR DATE DATA & CALCULATION
   ============================================================ */

// Exact new moon dates — [year, month(0-based), day]
const LUNAR_NEW_MOONS = [
    // 2020
    [2020,0,25],[2020,1,23],[2020,2,24],[2020,3,23],[2020,4,23],
    [2020,5,21],[2020,6,21],[2020,7,19],[2020,8,17],[2020,9,17],
    [2020,10,15],[2020,11,15],
    // 2021
    [2021,0,13],[2021,1,12],[2021,2,13],[2021,3,12],[2021,4,11],
    [2021,5,10],[2021,6,10],[2021,7,8],[2021,8,7],[2021,9,6],
    [2021,10,5],[2021,11,4],
    // 2022
    [2022,0,3],[2022,1,1],[2022,2,3],[2022,3,1],[2022,3,30],
    [2022,4,30],[2022,5,29],[2022,6,28],[2022,7,27],[2022,8,25],
    [2022,9,25],[2022,10,24],[2022,11,23],
    // 2023
    [2023,0,22],[2023,1,20],[2023,2,22],[2023,3,20],[2023,4,19],
    [2023,5,18],[2023,6,17],[2023,7,16],[2023,8,15],[2023,9,14],
    [2023,10,13],[2023,11,13],
    // 2024
    [2024,0,11],[2024,1,10],[2024,2,10],[2024,3,8],[2024,4,8],
    [2024,5,6],[2024,6,5],[2024,7,4],[2024,8,3],[2024,9,2],
    [2024,10,1],[2024,10,30],[2024,11,30],
    // 2025
    [2025,0,29],[2025,1,28],[2025,2,29],[2025,3,27],[2025,4,27],
    [2025,5,25],[2025,6,24],[2025,7,23],[2025,8,21],[2025,9,21],
    [2025,10,20],[2025,11,20],
    // 2026
    [2026,0,18],[2026,1,17],[2026,2,19],[2026,3,17],[2026,4,16],
    [2026,5,15],[2026,6,14],[2026,7,12],[2026,8,11],[2026,9,10],
    [2026,10,9],[2026,11,9],
    // 2027
    [2027,0,7],[2027,1,6],[2027,2,8],[2027,3,6],[2027,4,6],
    [2027,5,4],[2027,6,4],[2027,7,2],[2027,8,1],[2027,8,30],
    [2027,9,29],[2027,10,28],[2027,11,28],
    // 2028
    [2028,0,26],[2028,1,25],[2028,2,25],[2028,3,24],[2028,4,23],
    [2028,5,21],[2028,6,21],[2028,7,19],[2028,8,17],[2028,9,17],
    [2028,10,15],[2028,11,15],
    // 2029
    [2029,0,13],[2029,1,12],[2029,2,13],[2029,3,12],[2029,4,11],
    [2029,5,9],[2029,6,9],[2029,7,7],[2029,8,6],[2029,9,5],
    [2029,10,4],[2029,11,3],
    // 2030
    [2030,0,3],[2030,1,1],[2030,2,3],[2030,3,1],[2030,3,30],
    [2030,4,29],[2030,5,28],[2030,6,27],[2030,7,26],[2030,8,24],
    [2030,9,23],[2030,10,22],[2030,11,22],
];

const LUNAR_MONTH_NAMES = ['正','二','三','四','五','六','七','八','九','十','冬','腊'];

const LUNAR_DAY_NAMES = [
    '初一','初二','初三','初四','初五','初六','初七','初八','初九','初十',
    '十一','十二','十三','十四','十五','十六','十七','十八','十九','二十',
    '廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十'
];

const LUNAR_MONTH_SEQUENCE = [
    // 2020
    {m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},{m:3,l:false},
    {m:4,l:false},{m:4,l:true},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:9,l:false},
    // 2021
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:9,l:false},
    // 2022
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:2,l:true},{m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},
    {m:7,l:false},{m:8,l:false},{m:9,l:false},
    // 2023
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:9,l:false},
    // 2024
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:8,l:true},{m:9,l:false},
    // 2025
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:9,l:false},
    // 2026
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:9,l:false},
    // 2027
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:6,l:true},
    {m:7,l:false},{m:8,l:false},{m:9,l:false},
    // 2028
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:9,l:false},
    // 2029
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},{m:7,l:false},
    {m:8,l:false},{m:9,l:false},
    // 2030
    {m:10,l:false},{m:11,l:false},{m:0,l:false},{m:1,l:false},{m:2,l:false},
    {m:2,l:true},{m:3,l:false},{m:4,l:false},{m:5,l:false},{m:6,l:false},
    {m:7,l:false},{m:8,l:false},{m:9,l:false},
];

function getLunarDate(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let idx = 0;
    for (let i = 0; i < LUNAR_NEW_MOONS.length - 1; i++) {
        const start = new Date(LUNAR_NEW_MOONS[i][0],   LUNAR_NEW_MOONS[i][1],   LUNAR_NEW_MOONS[i][2]);
        const next  = new Date(LUNAR_NEW_MOONS[i+1][0], LUNAR_NEW_MOONS[i+1][1], LUNAR_NEW_MOONS[i+1][2]);
        if (d >= start && d < next) { idx = i; break; }
    }
    const start     = new Date(LUNAR_NEW_MOONS[idx][0], LUNAR_NEW_MOONS[idx][1], LUNAR_NEW_MOONS[idx][2]);
    const lunarDay  = Math.round((d - start) / 86400000);
    const seq       = LUNAR_MONTH_SEQUENCE[idx];
    const monthName = (seq.l ? '閏' : '') + LUNAR_MONTH_NAMES[seq.m];
    if (lunarDay === 0) return monthName;
    return LUNAR_DAY_NAMES[lunarDay];
}