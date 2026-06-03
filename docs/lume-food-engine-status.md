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

## Current Baseline (after Phase 5A stricter checks)

Live audit run date: `2026-06-03`

Summary: **8/8 passed** (stricter source-name checks active)

| Query | Status | Calories | Source name | Disallowed terms guarding this case |
| --- | --- | ---: | --- | --- |
| `banana` | PASS | 100.3 | `Bananas, overripe, raw` | — |
| `white rice` | PASS | 205.4 | `Rice, white, cooked, as ingredient` | `glutinous` |
| `100g chicken breast` | PASS | 165.0 | `Chicken, broilers or fryers, breast, meat only, cooked, roasted` | — |
| `whole milk` | PASS | 148.8 | `Milk, whole` | `buttermilk`, `cheese`, `evaporated` |
| `almonds` | PASS | 175.3 | `Nuts, almonds, whole, raw` | `paste`, `milk`, `butter`, `flour` |
| `pasta` | PASS | 182.0 | `Pasta, homemade, made with egg, cooked` | `gluten-free`, `corn` |
| `1 tbsp olive oil` | PASS | 121.5 | `Olive oil` | `corn`, `peanut`, `canola`, `vegetable`, `soybean`, `sunflower` |
| `2 eggs` | PASS | 148.0 | `Eggs, Grade A, Large, egg whole` | `fried`, `egg white`, `substitute` |

Regression tests: **53 passing** (no food-engine behavior changed in Phase 5A).

---

---

## Phase History

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
