import re
import httpx
from pathlib import Path
from config import show_message

BASE_DIR = Path(__file__).parent
LYRICS_DIR = BASE_DIR / "lyrics"
LYRICS_DIR.mkdir(exist_ok=True)

http_client = httpx.AsyncClient()


# =============================================================================
# CLEANING HELPERS
# =============================================================================

# ── Unicode / character normalization ────────────────────────────────────────

# Fullwidth ASCII → regular ASCII  (ｅ→e, Ａ→A, （→(, ）→) …)
_FULLWIDTH_RE = re.compile(r'[\uff01-\uff5e]')

def _normalize_unicode(text: str) -> str:
    """
    Normalize Unicode quirks that confuse lyric APIs:
      - Fullwidth ASCII characters → standard ASCII
      - Smart / curly quotes → straight quotes
      - Em-dash, en-dash → hyphen
      - Non-breaking space, thin space, etc. → regular space
      - Accented Latin characters → base ASCII equivalents (é→e, ü→u …)
        so APIs that only index ASCII spellings still match.
    """
    import unicodedata

    # Fullwidth ASCII block (！ → !, ｅ → e, etc.)
    text = _FULLWIDTH_RE.sub(lambda m: chr(ord(m.group()) - 0xFEE0), text)

    # Smart quotes → straight
    text = text.replace('\u2018', "'").replace('\u2019', "'")   # ' '
    text = text.replace('\u201c', '"').replace('\u201d', '"')   # " "
    text = text.replace('\u2032', "'").replace('\u2033', '"')   # ′ ″

    # Dashes → hyphen
    text = text.replace('\u2014', '-').replace('\u2013', '-')   # — –
    text = text.replace('\u2012', '-').replace('\u2015', '-')

    # Various spaces → regular space
    text = re.sub(r'[\u00a0\u200b\u200c\u200d\u2009\u202f\u3000]', ' ', text)

    # Decompose accents (NFD), then strip combining diacritical marks,
    # then recompose.  é → e, ü → u, ñ → n, etc.
    nfd = unicodedata.normalize('NFD', text)
    text = ''.join(c for c in nfd if unicodedata.category(c) != 'Mn')
    text = unicodedata.normalize('NFC', text)

    return text


def _normalize_caps(text: str) -> str:
    """Title-case an ALL-CAPS string; leave mixed-case strings alone."""
    if text == text.upper() and re.search(r'[A-Z]{2,}', text):
        return text.title()
    return text


# ── Artist cleaning ───────────────────────────────────────────────────────────

# Separators used to join multiple artists in one field
_ARTIST_SEP_RE    = re.compile(r'[/&‧·•,;|]+')
# feat / ft / with / and (as collaborator marker)
_FEAT_IN_ARTIST   = re.compile(r'\s+(?:feat(?:uring)?|ft|with)\.?\s+.*$', re.IGNORECASE)
# "Artist (US)" / "Artist (UK)" / "Artist (band)" disambiguation suffixes
_DISAMBIG_PAREN   = re.compile(r'\s*\([A-Z]{2,4}\)$')
# "The " leading article — stored as variant, not stripped outright
_THE_PREFIX       = re.compile(r'^the\s+', re.IGNORECASE)
# Inline punctuation that's stylistic but breaks lookups: P!nk → Pink, Panic! → Panic
_STYLISTIC_PUNCT  = re.compile(r'(?<=[A-Za-z])[!?@#$%^*](?=[A-Za-z\s])')
# CJK Unicode ranges used throughout
_CJK_RE  = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\uac00-\ud7af]')
_HAS_CJK  = lambda s: bool(_CJK_RE.search(s))
_HAS_LAT  = lambda s: bool(re.search(r'[A-Za-z]', s))


