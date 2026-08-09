# Coordinate-Verified Listing Location and Useful Market Summaries — Design

## Goal

Reduce false `warn` notifications caused by the normal practice of hiding a
listing's complete doorplate, while preserving a fail-closed recommendation
gate for genuinely unreliable locations. A reliable listing coordinate may be
validated against a nearby official Taipei doorplate and then used for market
estimation. Reports must show the official median and comparable count whenever
those values exist, including for review-only estimates.

## Problem

The current location gate treats an unresolved text address as a direct
address-coordinate conflict whenever the road name of the closest official
doorplate differs from the incomplete listing road name. This creates two
problems:

- Most public sale listings omit the complete doorplate, so exact text-address
  resolution is routinely unavailable rather than exceptional.
- Adjacent roads can be only a few metres apart. On 2026-08-08, listing
  `53907900` was 25.5 metres from the nearest indexed doorplate and listing
  `53902849` was 37.6 metres away, but both were marked unavailable solely
  because the road names differed.

The reporting contract compounds this by hiding non-null official medians for
`review` estimates. Seven 2026-08-08 investment candidates had 3–16 official
comparables and a computed median, but their notifications only said that the
market evidence was available for reference.

## Chosen Approach

Use tiered coordinate-to-doorplate validation for incomplete addresses:

- at most 100 metres: location matched;
- more than 100 and at most 300 metres: location uncertain and review-only;
- no official doorplate within 300 metres: location evidence unavailable;
- an administrative-area mismatch, unreliable coordinate, or a resolvable
  address more than 300 metres from the listing coordinate remains fail-closed.

This is preferred over always trusting the coordinate, which would accept
deliberately displaced map pins, and over changing only the notification
status, which would not permit otherwise qualified listings to be recommended.

## Location-Evidence Semantics

### Complete or Resolvable Addresses

Existing forward address behavior remains authoritative:

- an exact official doorplate is `matched` when its coordinate is within the
  existing 300-metre tolerance after uncertainty;
- a masked numeric address range remains `uncertain` and review-only;
- a resolvable address whose coordinate is more than 300 metres beyond its
  uncertainty is a genuine `conflict` and unavailable;
- administrative-area disagreement is a genuine `conflict` and unavailable.

### Incomplete Addresses

An address is incomplete for this policy when forward lookup returns
`unresolved`, typically because the public listing omits its number. It may use
coordinate-derived validation only when all of these prerequisites hold:

- the listing has a coordinate;
- `reliability.coordConsistent === true`;
- the coordinate and listing text agree on city and district;
- the official doorplate index returns a nearest doorplate within 300 metres.

Apply the nearest-doorplate distance as follows:

| Distance | Location result | Market consequence |
| --- | --- | --- |
| `<= 100 m` | `matched` via coordinate-near-doorplate evidence | Do not downgrade an otherwise reliable estimate |
| `> 100 m` and `<= 300 m` | `uncertain` | Force low-confidence `review`; never auto-recommend |
| no doorplate within `300 m` | unavailable location evidence | Market estimate unavailable; never auto-recommend |

For an incomplete address, a road, section, lane, or alley mismatch against the
nearest doorplate is not by itself a conflict. The evidence retains both the
original normalized listing address and the nearest official doorplate so the
decision remains auditable.

Absence of evidence must not be described as a direct conflict. Human-readable
report text distinguishes "座標附近無可驗證門牌" from a genuine address or
administrative-area contradiction.

## Estimation Data Flow

The official nearest doorplate validates that the listing pin represents a
plausible local location. The estimator continues to use the listing coordinate
for radius-based transaction selection; it does not snap the subject to the
doorplate coordinate.

Coordinate-derived validation does not claim that the nearest doorplate is the
listing's exact building. Consequently, its matched address is not passed to
same-building scenario selection. Same-building evidence remains available only
for an exact forward doorplate match. This prevents a nearby official address
from receiving inappropriate same-building weighting.

Once location evidence is `matched`, the ordinary estimator determines status,
confidence, median, range, comparable count, and selected stage. A listing may
be recommended only when the resulting `marketEstimate` is `reliable`, its
confidence is not `low`, both official sources are fresh, and every other
profile gate for tenure, region, walking, building type, use, parking,
ownership, and listing quality also passes.

