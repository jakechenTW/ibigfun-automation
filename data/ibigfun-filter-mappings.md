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

Town options are not in the rendered filter markup; the page embeds the full
city→towns table in an inline `var city = {...}` object (each town is
`{sn, town, town_en}`) and `onCityChange` populates the selector from it.

Complete **台北市 (city=1)** list (12 districts), from that embedded object:

| id | name | id | name |
|---|---|---|---|
| 1 | 中正區 | 9 | 士林區 |
| 3 | 大同區 | 10 | 北投區 |
| 4 | 中山區 | 11 | 內湖區 |
| 5 | 松山區 | 12 | 南港區 |
| 6 | 大安區 | 376 | 文山區 |
| 7 | 萬華區 |   |   |
| 8 | 信義區 |   |   |

Note ids are not sequential (文山區 = 376). owner-occupied uses 1/4/6/8/9
(中正/中山/大安/信義/士林); these five were independently confirmed via
single-town live fetches on 2026-06-27 and match this table. Other cities'
towns live in the same embedded `var city` object on `lists/latest`.

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
