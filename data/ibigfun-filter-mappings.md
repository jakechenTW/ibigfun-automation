# iBigFun Filter & Field Mappings

Reference for the coded ids iBigFun uses in its `lists/latest` search filters and
`/api/search/list` request body. Profiles store these ids in the `fetch` map of
`profiles/<id>/profile.json` (see `profiles/README.md`); this file is the
human-readable key.

- Source: the authenticated `https://www.ibigfun.com/lists/latest` filter UI —
  the filter-control `<input>` value/label pairs, the inline `var city = {…}`
  object, and one captured `/api/search/list` XHR POST body.
- Captured: 2026-06-29. Re-confirm if iBigFun changes its filter set (same method:
  open the authenticated listing view, read each filter panel's options, or
  DevTools-capture the `/api/search/list` XHR body — see `docs/fetching.md`).

## Filter catalog (every fetch-tunable param)

Every `/api/search/list` body param a profile's `fetch` map can set, with the
shape `buildSearchBody` emits it as. The **fixed envelope** (`page`, `method`,
`on_market`, `expand`, `exclude_land`, `add_date`/`add_date_max`) and the
`source[]` / `source_web[]` allow-lists are **API contract, not `fetch`-tunable**
— see the request-body encoding section; they are intentionally absent here.

| `fetch` key | Value shape | Allowed values | Section |
|---|---|---|---|
| `city` | scalar id | 22 city ids | `city` |
| `town` | array `key[]` | 366 district ids | `town` |
| `house_type` | array `key[]` | 12 type ids | `house_type` |
| `price_segment` | scalar bucket id **or** `{min,max}` | 8 buckets, or free 萬 range | `price_segment` |
| `pattern_code` | `{min,max}` | free 房 (room count) range | Range filters |
| `bathroom` | `{min,max}` | free 衛 (bathroom count) range | Range filters |
| `floor_segment` | `{min,max}` | free 樓 (floor) range | Range filters |
| `ping_number` | `{min,max}` | free 坪 (總坪數) range | Range filters |
| `main_ping_number` | `{min,max}` | free 坪 (主建坪) range | Range filters |
| `house_age_segment` | `{min,max}`, or scalar `-1` | free 年 range; `-1`=預售屋 | Range filters |
| `price_ave` | `{min,max}` | free 萬 (單價/坪) range | Range filters |
| `total_floor` | `{min,max}` | free 樓 (總樓層) range | Range filters |
| `land_ping` | `{min,max}` | free 坪 (土地坪) range | Range filters |
| `parking` | scalar literal | 有車位 / 無車位 / 機械 / 平面 | `parking` |

Value shapes (how `buildSearchBody` in `scripts/lib/api.ts` encodes each):
scalar → `key=value`; `{min,max}` → `key[min_val]`/`key[max_val]` (omitted
bound = empty = unbounded); array → repeated `key[]`. The web URL/GET form uses
a comma form for ranges (`house_age_segment=5,30`); the **POST body does not** —
it always uses `key[min_val]`/`key[max_val]`.

## Profile filter usage

Which of these filters each committed profile's `fetch` map (in
`profiles/<id>/profile.json`) actually sends:

- **example-investment**: `city=1`, `price_segment` max 3000萬, `floor_segment`
  2–4, `total_floor` max 5. It sends **no `town[]` and no `house_type[]`**, so it
  returns all 12 台北市 districts and every house type in that floor/price window
  (the low-rise 公寓 bias is a side effect of the floor/total_floor limits, not a
  house_type filter). Verified against the 2026-06-26 fetch (78 listings across
  all 12 districts) — so there are no town/house_type ids to record for it.
- **example-owner-occupied**: `city=1`, `town[]` (1/4, 中正/中山),
  `house_type[]=17` (電梯大樓), `price_segment` max 8000萬, `floor_segment` min 7,
  `main_ping_number` min 30, `house_age_segment` max 25, `parking=平面`.
  All ids verified 2026-06-27.

## `city` (city id → name)

Complete list (22 entries) as shown in the filter UI:

| id | name | id | name | id | name |
|---|---|---|---|---|---|
| 1 | 台北市 | 9 | 台中市 | 18 | 高雄市 |
| 2 | 新北市 | 11 | 彰化縣 | 20 | 屏東縣 |
| 3 | 基隆市 | 12 | 南投縣 | 21 | 宜蘭縣 |
| 4 | 桃園市 | 13 | 雲林縣 | 22 | 花蓮縣 |
| 5 | 新竹市 | 14 | 嘉義市 | 23 | 台東縣 |
| 6 | 新竹縣 | 15 | 嘉義縣 | 24 | 澎湖縣 |
| 8 | 苗栗縣 | 16 | 台南市 | 25 | 金門縣 |
|   |   |   |   | 26 | 連江縣 |