def clean_artist_name(artist: str) -> list[str]:
    """
    Returns a prioritised list of artist name candidates to try, most specific first.

    Industry-standard handling:
    - Multi-artist strings (/, &, ‧, ,, ;, |) → primary artist only
    - feat / ft / with suffixes in the artist field
    - Disambiguation parentheticals like "Artist (US)"
    - Stylistic punctuation: P!nk → Pink, Panic! at the Disco → Panic at the Disco
    - "The" article: tries both "The Beatles" and "Beatles"
    - ALL CAPS → Title Case
    - Accent/diacritic normalisation: Beyoncé → Beyonce, Björk → Bjork
    - Bilingual names (CJK + Latin): tries full name, CJK half, Latin half
    """
    if not artist:
        return []

    artist = _normalize_unicode(artist.strip())

    # Primary artist: take only the first segment
    primary = _ARTIST_SEP_RE.split(artist)[0].strip()

    # Strip feat/ft/with
    primary = _FEAT_IN_ARTIST.sub('', primary).strip()

    # Strip disambiguation: "Artist (US)" → "Artist"
    primary = _DISAMBIG_PAREN.sub('', primary).strip()

    # Remove stylistic punctuation in the *middle* of a name (P!nk → Pnk, Panic! → Panic)
    # Also add a version with all non-alphanumeric-non-space stripped entirely
    primary_clean = _STYLISTIC_PUNCT.sub('', primary).strip()
    # For names like "P!nk" where removing ! gives "Pnk" (wrong), also try
    # replacing the stylistic char with the *following* vowel's absence resolved —
    # simplest: try a fully punctuation-stripped version as an extra candidate
    primary_alphanum = re.sub(r'[^\w\s]', '', primary, flags=re.UNICODE).strip()

    # Normalise ALL CAPS
    primary_clean   = _normalize_caps(primary_clean)
    primary_alphanum = _normalize_caps(primary_alphanum)

    candidates = []

    def _add(c):
        c = c.strip(" .,;-–")
        if c and len(c) > 1:
            candidates.append(c)

    _add(primary_clean)
    if primary_alphanum and primary_alphanum.lower() != primary_clean.lower():
        _add(primary_alphanum)   # e.g. "Pink" as fallback for "P!nk" → "Pnk"
    if primary_clean != primary:
        _add(primary)   # original as fallback

    # "The" article variant: add both "The X" and "X"
    if _THE_PREFIX.match(primary_clean):
        _add(_THE_PREFIX.sub('', primary_clean).strip())
    elif not _THE_PREFIX.match(primary_clean) and _HAS_LAT(primary_clean) and not _HAS_CJK(primary_clean):
        # Don't blindly prepend "The", but do try stripped version for
        # names where "The" might have been in the tags unexpectedly
        pass

    # Accent-stripped variant (Beyoncé → Beyonce already done by normalize_unicode)
    # normalize_unicode handles this; nothing extra needed here.

    # Bilingual split: "原始和聲 Raw Harmony" → try each script half
    if _HAS_CJK(primary_clean) and _HAS_LAT(primary_clean):
        cjk_part = re.sub(r'[A-Za-z0-9\s&\-]+', ' ', primary_clean)
        cjk_part = re.sub(r'\s{2,}', ' ', cjk_part).strip()

        lat_part = _CJK_RE.sub(' ', primary_clean)
        lat_part = re.sub(r'\s{2,}', ' ', lat_part).strip()

        if cjk_part and cjk_part != primary_clean: _add(cjk_part)
        if lat_part  and lat_part  != primary_clean: _add(lat_part)

    # De-duplicate preserving order
    seen, unique = set(), []
    for c in candidates:
        key = c.lower()
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique


# ── Title cleaning ────────────────────────────────────────────────────────────