## Report and Notification Contract

`market_summary_line` becomes value-bearing whenever an official median exists:

- reliable example: `官方成交中位約 56.4 萬/坪（13 筆可比）`
- review example: `官方成交中位約 56.4 萬/坪（13 筆可比；地址定位待確認）`
- unavailable example: `官方行情無法估算：座標附近無可驗證門牌。`

Values are rounded to one decimal place. Comparable count is the authoritative
`marketEstimate.comparables.length`. A review line includes one concise,
human-readable limitation. If several limitations exist, report the one that
most directly blocks recommendation rather than printing the raw reason list.

P25–P75, raw confidence, selected stage, source timestamps, and the complete
reason and comparable lists remain in local evidence. The report never compares
the asking price with the official estimate to call a listing cheap, expensive,
a deal, or overpriced.

Notification status keeps its existing semantic meaning:

- coordinate-near-doorplate evidence within 100 metres is not itself a warning;
- an otherwise fully supported recommendation can use `ok`;
- a remaining actionable `review`, risk, stale source, or other weak evidence
  still forces `warn`;
- review or unavailable evidence on a separately hard-excluded listing does not
  force `warn`.

## Evidence and Compatibility

`SubjectLocationEvidence` must preserve enough structured data to distinguish:

- exact forward address matching;
- accepted coordinate-near-doorplate matching;
- the 100–300 metre uncertainty band;
- no nearby official doorplate;
- genuine administrative or forward-address conflict.

Existing enriched artifacts are immutable historical evidence and are not
rewritten. New semantics apply after rerunning enrichment. No migration aliases
are required for git-ignored run artifacts, but pipeline validation and report
generation must fail closed rather than treating an unknown new verdict or
reason as reliable.

Because this change affects location eligibility, estimate status, confidence,
and recommendation eligibility, increment both active estimator policy-version
constants together. Publish a matching market-data build and acceptance pair
only through the scheduled writer's normal atomic update path after all required
tests and full gates pass. Until publication succeeds, retain the previous
last-known-good pair.

## Verification

Automated tests cover:

- incomplete address plus a reliable, same-district coordinate 25.5 metres from
  an official doorplate is `matched` despite a road-name mismatch;
- the equivalent 37.6-metre case is also `matched`;
- exactly 100 metres is accepted;
- more than 100 through 300 metres is `uncertain` and review-only;
- no doorplate within 300 metres is unavailable but is not mislabeled as a
  direct address conflict;
- an exact forward address more than 300 metres from the coordinate remains a
  conflict;
- an administrative-area mismatch remains a conflict;
- missing or unreliable coordinates remain unavailable;
- coordinate-derived matching cannot activate same-building comparison;
- a `review` estimate with a median renders the median, comparable count, and
  concise limitation;
- an unavailable estimate with no median renders only the reason;
- reliable estimates render the median and comparable count without a review
  warning;
- notification status is `ok` when no actionable warning remains and `warn`
  when a review candidate or another documented warning remains.

Use the 2026-08-08 listings `53907900` and `53902849` as regression inputs or
equivalent sanitized fixtures. Repository verification includes targeted
location and report-contract tests, the full unit test suite, type checking,
and the complete gated Taipei market-data update/backtest publication flow.

## Acceptance Criteria

- Incomplete public addresses no longer become conflicts solely because the
  nearest official doorplate has a different road name.
- A reliable same-district coordinate with an official doorplate no farther
  than 100 metres can support a `reliable` estimate and recommendation.
- The 2026-08-08 regression cases at 25.5 and 37.6 metres pass location
  validation and proceed to ordinary estimation.
- Coordinates outside the accepted band or with genuine contradictory evidence
  remain fail-closed.
- Every non-null official median shown to the workflow is rendered in the
  report with its comparable count, including review-only medians.
- Review values remain explicitly qualified and cannot independently upgrade a
  listing to recommended.
- The new policy is not published unless all automated tests and market-data
  gates pass; failed publication retains the previous accepted pair.