(ids 7, 10, 17, 19 are absent from the UI list.)

## `house_type` (house_type id → name)

Complete list (12 entries):

| id | name | id | name |
|---|---|---|---|
| 16 | 公寓 | 189 | 其他 |
| 17 | 電梯大樓 | 190 | 車位 |
| 18 | 透天厝 | 467 | 別墅 |
| 20 | 店面 | 468 | 農舍 |
| 22 | 廠辦 | 629 | 廠房 |
|    |      | 630 | 辦公 |
|    |      | 631 | 商業用地 |

## `town` (district id → name)

Town options are not in the rendered filter markup; the `lists/latest` page
embeds the full city→towns table in an inline `var city = {...}` object (each
town is `{sn, town, town_en}`) and `onCityChange` fills the selector from it.
Captured 2026-06-27 (22 cities, 366 districts). Ids are **not sequential** and
are unique across cities (e.g. 文山區=376), so always map by id, never by
position.

example-owner-occupied uses 台北市 1/4 (中正/中山),
independently confirmed via single-town live fetches on 2026-06-27 and matching
this table.

Format: `id 區名` separated by `・`, one block per city (`city_id 縣市名 (count)`).

**1 台北市** (12)

1 中正區 ・ 3 大同區 ・ 4 中山區 ・ 5 松山區 ・ 6 大安區 ・ 7 萬華區 ・ 8 信義區 ・ 9 士林區 ・ 10 北投區 ・ 11 內湖區 ・ 12 南港區 ・ 376 文山區

**2 新北市** (29)

14 萬里區 ・ 15 金山區 ・ 16 板橋區 ・ 17 汐止區 ・ 18 永和區 ・ 19 中和區 ・ 20 三重區 ・ 21 新店區 ・ 22 新莊區 ・ 23 五股區 ・ 24 泰山區 ・ 25 淡水區 ・ 26 林口區 ・ 27 蘆洲區 ・ 28 八里區 ・ 29 深坑區 ・ 30 石碇區 ・ 31 瑞芳區 ・ 32 平溪區 ・ 33 雙溪區 ・ 34 貢寮區 ・ 35 坪林區 ・ 36 烏來區 ・ 37 土城區 ・ 38 三峽區 ・ 39 樹林區 ・ 40 三芝區 ・ 41 石門區 ・ 42 鶯歌區

**3 基隆市** (7)

43 仁愛區 ・ 44 信義區 ・ 45 中正區 ・ 46 中山區 ・ 47 安樂區 ・ 48 暖暖區 ・ 49 七堵區

**4 桃園市** (13)

50 中壢區 ・ 51 平鎮區 ・ 52 龍潭區 ・ 53 楊梅區 ・ 54 新屋區 ・ 55 觀音區 ・ 56 桃園區 ・ 57 龜山區 ・ 58 八德區 ・ 59 大溪區 ・ 60 復興區 ・ 61 大園區 ・ 62 蘆竹區

**5 新竹市** (1)

63 新竹市

**6 新竹縣** (13)

64 竹北市 ・ 65 湖口鄉 ・ 66 新豐鄉 ・ 67 新埔鎮 ・ 68 關西鎮 ・ 69 芎林鄉 ・ 70 寶山鄉 ・ 71 竹東鎮 ・ 72 五峰鄉 ・ 73 橫山鄉 ・ 74 尖石鄉 ・ 75 北埔鄉 ・ 76 峨眉鄉

**8 苗栗縣** (18)

77 竹南鎮 ・ 78 頭份市 ・ 79 三灣鄉 ・ 80 南庄鄉 ・ 81 獅潭鄉 ・ 82 後龍鎮 ・ 83 通霄鎮 ・ 84 苑裡鎮 ・ 85 苗栗市 ・ 86 造橋鄉 ・ 87 頭屋鄉 ・ 88 公館鄉 ・ 89 大湖鄉 ・ 90 泰安鄉 ・ 91 銅鑼鄉 ・ 92 三義鄉 ・ 93 西湖鄉 ・ 94 卓蘭鎮

**9 台中市** (29)