# All patterns stripped from titles — ordered from most specific to most general
# so earlier patterns don't accidentally prevent later ones from matching.
_TITLE_NOISE = [
    # ── Square-bracket annotations ─────────────────────────────────────────
    r'\s*\[\s*(?:remaster(?:ed)?|reissue|explicit|clean|deluxe|bonus|mono|stereo)[^\]]*\]',
    r'\s*\[\s*\d{4}[^\]]*\]',          # [2011 Remaster], [2023]
    r'\s*\[\s*[^\]]{1,30}\]',          # any short bracket annotation

    # ── Remaster / edition (after dash) ───────────────────────────────────
    r'\s*[-–]\s*(?:\d{4}\s+)?remaster(?:ed)?\b.*$',
    r'\s*[-–]\s*remaster(?:ed)?\s*\d{0,4}.*$',
    r'\s*[-–]\s*(?:super\s+)?deluxe(?:\s+edition)?\b.*$',
    r'\s*[-–]\s*(?:\d+(?:st|nd|rd|th)\s+)?anniversary(?:\s+edition)?\b.*$',
    r'\s*[-–]\s*(?:expanded|special|collector[\'s]*|limited)\s+edition\b.*$',
    r'\s*[-–]\s*bonus\s+track\b.*$',
    r'\s*[-–]\s*\d{4}\s+(?:mix|version|edition|reissue)\b.*$',

    # ── Remaster / edition (in parentheses) ───────────────────────────────
    r'\s*\(\s*(?:\d{4}\s+)?remaster(?:ed)?[^)]*\)',
    r'\s*\(\s*(?:super\s+)?deluxe[^)]*\)',
    r'\s*\(\s*(?:\d+(?:st|nd|rd|th)\s+)?anniversary[^)]*\)',
    r'\s*\(\s*(?:expanded|special|collector[\'s]*|limited)\s+edition[^)]*\)',
    r'\s*\(\s*bonus\s+track[^)]*\)',
    r'\s*\(\s*explicit(?:\s+version)?[^)]*\)',
    r'\s*\(\s*clean(?:\s+version)?[^)]*\)',
    r'\s*\(\s*mono[^)]*\)',
    r'\s*\(\s*stereo[^)]*\)',

    # ── Live / acoustic / demo (after dash) ───────────────────────────────
    r'\s*[-–]\s*live\b.*$',
    r'\s*[-–]\s*acoustic\b.*$',
    r'\s*[-–]\s*demo\b.*$',
    r'\s*[-–]\s*instrumental\b.*$',
    r'\s*[-–]\s*a\s+cappella\b.*$',
    r'\s*[-–]\s*live\s+(?:from|at|@|in)\b.*$',
    r'\s*[-–]\s*recorded\s+live\b.*$',

    # ── Version tags (after dash) ──────────────────────────────────────────
    r'\s*[-–]\s*(?:radio|single|album|studio|extended|original|official)\s+(?:edit|version|mix|ver\.?)\b.*$',
    r'\s*[-–]\s*\w+\s+version\b.*$',
    r'\s*[-–]\s*\w+\s+ver\.\b.*$',
    r'\s*[-–]\s*\w+\s+edit\b.*$',
    r'\s*[-–]\s*\w+\s+mix\b.*$',
    r'\s*[-–]\s*\d{4}.*$',            # "- 2025" or "- Live 2025"

    # ── Live / acoustic / demo (in parentheses) ────────────────────────────
    r'\s*\(\s*live\b[^)]*\)',
    r'\s*\(\s*acoustic[^)]*\)',
    r'\s*\(\s*demo\b[^)]*\)',
    r'\s*\(\s*instrumental\b[^)]*\)',
    r'\s*\(\s*a\s+cappella[^)]*\)',
    r'\s*\(\s*recorded\s+live[^)]*\)',

    # ── Version tags (in parentheses) ─────────────────────────────────────
    r'\s*\(\s*(?:radio|single|album|studio|extended|original|official)\s+(?:edit|version|mix|ver\.?)[^)]*\)',
    r'\s*\(\s*\w+\s+version[^)]*\)',
    r'\s*\(\s*\w+\s+ver\.[^)]*\)',
    r'\s*\(\s*\w+\s+edit[^)]*\)',
    r'\s*\(\s*\w+\s+mix[^)]*\)',
    r'\s*\(\s*edit\b[^)]*\)',          # just "(Edit)"

    # ── Country / region / market tags ────────────────────────────────────
    r'\s*\(\s*(?:japan|japanese|uk|us|usa|europe|aus|australia|korea)[^)]*\)',
    r'\s*[-–]\s*(?:japan|japanese|uk|us|usa|europe|aus|australia|korea)\s+(?:edition|version|bonus|release)\b.*$',

    # ── feat / ft / with inside the title ─────────────────────────────────
    r'\s*\(\s*feat(?:uring)?\.?\s+[^)]+\)',
    r'\s*\(\s*ft\.?\s+[^)]+\)',
    r'\s*feat(?:uring)?\.?\s+[^(\[]+$',   # trailing "feat. Artist" without parens
    r'\s*ft\.?\s+[^(\[]+$',

    # ── Track-number prefixes baked into the title field ──────────────────
    r'^\d{1,3}[.\-\s]\s*(?=[^\d])',        # "01 Title", "12. Title", "3 - Title"
]

_LONG_PAREN_RE = re.compile(r'\s*\(([^)]{1,})\)')


def _strip_album_parens(title: str) -> str:
    """
    Remove parentheticals that are album/series context, not part of the song name.
    Heuristic: >40% CJK content OR content longer than 12 chars that looks like
    an album/series name (contains numbers or series keywords).
    Short English descriptors like "(Live)" are left for the pattern list.
    """
    def replacer(m):
        content = m.group(1)
        cjk_ratio = len(re.findall(r'[\u4e00-\u9fff\u3400-\u4dbf]', content)) / max(len(content), 1)
        if cjk_ratio > 0.4:
            return ''
        # Long English parentheticals that look like album/edition context
        if len(content) > 12 and re.search(
            r'\b(?:edition|vol(?:ume)?|series|album|ep|lp|disc|season|\d{4})\b',
            content, re.IGNORECASE
        ):
            return ''
        return m.group(0)
    return _LONG_PAREN_RE.sub(replacer, title).strip()


