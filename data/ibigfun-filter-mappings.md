# iBigFun Filter & Field Mappings

Reference for the coded ids iBigFun uses in its `lists/latest` search filters and
`/api/search/list` request body. Profiles (`profiles/*.json`) store these ids;
this file is the human-readable key.

- Source: the authenticated `https://www.ibigfun.com/lists/latest` filter UI,
  read from `<span id="<filter>_caption_<id>">name</span>` markup.
- Captured: 2026-06-27. Re-confirm if iBigFun changes its filter set (same method:
  open the authenticated listing view, read the caption spans, or DevTools-capture
  the `/api/search/list` XHR body — see `docs/fetching.md`).

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

owner-occupied uses 台北市 1/4/6/8/9 (中正/中山/大安/信義/士林), independently
confirmed via single-town live fetches on 2026-06-27 and matching this table.

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

## `parking`

`parking` is sent as a literal Chinese value (not an id), e.g. `parking=平面`.
Other UI values include 機械、塔式、其他 (re-confirm from the UI if needed).

## `/api/search/list` request-body encoding

The web URL param names differ from the POST body. Canonical body builder:
`scripts/lib/api.ts` (`buildSearchBody`). Encoding patterns:

- Range filters use `name[min_val]` / `name[max_val]` (empty string = unbounded):
  `price_segment`, `floor_segment`, `total_floor`, `house_age_segment`,
  `main_ping_number`.
- Multi-value filters repeat `name[]`: `town[]`, `house_type[]`, `source[]`,
  `source_web[]`.
- Scalars: `city`, `parking`, `method=all_case`, `on_market=1`, `expand=0`,
  `exclude_land=1`, `add_date` / `add_date_max` (target range).

Server-side-only (cannot be re-verified from the response): `main_ping_number`
(API returns `total_ping`, not 主建物 ping) and `house_type` (API returns
`typeLayout` room layout, not a building-type category).

## Related references (not duplicated here)

- API field → normalized `Listing` field table: `docs/fetching.md`.
- `source[]` / `source_web[]` allow-lists: `scripts/lib/api.ts`.
- How filters flow from a profile into the request: `scripts/lib/profiles.ts`
  (`searchFiltersFromProfile`) and `scripts/lib/api.ts` (`buildSearchBody`).
</content>
