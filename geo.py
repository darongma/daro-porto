import sqlite3
import math
import asyncio
import logging

# Use a separate database for geocoding to keep it portable
GEO_DB = "geocache.db"

# Precision=4 means ~11m grid cells — needed for road-level accuracy so that
# two photos on different streets don't share the same cached road name.
GEO_PRECISION = 4

# Chinese sub-city suffixes — if "city" ends with one of these, it's actually
# a district-level name and the real city may need to be injected.
CHINESE_DISTRICT_SUFFIXES = ("区", "镇", "街道", "乡", "县")

# Postcode prefix -> city name for Chinese cities where Nominatim omits the
# city entirely and only returns the district name in the "city" field.
#
# Key = first 3 digits of the 6-digit Chinese postcode
# Source: official China Post / verified city postcode ranges
#
# NOTE: Some large cities span multiple postcode prefixes (e.g. Beijing uses
# 100-102, Shanghai uses 200-202). All known prefixes are listed so any
# district within that city resolves correctly.
POSTCODE_TO_CITY = {
    # ── Direct-controlled municipalities ──────────────────────────────────
    "100": "北京市",
    "101": "北京市",
    "102": "北京市",

    "200": "上海市",
    "201": "上海市",
    "202": "上海市",

    "300": "天津市",
    "301": "天津市",
    "302": "天津市",

    "400": "重庆市",
    "401": "重庆市",
    "402": "重庆市",
    "404": "重庆市",
    "405": "重庆市",

    # ── Guangdong Province ─────────────────────────────────────────────────
    "510": "广州市",
    "511": "广州市",
    "512": "广州市",
    "513": "广州市",
    "514": "广州市",
    "515": "汕头市",
    "516": "惠州市",
    "517": "河源市",
    "518": "深圳市",
    "519": "东莞市",
    "521": "汕头市",
    "522": "揭阳市",
    "523": "东莞市",
    "524": "湛江市",
    "525": "茂名市",
    "526": "肇庆市",
    "527": "云浮市",
    "528": "佛山市",
    "529": "江门市",
    "536": "潮州市",
    "542": "珠海市",

    # ── Zhejiang Province ──────────────────────────────────────────────────
    "310": "杭州市",
    "311": "杭州市",
    "312": "绍兴市",
    "313": "湖州市",
    "314": "嘉兴市",
    "315": "宁波市",
    "316": "舟山市",
    "317": "舟山市",
    "318": "台州市",
    "321": "金华市",
    "322": "衢州市",
    "323": "丽水市",
    "325": "温州市",

    # ── Jiangsu Province ───────────────────────────────────────────────────
    "210": "南京市",
    "211": "南京市",
    "212": "镇江市",
    "213": "常州市",
    "214": "无锡市",
    "215": "苏州市",
    "216": "苏州市",
    "221": "徐州市",
    "222": "连云港市",
    "223": "淮安市",
    "224": "盐城市",
    "225": "扬州市",
    "226": "南通市",
    "227": "宿迁市",
    "228": "泰州市",

    # ── Sichuan Province ───────────────────────────────────────────────────
    "610": "成都市",
    "611": "成都市",
    "612": "成都市",
    "613": "自贡市",
    "614": "攀枝花市",
    "615": "宜宾市",
    "616": "泸州市",
    "617": "内江市",
    "618": "德阳市",
    "619": "绵阳市",
    "621": "绵阳市",
    "622": "广元市",
    "623": "达州市",
    "624": "雅安市",
    "625": "乐山市",
    "626": "眉山市",
    "627": "南充市",
    "628": "广安市",
    "629": "资阳市",

    # ── Shaanxi Province ───────────────────────────────────────────────────
    "710": "西安市",
    "711": "西安市",
    "712": "咸阳市",
    "713": "渭南市",
    "714": "渭南市",
    "715": "商洛市",
    "716": "汉中市",
    "717": "安康市",
    "718": "延安市",
    "719": "榆林市",
    "721": "宝鸡市",
    "722": "铜川市",

    # ── Hubei Province ─────────────────────────────────────────────────────
    "430": "武汉市",
    "431": "武汉市",
    "432": "孝感市",
    "433": "黄冈市",
    "434": "鄂州市",
    "435": "黄石市",
    "436": "咸宁市",
    "437": "荆州市",
    "438": "荆门市",
    "441": "襄阳市",
    "442": "十堰市",
    "443": "宜昌市",
    "445": "恩施土家族苗族自治州",

    # ── Hunan Province ─────────────────────────────────────────────────────
    "410": "长沙市",
    "411": "长沙市",
    "412": "株洲市",
    "413": "湘潭市",
    "414": "衡阳市",
    "415": "郴州市",
    "416": "岳阳市",
    "417": "常德市",
    "418": "益阳市",
    "419": "娄底市",
    "421": "邵阳市",
    "422": "怀化市",
    "423": "永州市",
    "427": "张家界市",
    "428": "湘西土家族苗族自治州",

    # ── Liaoning Province ──────────────────────────────────────────────────
    "110": "沈阳市",
    "111": "沈阳市",
    "112": "沈阳市",
    "113": "抚顺市",
    "114": "本溪市",
    "115": "辽阳市",
    "116": "大连市",
    "117": "大连市",
    "118": "丹东市",
    "119": "鞍山市",
    "121": "锦州市",
    "122": "营口市",
    "123": "盘锦市",
    "124": "铁岭市",
    "125": "朝阳市",
    "126": "阜新市",
    "129": "葫芦岛市",

    # ── Shandong Province ──────────────────────────────────────────────────
    "250": "济南市",
    "251": "济南市",
    "252": "聊城市",
    "253": "德州市",
    "255": "淄博市",
    "256": "滨州市",
    "257": "东营市",
    "261": "潍坊市",
    "262": "潍坊市",
    "264": "烟台市",
    "265": "烟台市",
    "266": "青岛市",
    "267": "青岛市",
    "268": "威海市",
    "271": "泰安市",
    "272": "济宁市",
    "273": "菏泽市",
    "276": "临沂市",
    "277": "枣庄市",

    # ── Henan Province ─────────────────────────────────────────────────────
    "450": "郑州市",
    "451": "郑州市",
    "452": "开封市",
    "453": "新乡市",
    "454": "焦作市",
    "455": "安阳市",
    "456": "鹤壁市",
    "457": "濮阳市",
    "461": "许昌市",
    "462": "漯河市",
    "463": "周口市",
    "464": "商丘市",
    "465": "驻马店市",
    "471": "洛阳市",
    "472": "三门峡市",
    "473": "平顶山市",
    "474": "南阳市",
    "475": "信阳市",

    # ── Fujian Province ────────────────────────────────────────────────────
    "350": "福州市",
    "351": "福州市",
    "352": "宁德市",
    "353": "南平市",
    "354": "三明市",
    "355": "莆田市",
    "356": "泉州市",
    "357": "漳州市",
    "358": "龙岩市",
    "361": "厦门市",
    "362": "泉州市",
    "363": "漳州市",

    # ── Yunnan Province ────────────────────────────────────────────────────
    "650": "昆明市",
    "651": "昆明市",
    "652": "曲靖市",
    "653": "玉溪市",
    "654": "楚雄彝族自治州",
    "655": "红河哈尼族彝族自治州",
    "661": "文山壮族苗族自治州",
    "665": "普洱市",
    "666": "西双版纳傣族自治州",
    "671": "大理白族自治州",
    "672": "保山市",
    "673": "德宏傣族景颇族自治州",
    "674": "怒江傈僳族自治州",
    "675": "迪庆藏族自治州",
    "676": "丽江市",
    "677": "临沧市",

    # ── Anhui Province ─────────────────────────────────────────────────────
    "230": "合肥市",
    "231": "合肥市",
    "232": "淮南市",
    "233": "蚌埠市",
    "234": "阜阳市",
    "235": "宿州市",
    "236": "亳州市",
    "237": "六安市",
    "238": "巢湖市",
    "241": "芜湖市",
    "242": "铜陵市",
    "243": "马鞍山市",
    "244": "安庆市",
    "245": "黄山市",
    "246": "池州市",
    "247": "宣城市",

    # ── Heilongjiang Province ──────────────────────────────────────────────
    "150": "哈尔滨市",
    "151": "哈尔滨市",
    "152": "绥化市",
    "153": "大庆市",
    "154": "齐齐哈尔市",
    "155": "黑河市",
    "156": "伊春市",
    "157": "鹤岗市",
    "158": "佳木斯市",
    "159": "双鸭山市",
    "161": "七台河市",
    "163": "大庆市",

    # ── Xinjiang Uyghur Autonomous Region ─────────────────────────────────
    "830": "乌鲁木齐市",
    "831": "乌鲁木齐市",
    "832": "昌吉回族自治州",
    "833": "伊犁哈萨克自治州",
    "834": "博尔塔拉蒙古自治州",
    "835": "伊犁哈萨克自治州",
    "836": "阿克苏地区",
    "838": "吐鲁番市",
    "839": "哈密市",
    "844": "喀什地区",
    "845": "克孜勒苏柯尔克孜自治州",
    "848": "和田地区",

    # ── Guangxi Zhuang Autonomous Region ──────────────────────────────────
    "530": "南宁市",
    "531": "南宁市",
    "532": "崇左市",
    "533": "百色市",
    "534": "河池市",
    "535": "柳州市",
    "537": "来宾市",
    "541": "桂林市",
    "543": "梧州市",
    "545": "贺州市",
    "546": "贵港市",
    "551": "北海市",

    # ── Tibet Autonomous Region ────────────────────────────────────────────
    "850": "拉萨市",
    "851": "拉萨市",
    "852": "山南市",
    "853": "日喀则市",
    "854": "那曲市",
    "855": "昌都市",
    "856": "林芝市",
    "857": "阿里地区",

    # ── Guizhou Province ───────────────────────────────────────────────────
    "550": "贵阳市",
    "551": "贵阳市",
    "552": "六盘水市",
    "553": "遵义市",
    "554": "安顺市",
    "555": "毕节市",
    "556": "铜仁市",
    "557": "黔东南苗族侗族自治州",
    "558": "黔南布依族苗族自治州",
    "559": "黔西南布依族苗族自治州",

    # ── Hainan Province ────────────────────────────────────────────────────
    "570": "海口市",
    "571": "海口市",
    "572": "文昌市",
    "573": "琼海市",
    "574": "万宁市",
    "575": "陵水黎族自治县",
    "576": "三亚市",
    "577": "乐东黎族自治县",
    "578": "东方市",
    "579": "五指山市",

    # ── Jilin Province ─────────────────────────────────────────────────────
    "130": "长春市",
    "131": "长春市",
    "132": "吉林市",
    "133": "四平市",
    "134": "辽源市",
    "135": "通化市",
    "136": "白山市",
    "137": "白城市",
    "138": "松原市",
    "139": "延边朝鲜族自治州",

    # ── Inner Mongolia Autonomous Region ──────────────────────────────────
    "010": "呼和浩特市",
    "011": "呼和浩特市",
    "012": "包头市",
    "013": "乌海市",
    "014": "鄂尔多斯市",
    "015": "巴彦淖尔市",
    "016": "乌兰察布市",
    "017": "锡林郭勒盟",
    "021": "赤峰市",
    "022": "通辽市",
    "024": "兴安盟",
    "026": "呼伦贝尔市",
    "028": "阿拉善盟",

    # ── Shanxi Province (山西, not 陕西) ───────────────────────────────────
    "030": "太原市",
    "031": "太原市",
    "032": "大同市",
    "033": "朔州市",
    "034": "忻州市",
    "035": "吕梁市",
    "036": "阳泉市",
    "037": "晋中市",
    "038": "长治市",
    "039": "晋城市",
    "041": "临汾市",
    "044": "运城市",

    # ── Hebei Province ─────────────────────────────────────────────────────
    "050": "石家庄市",
    "051": "石家庄市",
    "052": "保定市",
    "053": "张家口市",
    "054": "承德市",
    "055": "廊坊市",
    "056": "沧州市",
    "057": "衡水市",
    "058": "邢台市",
    "059": "邯郸市",
    "061": "唐山市",
    "063": "唐山市",
    "064": "秦皇岛市",

    # ── Jiangxi Province ───────────────────────────────────────────────────
    "330": "南昌市",
    "331": "南昌市",
    "332": "九江市",
    "333": "景德镇市",
    "334": "上饶市",
    "335": "鹰潭市",
    "336": "抚州市",
    "337": "宜春市",
    "338": "新余市",
    "341": "吉安市",
    "342": "赣州市",

    # ── Gansu Province ─────────────────────────────────────────────────────
    "730": "兰州市",
    "731": "兰州市",
    "732": "白银市",
    "733": "定西市",
    "734": "临夏回族自治州",
    "735": "张掖市",
    "736": "武威市",
    "737": "金昌市",
    "738": "嘉峪关市",
    "741": "天水市",
    "742": "陇南市",
    "743": "甘南藏族自治州",
    "744": "平凉市",
    "745": "庆阳市",

    # ── Ningxia Hui Autonomous Region ─────────────────────────────────────
    "750": "银川市",
    "751": "银川市",
    "752": "石嘴山市",
    "753": "吴忠市",
    "754": "固原市",
    "755": "中卫市",

    # ── Qinghai Province ───────────────────────────────────────────────────
    "810": "西宁市",
    "811": "西宁市",
    "812": "海东市",
    "813": "海北藏族自治州",
    "814": "海南藏族自治州",
    "815": "海西蒙古族藏族自治州",
    "816": "玉树藏族自治州",
    "817": "果洛藏族自治州",
    "818": "黄南藏族自治州",

    # ── Hong Kong & Macau ──────────────────────────────────────────────────
    "999": "香港",
}