def _apply_strip_patterns(title: str) -> str:
    t = _strip_album_parens(title)
    for pattern in _TITLE_NOISE:
        t = re.sub(pattern, '', t, flags=re.IGNORECASE)
    return t.strip(" -–[]")


def clean_title(title: str) -> list[str]:
    """
    Returns a prioritised list of title candidates to try, most specific first.

    Industry-standard handling:
    - Remaster / Deluxe / Anniversary / Bonus Track annotations
    - Live / Acoustic / Demo / Instrumental suffixes (dash or parenthetical)
    - Version tags: Radio Edit, Single Version, Album Version, Extended Mix …
    - Track-number prefixes: "01 Title", "12. Title"
    - feat / ft inside the title
    - Country/region market tags: (Japan Edition), [2023]
    - "/" medley splits: "Song A / Song B" → tries each half
    - ALL CAPS → Title Case
    - Bilingual (CJK + Latin): tries CJK-only and Latin-only halves
    - Accent / special-char normalisation via _normalize_unicode
    - Fullwidth characters
    """
    if not title:
        return []

    # Always normalise unicode first
    title = _normalize_unicode(title.strip())
    title = _normalize_caps(title)

    candidates = [title]

    # Primary cleaned version
    cleaned = _apply_strip_patterns(title)
    if cleaned and cleaned.lower() != title.lower():
        candidates.append(cleaned)

    # Medley / double-title splits on " / " or " // "
    for source in (title, cleaned):
        if re.search(r'\s[/]{1,2}\s', source):
            for part in re.split(r'\s[/]{1,2}\s', source):
                part = _apply_strip_patterns(part.strip())
                if part:
                    candidates.append(part)

    # Bilingual split — use the fully-cleaned, suffix-free base
    # e.g. "晨禱 Morning Prayer" → ["晨禱", "Morning Prayer"]
    base = re.sub(r'\s*[-–]\s*[A-Za-z].*$', '', cleaned).strip()
    base = _strip_album_parens(base)
    if _HAS_CJK(base) and _HAS_LAT(base):
        cjk_part = re.sub(r'[A-Za-z0-9\s&\-/()]+', ' ', base)
        cjk_part = re.sub(r'\s{2,}', ' ', cjk_part).strip()
        lat_part  = _CJK_RE.sub(' ', base)
        lat_part  = re.sub(r'\s{2,}', ' ', lat_part).strip()
        if cjk_part: candidates.append(cjk_part)
        if lat_part:  candidates.append(lat_part)

    # De-duplicate preserving order; drop very short or punctuation-only fragments
    seen, unique = set(), []
    for c in candidates:
        c = c.strip(" .,;-–[]")
        key = c.lower()
        if key and len(key) > 1 and key not in seen:
            seen.add(key)
            unique.append(c)
    return unique


# =============================================================================
# MAIN WATERFALL
# =============================================================================