95 中區 ・ 96 東區 ・ 97 南區 ・ 98 西區 ・ 99 北區 ・ 100 北屯區 ・ 101 西屯區 ・ 102 南屯區 ・ 103 太平區 ・ 104 大里區 ・ 105 霧峰區 ・ 106 烏日區 ・ 107 豐原區 ・ 108 后里區 ・ 109 石岡區 ・ 110 東勢區 ・ 111 和平區 ・ 112 新社區 ・ 113 潭子區 ・ 114 大雅區 ・ 115 神岡區 ・ 116 大肚區 ・ 117 沙鹿區 ・ 118 龍井區 ・ 119 梧棲區 ・ 120 清水區 ・ 121 大甲區 ・ 122 外埔區 ・ 123 大安區

**11 彰化縣** (26)

124 彰化市 ・ 125 芬園鄉 ・ 126 花壇鄉 ・ 127 秀水鄉 ・ 128 鹿港鎮 ・ 129 福興鄉 ・ 130 線西鄉 ・ 131 和美鎮 ・ 132 伸港鄉 ・ 133 員林市 ・ 134 社頭鄉 ・ 135 永靖鄉 ・ 136 埔心鄉 ・ 137 溪湖鎮 ・ 138 大村鄉 ・ 139 埔鹽鄉 ・ 140 田中鎮 ・ 141 北斗鎮 ・ 142 田尾鄉 ・ 143 埤頭鄉 ・ 144 溪州鄉 ・ 145 竹塘鄉 ・ 146 二林鎮 ・ 147 大城鄉 ・ 148 芳苑鄉 ・ 149 二水鄉

**12 南投縣** (13)

150 南投市 ・ 151 中寮鄉 ・ 152 草屯鎮 ・ 153 國姓鄉 ・ 154 埔里鎮 ・ 155 仁愛鄉 ・ 156 名間鄉 ・ 157 集集鎮 ・ 158 水里鄉 ・ 159 魚池鄉 ・ 160 信義鄉 ・ 161 竹山鎮 ・ 162 鹿谷鄉

**13 雲林縣** (20)

163 斗南鎮 ・ 164 大埤鄉 ・ 165 虎尾鎮 ・ 166 土庫鎮 ・ 167 褒忠鄉 ・ 168 東勢鄉 ・ 169 台西鄉 ・ 170 崙背鄉 ・ 171 麥寮鄉 ・ 172 斗六市 ・ 173 林內鄉 ・ 174 古坑鄉 ・ 175 莿桐鄉 ・ 176 西螺鎮 ・ 177 二崙鄉 ・ 178 北港鎮 ・ 179 水林鄉 ・ 180 口湖鄉 ・ 181 四湖鄉 ・ 182 元長鄉

**14 嘉義市** (1)

380 嘉義市

**15 嘉義縣** (18)

185 番路鄉 ・ 186 梅山鄉 ・ 187 阿里山鄉 ・ 188 中埔鄉 ・ 189 大埔鄉 ・ 190 水上鄉 ・ 191 鹿草鄉 ・ 192 太保市 ・ 193 朴子市 ・ 194 東石鄉 ・ 195 六腳鄉 ・ 196 新港鄉 ・ 197 民雄鄉 ・ 198 大林鎮 ・ 199 溪口鄉 ・ 200 義竹鄉 ・ 201 布袋鎮 ・ 202 竹崎鄉

**16 台南市** (37)

203 中西區 ・ 204 東區 ・ 205 南區 ・ 207 北區 ・ 208 安平區 ・ 209 安南區 ・ 210 永康區 ・ 211 歸仁區 ・ 212 新化區 ・ 213 左鎮區 ・ 214 玉井區 ・ 215 楠西區 ・ 216 南化區 ・ 217 仁德區 ・ 218 關廟區 ・ 219 龍崎區 ・ 220 官田區 ・ 221 麻豆區 ・ 222 佳里區 ・ 223 西港區 ・ 224 七股區 ・ 225 將軍區 ・ 226 學甲區 ・ 227 北門區 ・ 228 新營區 ・ 229 後壁區 ・ 230 白河區 ・ 231 六甲區 ・ 232 下營區 ・ 233 柳營區 ・ 234 鹽水區 ・ 235 善化區 ・ 236 大內區 ・ 237 山上區 ・ 238 新市區 ・ 239 安定區 ・ 240 東山區

**18 高雄市** (38)

