# Lume Food Engine Status

## Current Benchmark Goal

The near-term target is reliable generic whole-food nutrition before expanding deeper into branded packaged foods, restaurant meals, barcode scans, and complex composite meals.

The audit checks:

- Calories and macros are in a reasonable range.
- Source type is clear (no estimated fallbacks for known generic foods).
- Serving descriptions are understandable.
- Quantity scaling works for simple queries.

## Audit Script

Run locally only when a live spot check is wanted:

```bash
cd backend
python3 scripts/audit_generic_foods.py
```

For structured output:

```bash
cd backend
python3 scripts/audit_generic_foods.py --json
```

The script calls USDA through the existing backend service. Do not treat one live run as a permanent truth source; use it as a quick signal for current behavior.

### What the audit checks (Phase 5A harness)

Each `AuditCase` supports the following fields. Existing checks are unchanged; source-name and serving checks are new in Phase 5A:

| Field | Check |
| --- | --- |
| `min_calories` / `max_calories` | Calories must fall within the given range. |
| `expected_source_type` | `source_type` in result must match (default `"generic"`). |
| `require_source_backed` | `is_estimated` must be `False` when True (default True). |
| `required_source_terms` | Every term must appear (case-insensitive) in `source_name`. |
| `disallowed_source_terms` | No term may appear (case-insensitive) in `source_name`. |
| `required_serving_terms` | Every term must appear (case-insensitive) in `serving_description`. |

Failure reasons are reported individually in the `reason` column so each distinct problem is visible.

## Current Baseline (after Phase 6 coverage expansion)

Live audit run date: `2026-06-03`

Summary: **28/29 passed** — 8 source-quality + 5 quantity-scaling + 15/16 coverage

### Source-quality cases (8/8)

| Query | Status | Calories | Source name | Disallowed terms |
| --- | --- | ---: | --- | --- |
| `banana` | PASS | 100.3 | `Bananas, overripe, raw` | — |
| `white rice` | PASS | 205.4 | `Rice, white, cooked, as ingredient` | `glutinous` |
| `100g chicken breast` | PASS | 165.0 | `Chicken, broilers or fryers, breast, meat only, cooked, roasted` | — |
| `whole milk` | PASS | 148.8 | `Milk, whole` | `buttermilk`, `cheese`, `evaporated` |
| `almonds` | PASS | 175.3 | `Nuts, almonds, whole, raw` | `paste`, `milk`, `butter`, `flour` |
| `pasta` | PASS | 182.0 | `Pasta, homemade, made with egg, cooked` | `gluten-free`, `corn` |
| `1 tbsp olive oil` | PASS | 121.5 | `Olive oil` | `corn`, `peanut`, `canola`, `vegetable`, `soybean`, `sunflower` |
| `2 eggs` | PASS | 148.0 | `Eggs, Grade A, Large, egg whole` | `fried`, `egg white`, `substitute` |

### Quantity-scaling cases (5/5)

| Query | Status | Calories | Serving | Source name | Notes |
| --- | --- | ---: | --- | --- | --- |
| `1 cup white rice` | PASS | 205.4 | `1 cup` | `Rice, white, cooked, as ingredient` | Cup unit parsed; 158 g scaling. |
| `2.5 cups white rice` | PASS | 513.5 | `2.5 cups` | `Rice, white, cooked, as ingredient` | Fractional: 2.5 × 205.4 cal. |
| `2 tbsp peanut butter` | PASS | ~191–202 | `2 tbsp` | `Peanut butter` / `Peanut butter, creamy` | 32 g; source varies by run. |
| `1 large banana` | PASS | 115.6 | `1 large` | `Bananas, overripe, raw` | Size modifier → 136 g profile. |
| `1 small apple` | PASS | 96.4 | `1 small` | `Apples, fuji, with skin, raw` | Size modifier → 149 g profile. |

### Coverage cases (15/16)