async def fetch_lyrics_waterfall(artist: str, title: str, name: str = None):
    # Filename logic (unchanged)
    if name:
        file_base = name
    else:
        safe_str  = f"{artist}_{title}"
        file_base = "".join([c if c.isalnum() or c in "._-" else "_" for c in safe_str]).lower()

    lrc_path = LYRICS_DIR / f"{file_base}.lrc"
    txt_path = LYRICS_DIR / f"{file_base}.txt"

    # --- TIER 0: Local Cache ---
    if lrc_path.exists():
        show_message(f"Lyrics Found: Local LRC {lrc_path.name}")
        return {"lyrics": lrc_path.read_text(encoding="utf-8"), "type": "synced"}
    if txt_path.exists():
        show_message(f"Lyrics Found: Local TXT {txt_path.name}")
        return {"lyrics": txt_path.read_text(encoding="utf-8"), "type": "static"}

    # Build candidate pairs, ordered best-guess first:
    #   pair[0] = (primary_artist, primary_title)  ← most likely to succeed
    #   pair[1] = (primary_artist, cleaned_title)
    #   pair[2] = (alt_artist,     primary_title)   etc.
    # We interleave artist and title variants so the best combo is always tried first.
    artist_candidates = clean_artist_name(artist)   # e.g. up to 3
    title_candidates  = clean_title(title)          # e.g. up to 5

    # Build pairs: walk diagonally through the candidate grid so
    # (best_artist, best_title) comes first, then (best_artist, title2),
    # (artist2, best_title), (best_artist, title3) ... etc.
    # This keeps early pairs high-confidence without needing all combos.
    pairs = []
    seen_pairs = set()
    max_a = len(artist_candidates)
    max_t = len(title_candidates)
    for i in range(max(max_a, max_t)):
        for ai in range(min(i + 1, max_a)):
            ti = i - ai
            if 0 <= ti < max_t:
                key = (artist_candidates[ai], title_candidates[ti])
                if key not in seen_pairs:
                    seen_pairs.add(key)
                    pairs.append(key)

    # Hard cap: never make more than MAX_REQUESTS total for one song.
    # Each pair costs 3 requests (one per tier), so cap pairs accordingly.
    MAX_REQUESTS = 12   # e.g. 4 pairs × 3 tiers
    pairs = pairs[: MAX_REQUESTS // 3]

    show_message(f"🔍 Lyrics search — {len(pairs)} candidate pair(s) × 3 tiers "
                 f"(≤{len(pairs)*3} requests) for '{title}'")

    # --- MAIN LOOP: per-candidate, all tiers before next candidate ---
    async def _save_and_return(lyrics, lrc_type, label):
        path = lrc_path if lrc_type == "synced" else txt_path
        path.write_text(lyrics, encoding="utf-8")
        show_message(f"Lyrics Found: {label}")
        return {"lyrics": lyrics, "type": lrc_type}

    for a, t in pairs:
        # Tier 1: LRCLIB direct (exact lookup — cheapest, most precise)
        lyrics, lrc_type = await get_lrclib_lyrics(a, t)
        if lyrics:
            return await _save_and_return(lyrics, lrc_type, f"LRCLIB direct [{a} / {t}]")

        # Tier 2: NetEase (good for CJK tracks)
        netease_lrc = await get_netease_lyrics(a, t)
        if netease_lrc:
            lrc_path.write_text(netease_lrc, encoding="utf-8")
            show_message(f"Lyrics Found: NetEase [{a} / {t}]")
            return {"lyrics": netease_lrc, "type": "synced"}

        # Tier 3: LRCLIB fuzzy search (most expensive — try last per pair)
        lyrics, lrc_type = await get_lrclib_search(a, t)
        if lyrics:
            return await _save_and_return(lyrics, lrc_type, f"LRCLIB search [{a} / {t}]")

    show_message(f"NO LYRICS FOR '{title}' - '{artist}' "
                 f"(tried {len(pairs)*3} requests)")
    return {"lyrics": "No lyrics found.", "type": "none"}


# =============================================================================
# PROVIDER FUNCTIONS  (logic unchanged)
# =============================================================================

async def get_netease_lyrics(clean_artist: str, title: str):
    """Tier 2: NetEase with title-only fallback for niche tracks."""
    search_url = "https://music.163.com/api/search/get/web"

    async def perform_search(query: str):
        try:
            res = await http_client.get(
                search_url, params={"s": query, "type": 1, "limit": 3}, timeout=7.0
            )
            data = res.json()
            if isinstance(data, dict) and data.get("result", {}).get("songs"):
                return data["result"]["songs"]
        except Exception:
            pass
        return []

    songs = await perform_search(f"{title} {clean_artist}")
    if not songs:
        songs = await perform_search(title)
    if not songs:
        return None

    song_id = songs[0].get("id")
    try:
        lyric_res = await http_client.get(
            f"https://music.163.com/api/song/lyric?id={song_id}&lv=1", timeout=7.0
        )
        lrc_data = lyric_res.json()
        if isinstance(lrc_data, dict):
            return lrc_data.get("lrc", {}).get("lyric")
    except Exception:
        pass
    return None


async def get_lrclib_lyrics(clean_a: str, clean_t: str):
    """Tier 1: LRCLIB direct lookup."""
    try:
        res = await http_client.get(
            "https://lrclib.net/api/get",
            params={"artist_name": clean_a, "track_name": clean_t},
            timeout=7.0,
        )
        if res.status_code == 200:
            data = res.json()
            if isinstance(data, dict):
                lyrics   = data.get("syncedLyrics") or data.get("plainLyrics")
                lrc_type = "synced" if data.get("syncedLyrics") else "static"
                return lyrics, lrc_type
    except Exception:
        pass
    return None, None


async def get_lrclib_search(clean_a: str, clean_t: str):
    """Tier 3: LRCLIB fuzzy search."""
    try:
        res = await http_client.get(
            "https://lrclib.net/api/search",
            params={"q": f"{clean_a} {clean_t}"},
            timeout=7.0,
        )
        if res.status_code == 200:
            results = res.json()
            if isinstance(results, list) and results:
                best     = results[0]
                lyrics   = best.get("syncedLyrics") or best.get("plainLyrics")
                lrc_type = "synced" if best.get("syncedLyrics") else "static"
                return lyrics, lrc_type
    except Exception as e:
        show_message(f"LRCLIB Search Error: {repr(e)}")
    return None, None