241 新興區 ・ 242 前金區 ・ 243 苓雅區 ・ 244 鹽埕區 ・ 245 鼓山區 ・ 246 旗津區 ・ 247 前鎮區 ・ 248 三民區 ・ 249 楠梓區 ・ 250 小港區 ・ 251 左營區 ・ 252 仁武區 ・ 253 大社區 ・ 254 岡山區 ・ 255 路竹區 ・ 256 阿蓮區 ・ 257 田寮區 ・ 258 燕巢區 ・ 259 橋頭區 ・ 260 梓官區 ・ 261 彌陀區 ・ 262 永安區 ・ 263 湖內區 ・ 264 鳳山區 ・ 265 大寮區 ・ 266 林園區 ・ 267 鳥松區 ・ 268 大樹區 ・ 269 旗山區 ・ 270 美濃區 ・ 271 六龜區 ・ 272 內門區 ・ 273 杉林區 ・ 274 甲仙區 ・ 275 桃源區 ・ 276 那瑪夏區 ・ 277 茂林區 ・ 278 茄萣區

**20 屏東縣** (34)

279 屏東市 ・ 280 三地門鄉 ・ 281 霧臺鄉 ・ 282 瑪家鄉 ・ 283 九如鄉 ・ 284 里港鄉 ・ 285 高樹鄉 ・ 286 鹽埔鄉 ・ 287 長治鄉 ・ 288 麟洛鄉 ・ 289 竹田鄉 ・ 290 內埔鄉 ・ 291 萬丹鄉 ・ 292 潮州鎮 ・ 293 泰武鄉 ・ 294 來義鄉 ・ 295 萬巒鄉 ・ 296 崁頂鄉 ・ 297 東埤鄉 ・ 298 南州鄉 ・ 299 林邊鄉 ・ 300 東港鎮 ・ 301 琉球鄉 ・ 302 佳冬鄉 ・ 303 新園鄉 ・ 304 枋寮鄉 ・ 305 枋山鄉 ・ 306 春日鄉 ・ 307 獅子鄉 ・ 308 車城鄉 ・ 309 牡丹鄉 ・ 310 恆春鎮 ・ 311 滿州鄉 ・ 381 新埤鄉

**21 宜蘭縣** (12)

312 宜蘭市 ・ 313 頭城鎮 ・ 314 礁溪鄉 ・ 315 壯圍鄉 ・ 316 員山鄉 ・ 317 羅東鎮 ・ 318 三星鄉 ・ 319 大同鄉 ・ 320 五結鄉 ・ 321 冬山鄉 ・ 322 蘇澳鎮 ・ 323 南澳鄉

**22 花蓮縣** (13)

324 花蓮市 ・ 325 新城鄉 ・ 326 秀林鄉 ・ 327 吉安鄉 ・ 328 壽豐鄉 ・ 329 鳳林鎮 ・ 330 光復鄉 ・ 331 豐濱鄉 ・ 332 瑞穗鄉 ・ 333 萬榮鄉 ・ 334 玉里鎮 ・ 335 卓溪鄉 ・ 336 富里鄉

**23 台東縣** (16)

337 台東市 ・ 338 綠島鄉 ・ 339 延平鄉 ・ 340 卑南鄉 ・ 341 鹿野鄉 ・ 342 關山鎮 ・ 343 海端鄉 ・ 344 池上鄉 ・ 345 東河鄉 ・ 346 成功鎮 ・ 347 長濱鄉 ・ 348 太麻里鄉 ・ 349 金峰鄉 ・ 350 大武鄉 ・ 351 達仁鄉 ・ 352 蘭嶼鄉

**24 澎湖縣** (6)

353 馬公市 ・ 354 西嶼鄉 ・ 355 望安鄉 ・ 356 七美鄉 ・ 357 白沙鄉 ・ 358 湖西鄉

**25 金門縣** (6)

359 金沙鎮 ・ 360 金湖鎮 ・ 361 金寧鄉 ・ 362 金城鎮 ・ 363 烈嶼鄉 ・ 364 烏坵鄉

**26 連江縣** (4)

365 南竿鄉 ・ 366 北竿鄉 ・ 367 莒光鄉 ・ 368 東引鄉

## `price_segment` (price 買賣總價)

`price_segment` (價格區間) is the one filter with **two valid forms**:

1. **Preset bucket** — a scalar id → `price_segment=<id>`:

   | id | range | id | range |
   |---|---|---|---|
   | 333 | 500萬以下 | 338 | 2500~4000萬 |
   | 334 | 500~1000萬 | 339 | 3800~6000萬 |
   | 335 | 800~1500萬 | 340 | 6000萬以上 |
   | 336 | 1200~2000萬 | 360 | 不限 (no filter — omit the key) |
   | 337 | 1800~2800萬 | 361 | 其他 (custom range, see below) |

2. **Custom range** — a `{min,max}` object in 萬 → `price_segment[min_val]` /
   `price_segment[max_val]`. This is the form the example profiles use, e.g.
   `"price_segment": { "max": 3000 }` → `price_segment[max_val]=3000`.

Use one or the other, not both. The buckets are coarse; the custom range is the
flexible choice for a profile.

## Range filters

These are **free numeric ranges** (no preset buckets) entered as a `{min,max}`
object and emitted as `key[min_val]` / `key[max_val]` (omit a bound to leave that
side unbounded). Units are the UI's:

| `fetch` key | UI label | Unit | Notes |
|---|---|---|---|
| `pattern_code` | 格局 | 房 (rooms) | room-count range (despite the `pattern_code` name) |
| `bathroom` | 衛浴 | 衛 (baths) | bathroom-count range |
| `floor_segment` | 樓層 | 樓 | the listing's own floor |
| `ping_number` | 總坪數 | 坪 | total ping (建物總坪數) |
| `main_ping_number` | 主建坪 | 坪 | 主建物 ping; server-side only (see encoding) |
| `house_age_segment` | 屋齡 | 年 | range in years; scalar `-1` = 預售屋 (presale) |
| `price_ave` | 單價 | 萬 | unit price per 坪 |
| `total_floor` | 總樓層 | 樓 | the building's total floors |
| `land_ping` | 土地坪 | 坪 | land area |

Example: `"house_age_segment": { "max": 25 }` → `house_age_segment[min_val]=` &
`house_age_segment[max_val]=25`. For presale-only, set the scalar
`"house_age_segment": "-1"` → `house_age_segment=-1`.

## `parking`

`parking` is a scalar sent as a literal Chinese value (not an id), e.g.
`parking=平面`. The 車位 control (under 進階條件) is a radio group; complete value
set (excluding 不限, which means "no filter" — omit the key entirely):

| value | meaning |
|---|---|
| `有車位` | has any parking |
| `無車位` | no parking |
| `機械` | 機械車位 (mechanical) |
| `平面` | 平面車位 (flat / self-park) |

(The current UI exposes only these four; earlier notes mentioning 塔式 / 其他 no
longer match the live control.)

## `/api/search/list` request-body encoding

The web URL param names differ from the POST body. Canonical body builder:
`scripts/lib/api.ts` (`buildSearchBody`). Encoding patterns:

- Range filters use `name[min_val]` / `name[max_val]` (empty string = unbounded):
  `price_segment`, `pattern_code`, `bathroom`, `floor_segment`, `ping_number`,
  `main_ping_number`, `house_age_segment`, `price_ave`, `total_floor`,
  `land_ping`.
- Multi-value filters repeat `name[]`: `town[]`, `house_type[]`, `source[]`,
  `source_web[]`.
- Scalars: `city`, `parking`, `price_segment` (bucket-id form),
  `method=all_case`, `on_market=1`, `expand=0`, `exclude_land=1`, `add_date` /
  `add_date_max` (target range).

**Envelope, not `fetch`-tunable:** `page`, `method`, `on_market`, `expand`,
`exclude_land`, `add_date`/`add_date_max`, and the `source[]` / `source_web[]`
allow-lists are the API contract, hard-coded in `buildSearchBody` and emitted on
every request regardless of the profile's `fetch` map — so they are deliberately
absent from the Filter catalog above. (The live web form also sends an empty
`connection=`; `buildSearchBody` omits it and the API tolerates the omission.)

Server-side-only (cannot be re-verified from the response): `main_ping_number`
(API returns `total_ping`, not 主建物 ping) and `house_type` (API returns
`typeLayout` room layout, not a building-type category).

## Related references (not duplicated here)

- API field → normalized `Listing` field table: `docs/fetching.md`.
- `source[]` / `source_web[]` allow-lists: `scripts/lib/api.ts`.
- How filters flow from a profile into the request: a profile's `fetch` map
  (`profiles/<id>/profile.json`, loaded by `scripts/lib/profiles.ts`) is walked
  by `scripts/lib/api.ts` (`buildSearchBody`).
- How to author a profile's `fetch` map: `profiles/README.md`.
</content>