| Query | Status | Calories | Source name | Notes |
| --- | --- | ---: | --- | --- |
| `apple` | PASS | 117.8 | `Apples, fuji, with skin, raw` | |
| `orange` | PASS | 61.6 | `Oranges, raw, navels` | |
| `strawberries` | PASS | 55.3 | `Strawberries, raw` | |
| `blueberries` | PASS | 94.6 | `Blueberries, raw` | |
| **`avocado`** | **FAIL** | **334.5** | `Avocado, Hass, peeled, raw` | Audit range 150–330 too tight. Hass avocado is ~223 cal/100g × 150 g = 334.5 cal, just above ceiling. Source correct; range needs widening. |
| `broccoli` | PASS | 34.3 | `Broccoli, chinese, cooked` | |
| `spinach` | PASS | 6.9 | `Spinach, raw` | |
| `potato` | PASS | 160.9 | `Potatoes, baked, flesh, with salt` | |
| `sweet potato` | PASS | 130.0 | `Sweet potato, frozen, cooked, baked, with salt` | |
| `brown rice` | PASS | 286.6 | `Rice, brown, parboiled, cooked, UNCLE BENS` | |
| `oatmeal` | PASS | 131.0 | `Oatmeal, multigrain` | |
| `salmon` | PASS | 231.0 | `Fish, salmon, chinook, cooked, dry heat` | |
| `ground beef` | PASS | 295.0 | `Beef, ground, patties, frozen, cooked, broiled` | |
| `greek yogurt` | PASS | 103.7 | `Yogurt, Greek, plain, nonfat` | |
| `cheddar cheese` | PASS | 114.2 | `Cheese, cheddar` | |
| `black beans` | PASS | 227.0 | `Beans, black, mature seeds, cooked, boiled, with salt` | |

Regression tests: **53 passing** (no food-engine behavior changed in Phase 6).

---

---

## Phase History

### Phase 6 (completed 2026-06-03)

Expanded coverage benchmark in `scripts/audit_generic_foods.py`. No food-engine behavior changed.

- Added `COVERAGE_BENCHMARK` (16 cases): fruits, vegetables, grains, proteins, dairy, legumes.
- Each case has a calorie range and targeted `disallowed_source_terms` mirroring the profile's avoid_terms.
- Summary now reports three sections: source-quality, quantity-scaling, coverage.
- Live run result: **28/29 passed**. One failure:
  - `avocado` — audit range 150–330 is too tight. USDA returned `Avocado, Hass, peeled, raw` at 334.5 cal (Hass variety is ~223 cal/100g vs average ~160 cal/100g). Source is correct; range should be widened to ~150–360. No food-engine change needed.

### Phase 5B (completed 2026-06-03)

Added quantity-scaling benchmark to `scripts/audit_generic_foods.py`. No food-engine behavior changed.

- Benchmark split into `SOURCE_QUALITY_BENCHMARK` (8 items) and `QUANTITY_BENCHMARK` (5 items); `SMALL_BENCHMARK` is their concatenation.
- Summary line now reports each section separately (`Source-quality: N/8`, `Quantity-scaling: N/5`, `Total: N/13`).
- Added `required_serving_terms` checks to `100g chicken breast` (`"100"`) and `1 tbsp olive oil` (`"tbsp"`) to guard the serving-description path.
- Five new quantity cases all passed on first live run: cup, fractional cup, tablespoon, large-size modifier, small-size modifier.

### Phase 5A (completed 2026-06-03)

Strengthened the audit harness (`scripts/audit_generic_foods.py`). No food-engine behavior changed.

- `AuditCase` now accepts `required_source_terms`, `disallowed_source_terms`, and `required_serving_terms`.
- `_evaluate` checks each field and reports each failure reason individually in the `reason` column.
- Added targeted `disallowed_source_terms` for 6 benchmark cases so the audit catches wrong-source regressions, not just calorie-range passes.
- Live run confirmed 8/8 under the stricter checks.

### Phase 3 (completed 2026-06-03)

Improved generic food source selection for `pasta`, `white rice`, and `olive oil`:

- `pasta` — Added `"gluten-free"` to avoid_terms. Penalises `Pasta, gluten-free, corn, cooked` (−35) so that `Pasta, cooked, enriched, without added salt` (SR Legacy) wins when both are in the result pool.
- `white rice` / `rice` — Added `"glutinous"` to avoid_terms. Penalises `Rice, white, glutinous, unenriched, cooked` (−35) so plain long-grain white rice wins.
- `olive oil` — Added `"corn"`, `"peanut"`, `"canola"`, `"soybean"`, `"vegetable"`, `"sunflower"` to avoid_terms. Mixed-oil blends (e.g. `Oil, corn, peanut, and olive`) receive a −70 combined penalty so `Oil, olive, salad or cooking` wins cleanly.

Regression tests: 53 passed (3 new tests added).

### Phase 2 (completed)

Fixed source selection for `almonds`, `whole milk`, and `2 eggs`:

- `almonds` — Added a dedicated profile with `search_query="nuts almonds"` so the USDA query returns the correct Foundation/SR Legacy nut entry instead of falling back to an estimated value.
- `whole milk` — Added `"buttermilk"` to avoid_terms so that `Milk, buttermilk, fluid, whole` is penalised and plain whole milk wins.
- `2 eggs` — Added `"fried"` to avoid_terms for the egg profile so `Egg, whole, cooked, fried` is penalised and plain/raw egg wins.

Regression tests: 50 passed after Phase 2 fixes.

### Phase 1 (2026-06-02 — historical pre-fix baseline)

Added the audit script (`scripts/audit_generic_foods.py`) and documented the benchmark goals. No food-engine behavior was changed in Phase 1.

**Phase 1 audit result: 7/8 passed** — shown here for historical reference only. These results are superseded by Phase 2 and Phase 3 fixes.

| Query | Status | Calories | Estimated | Source | Issue identified |
| --- | --- | ---: | --- | --- | --- |
| `banana` | PASS | 100.3 | false | `Bananas, overripe, raw` | None. |
| `white rice` | PASS | 153.3 | false | `Rice, white, glutinous, unenriched, cooked` | Wrong source: glutinous rice. Fixed in Phase 3. |
| `100g chicken breast` | PASS | 165.0 | false | `Chicken, broilers or fryers, breast, meat only, cooked, roasted` | None. |
| `whole milk` | PASS | 151.3 | false | `Milk, buttermilk, fluid, whole` | Wrong source: buttermilk. Fixed in Phase 2. |
| `almonds` | **FAIL** | 250 | **true** | None | Estimated fallback, no USDA source. Fixed in Phase 2. |
| `pasta` | PASS | 176.4 | false | `Pasta, gluten-free, corn, cooked` | Wrong source: gluten-free corn pasta. Fixed in Phase 3. |
| `1 tbsp olive oil` | PASS | 119.3 | false | `Oil, corn, peanut, and olive` | Wrong source: mixed-oil blend. Fixed in Phase 3. |
| `2 eggs` | PASS | 196.0 | false | `Egg, whole, cooked, fried` | Wrong source: fried egg. Fixed in Phase 2. |

---

## Known Issues To Investigate Later

- USDA search may not always return the best plain-ingredient entry in the top-10 pool. When a correct candidate is absent from the pool, the penalised wrong variant still clears the confidence threshold and is returned (no fallback, but wrong source).
- Quantity handling and serving descriptions need to stay consistent across the API and frontend.
- Some older backend serving-column changes may be incomplete and should be preserved unless intentionally finished or replaced.
- The frontend is still mostly one large `App.tsx`; gradual extraction is preferred when touching specific features.

## Next Steps

1. ~~Run a live audit to confirm Phase 3 fixes against real USDA data~~ — done in Phase 5A; 8/8 passing with source-name checks.
2. Consider expanding the benchmark to cover remaining generic whole foods: apple, orange, broccoli, sweet potato, oatmeal, greek yogurt, peanut butter, black beans, etc.
3. Propose focused behavior changes before implementing them.
4. Add or update regression tests for any approved food-engine fixes.
5. Only after local validation, discuss whether any Supabase migration or deployment change is needed.