def init_geo_db():
    """Initialize the local geocode cache table."""
    conn = sqlite3.connect(GEO_DB)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS geo_cache (
            lat_key REAL,
            lon_key REAL,
            location_name TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (lat_key, lon_key)
        )
    ''')
    conn.commit()
    conn.close()


def _make_keys(lat, lon, precision=GEO_PRECISION):
    """
    Truncate lat/lon toward zero to the given decimal precision.
    Using math.trunc (not math.floor) so that negative coordinates
    behave symmetrically with positive ones.
    """
    factor = 10 ** precision
    lat_key = math.trunc(lat * factor) / factor
    lon_key = math.trunc(lon * factor) / factor
    return lat_key, lon_key


def get_location_from_cache(lat, lon):
    """Check if we have a cached location for this ~11m grid cell."""
    lat_key, lon_key = _make_keys(lat, lon)

    conn = sqlite3.connect(GEO_DB)
    cursor = conn.cursor()
    cursor.execute(
        "SELECT location_name FROM geo_cache WHERE lat_key = ? AND lon_key = ?",
        (lat_key, lon_key)
    )
    row = cursor.fetchone()
    conn.close()
    return row[0] if row else None


def save_to_geo_cache(lat, lon, location_name):
    """Save a new location to the local cache."""
    lat_key, lon_key = _make_keys(lat, lon)

    conn = sqlite3.connect(GEO_DB)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT OR REPLACE INTO geo_cache (lat_key, lon_key, location_name) VALUES (?, ?, ?)",
        (lat_key, lon_key, location_name)
    )
    conn.commit()
    conn.close()


def _inject_city_from_postcode(postcode, city_raw):
    """
    For Chinese cities where Nominatim omits the city name, use the postcode
    prefix to look up the real city. Only injects when city_raw looks like a
    sub-city district name (ends in a known Chinese district suffix).
    Returns the city string, or "" if no match found.
    """
    if not postcode:
        return ""
    city_looks_like_district = any(
        city_raw.endswith(s) for s in CHINESE_DISTRICT_SUFFIXES
    )
    if not city_looks_like_district:
        return ""
    prefix = postcode[:3]
    return POSTCODE_TO_CITY.get(prefix, "")


async def fetch_from_nominatim(lat, lon, async_client):
    """Actual call to OpenStreetMap Nominatim with stacked address parts."""

    # 1. Respect Nominatim's rate limit (max 1 req/sec)
    await asyncio.sleep(1.1)

    headers = {'User-Agent': 'Daro Porto/1.0 (contact: darongma@yahoo.com)'}
    api_url = (
        f"https://nominatim.openstreetmap.org/reverse"
        f"?format=jsonv2&lat={lat}&lon={lon}"
    )

    response = await async_client.get(api_url, headers=headers, timeout=10.0)
    if response.status_code != 200:
        return None

    data = response.json()
    addr = data.get("address", {})

    # Uncomment to debug raw Nominatim keys:
    # logging.debug("Nominatim raw addr for (%s, %s): %s", lat, lon, addr)

    # 2. Road — most specific level, only included when present
    road = addr.get("road") or ""

    # 3. District — neighbourhood > quarter > suburb > district > borough
    #    Priority goes finest-to-broadest so we get the most specific
    #    meaningful name available.
    district = (
        addr.get("neighbourhood") or   # 蔡屋围   — finest
        addr.get("quarter") or         # 人民桥社区
        addr.get("suburb") or          # 桂园街道
        addr.get("district") or
        addr.get("borough") or
        ""
    )

    # 4. City — the actual municipality.
    #
    #    For most Chinese cities, Nominatim puts the urban district (罗湖区,
    #    福田区, 南山区…) in "city" and never returns the real city name
    #    (深圳市) under any key. We inject it via postcode lookup.
    municipality = addr.get("municipality") or ""
    city_raw = (
        addr.get("city") or
        addr.get("town") or
        addr.get("locality") or
        addr.get("village") or
        ""
    )
    county   = addr.get("county") or ""
    postcode = addr.get("postcode") or ""

    if municipality:
        # Some Chinese cities do return municipality correctly — use it directly
        city = municipality
        if not district and city_raw and city_raw != municipality:
            district = city_raw
        injected_city = ""
    else:
        # Try postcode injection (handles Shenzhen and most other Chinese cities)
        injected_city = _inject_city_from_postcode(postcode, city_raw)

        if not injected_city and county:
            # Secondary fallback: county sometimes holds the city in edge cases
            city_is_district = any(
                city_raw.endswith(s) for s in CHINESE_DISTRICT_SUFFIXES
            )
            if city_raw and city_is_district:
                injected_city = county

        city = city_raw

        # Rural US / non-Chinese fallback
        if not district and not city:
            city = county

    # 5. State / Province and Country
    state = addr.get("state") or addr.get("province") or ""
    country = (
        "USA" if addr.get("country") == "United States"
        else (addr.get("country") or "")
    )

    # 6. Build the address string
    #    Order: road → neighbourhood/district → urban district → city → state → country
    parts = []
    if road:
        parts.append(road)
    if district and district != road:
        parts.append(district)
    if city and city != district:
        parts.append(city)
    if injected_city and injected_city != city:
        parts.append(injected_city)
    if state:
        parts.append(state)
    if country:
        parts.append(country)

    return ", ".join(parts) if parts else None


# Run initialization on import
init_geo_db()