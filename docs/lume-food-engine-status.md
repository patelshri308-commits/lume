# Lume Food Engine Status

## Current Benchmark Goal

The near-term target is reliable generic whole-food nutrition before expanding deeper into branded packaged foods, restaurant meals, barcode scans, and complex composite meals.

The audit checks:

- Calories and macros are in a reasonable range.
- Source type is clear (no estimated fallbacks for known generic foods).
- Serving descriptions are understandable.
- Quantity scaling works for simple queries.

## Audit Scripts

### Phase 8B regression audit (narrow, all-pass target)

```bash
cd backend && python3 scripts/audit_generic_foods.py
cd backend && python3 scripts/audit_generic_foods.py --json
```

29 cases across source-quality, quantity-scaling, and coverage benchmarks. All 29 expected to pass on every run.

### Phase 8C diagnostic audit (broad, diagnosis-focused)

```bash
cd backend && python3 scripts/audit_phase8c.py
cd backend && python3 scripts/audit_phase8c.py --verbose   # includes source_name per row
cd backend && python3 scripts/audit_phase8c.py --json
```

25 cases across 5 food categories. Some failures are expected and intentional — this script identifies engine gaps, not regressions. See Phase 8C in the phase history below for the baseline and root-cause analysis.

Both scripts call USDA through the existing backend service. Do not treat one live run as a permanent truth source; USDA result ordering can vary between runs for some queries.

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

## Current Baseline (after Phase 9D)

Live audit run date: `2026-06-04`

Summary: **29/29 passed** — 8 source-quality + 5 quantity-scaling + 16/16 coverage

### Source-quality cases (8/8)

| Query | Status | Calories | Source name | Notes |
| --- | --- | ---: | --- | --- |
| `banana` | PASS | 100.3 | `Bananas, overripe, raw` | |
| `white rice` | PASS | 205.4 | `Rice, white, cooked, as ingredient` | |
| `100g chicken breast` | PASS | 165.0 | `Chicken, broilers or fryers, breast, meat only, cooked, roasted` | |
| `whole milk` | PASS | 148.8 | `Milk, whole` | |
| `almonds` | PASS | 175.3 | `Nuts, almonds, whole, raw` | |
| `pasta` | PASS | 219.8 | `Pasta, cooked, enriched, with added salt` | Improved in Phase 7A (was `Pasta, homemade, made with egg`). |
| `1 tbsp olive oil` | PASS | 119.3 | `Oil, olive, salad or cooking` | |
| `2 eggs` | PASS | 148.0 | `Eggs, Grade A, Large, egg whole` | |

### Quantity-scaling cases (5/5)

| Query | Status | Calories | Serving | Source name |
| --- | --- | ---: | --- | --- |
| `1 cup white rice` | PASS | 205.4 | `1 cup` | `Rice, white, cooked, as ingredient` |
| `2.5 cups white rice` | PASS | 513.5 | `2.5 cups` | `Rice, white, cooked, as ingredient` |
| `2 tbsp peanut butter` | PASS | ~191–202 | `2 tbsp` | `Peanut butter` / `Peanut butter, creamy` (varies by run) |
| `1 large banana` | PASS | 115.6 | `1 large` | `Bananas, overripe, raw` |
| `1 small apple` | PASS | 96.4 | `1 small` | `Apples, fuji, with skin, raw` |

### Coverage cases (16/16)

| Query | Status | Calories | Source name | Notes |
| --- | --- | ---: | --- | --- |
| `apple` | PASS | 117.8 | `Apples, fuji, with skin, raw` | |
| `orange` | PASS | 61.6 | `Oranges, raw, navels` | |
| `strawberries` | PASS | 55.3 | `Strawberries, raw` | |
| `blueberries` | PASS | 94.6 | `Blueberries, raw` | |
| `avocado` | PASS | 334.5 | `Avocado, Hass, peeled, raw` | Source correct; range widened 330→360 in Phase 7A. |
| `broccoli` | PASS | 64.0 | `Broccoli, cooked, as ingredient` | Improved in Phase 7B (was `Broccoli raab, cooked`). |
| `spinach` | PASS | 6.9 | `Spinach, raw` | |
| `potato` | PASS | 160.9 | `Potatoes, baked, flesh, with salt` | |
| `sweet potato` | PASS | 117.0 | `Sweet potato, cooked, baked in skin, flesh, with salt` | Improved in Phase 7A (was frozen). |
| `brown rice` | PASS | 241.8 | `Rice, brown, cooked, as ingredient` | Improved in Phase 7A (was Uncle Ben's parboiled). |
| `oatmeal` | PASS | 187.2 | `Oatmeal, fast food, plain` | Improved in Phase 7A (was multigrain); fast-food variant still not ideal — see remaining issues. |
| `salmon` | PASS | 231.0 | `Fish, salmon, chinook, cooked, dry heat` | |
| `ground beef` | PASS | 240.0 | `Beef, ground, unspecified fat content, cooked` | Improved in Phase 7A (was frozen patties). |
| `greek yogurt` | PASS | 103.7 | `Yogurt, Greek, plain, nonfat` | |
| `cheddar cheese` | PASS | 114.2 | `Cheese, cheddar` | |
| `black beans` | PASS | 227.0 | `Beans, black, mature seeds, cooked, boiled, with salt` | |

Regression tests: **111 passing** (4 new Phase 8B tests; 7 existing tests updated to reflect verified-food behavior).

---

## Phase History

### Phase 9D (completed 2026-06-04)

Fixed unit and portion scaling issues for butter, sugar, steak, and coffee-with-milk. No external APIs, frontend, database schema, or deployment changes.

**Files changed:**
- `backend/app/services/nutrition_service.py` — added profiles for `butter` (tbsp=14.2g, tsp=4.7g), `sugar` (tsp=4g, tbsp=12g), and `steak` (default=170g); added steak prep-variant aliases (`beef steak`, `sirloin steak`, `ribeye`, `ny strip`, `filet mignon`); added `"coffee with milk"` and `"coffee with cream"` to `_KNOWN_WHOLE_FOODS`; added `"coffee with": 35` to `_MEAL_CALORIE_FLOOR`; added fallback rule for coffee+milk/cream queries.
- `backend/app/services/composite_service.py` — added `"coffee with milk"` and `"coffee with cream"` to `_KNOWN_WHOLE_FOODS`.
- `backend/tests/test_nutrition_unit.py` — added `TestUnitAndPortionScaling` class (11 new tests).

**Before / after:**

| Query | Before | After |
| --- | --- | --- |
| `1 tbsp butter` | 717 kcal (per-100g unscaled, FAIL) | ~102 kcal (14.2g × profile USDA, PASS) |
| `1 tsp sugar` | 387 kcal (per-100g unscaled, FAIL) | ~16 kcal (4g × profile USDA, PASS) |
| `4 oz steak` | 0 kcal (oz treated as item count, FAIL) | ~307 kcal (113g × profile USDA, PASS) |
| `coffee with milk` | ~250 kcal (full-cup milk composited, FAIL) | 50 kcal (floor → fallback splash, PASS) |

**Mechanism — butter/sugar/steak:** Adding `GenericFoodProfile` entries activates `_grams_from_unit` for tbsp/tsp/oz unit conversions. Without a profile, these units were ignored and USDA per-100g data was returned unscaled.

**Mechanism — coffee with milk:**
- `_KNOWN_WHOLE_FOODS` prevents composite decomposition (which was adding a full cup of milk, 244g → ~150 kcal fallback).
- `_MEAL_CALORIE_FLOOR["coffee with"] = 35` rejects USDA diluted-coffee entries (~10–17 kcal/100g) and falls back to the `_get_fallback_nutrition` splash estimate (~50 kcal).
- Explicit user quantity is preserved: "coffee with 1 cup milk" does not match the whole-food shortcut and still decomposes into 2 components.

**Phase 8D benchmark: 38/46 (82%)** — up from 37/46 (80%) after Phase 9C.

**Tests: 111/111 passing** (11 new Phase 9D tests). Phase 8B audit unchanged (29/29).

**Remaining Phase 9 targets (post-9D):**
- **OFF search coverage** — McDonald's, Chipotle, Hershey, Oreo all return 0 results.
- **`costco hot dog`** — routes to USDA "Pickle relish, hot dog"; `costco` not in `_RESTAURANT_SIGNALS`.
- **`turkey sandwich on rye`** — USDA selects rye crackers with cheese filling (817 kcal) instead of a sandwich. Needs avoid_terms for "crackers" or a more specific profile.
- **Composite "with" portioning** for add-ins other than milk/cream.

---

### Phase 9C (completed 2026-06-04)

Added meal-size profiles for common bowl/meal/drink queries so the engine returns realistic whole-serving nutrition instead of per-100g fragments. No APIs, no schema changes, no routing-architecture changes.

**Files changed:**
- `backend/app/services/nutrition_service.py` — added 5 meal/drink profiles (`chicken rice bowl`, `chicken bowl`, `salad with chicken`, `chicken salad`, `protein shake`); added bowl/chipotle/protein-shake patterns to `_get_fallback_nutrition`; added `shake` (100 kcal) and `bowl` (200 kcal) entries to `_MEAL_CALORIE_FLOOR`; added two aliases (`chicken and rice bowl`, `chicken and rice` → `chicken rice bowl`).
- `backend/app/services/composite_service.py` — added `chicken and rice bowl` and `chicken rice bowl` to `_KNOWN_WHOLE_FOODS`.
- `backend/tests/test_nutrition_unit.py` — added `TestMealSizeProfiles` class (7 new tests).

**Profiles added:**

| Profile key | `default_grams` | `search_query` | Key `avoid_terms` |
| --- | --- | --- | --- |
| `chicken rice bowl` | 400 g | `bowl chicken rice cooked` | frozen, entree, meal kit, baby |
| `chicken bowl` | 350 g | `bowl chicken cooked` | frozen, entree, baby |
| `salad with chicken` | 300 g | `salad chicken breast` | pasta, noodle, soup, baby |
| `chicken salad` | 200 g | `chicken salad` | noodle, soup, pasta, baby |
| `protein shake` | 330 g | `protein shake beverage` | powder, dry, mix, isolate |

**`banana smoothie` intentionally has NO profile.** The existing `_MEAL_CALORIE_FLOOR["smoothie": 150]` rejects low-calorie USDA ingredient hits and returns the rule-based 300 kcal smoothie estimate. Adding a profile would bypass that floor and risk under-scaling.

**`salad with chicken` intentionally NOT in `_KNOWN_WHOLE_FOODS`.** Composite decomposition (salad ≈ 30 kcal + chicken ≈ 165 kcal ≈ 200 kcal) stays within the Phase 8D range and avoids USDA selecting a high-fat prepared chicken salad when looked up as a whole food.

**`_get_fallback_nutrition` additions:**
- `chipotle` → 680 kcal (added before generic burrito pattern)
- `protein shake` / `shake + protein` → 200 kcal (added before smoothie pattern, in both phrase-priority blocks)
- `bowl` → 580 kcal (generic meal bowl fallback for queries with no profile)

**Before / after (Phase 8D queries):**

| Query | Before | After |
| --- | --- | --- |
| `chicken rice bowl` | 126 kcal (frozen entree per-100g, FAIL) | 620 kcal (400g × profile USDA, PASS) |
| `protein shake` | 61 kcal (SlimFast per-100g, WARNING) | 201 kcal (330g × profile USDA, PASS) |
| `chipotle chicken bowl` | 250 kcal (generic rule-based, FAIL) | 680 kcal (chipotle fallback, PASS) |
| `banana smoothie` | 300 kcal (smoothie floor + fallback, PASS) | 300 kcal (unchanged, PASS) |
| `salad with chicken` | ~200–450 kcal (composite decomposition, PASS) | 414 kcal (composite decomposition, PASS) |

**Phase 8D benchmark: 38/46 (82%)** — up from 25/46 (54%) at the Phase 8D baseline.

By category after Phase 9 (9A + 9B + 9C + 9D):
- Serving-size ambiguity: 7/7
- Egg & protein: 10/11
- Sandwiches: 5/6
- Restaurant/branded: 4/8 (OFF search coverage is the remaining bottleneck)
- Composite foods: 7/7 ← coffee with milk fixed in 9D
- Quantity scaling: 5/7

**Tests: 111/111 passing** (11 new Phase 9D tests). Phase 8B audit unchanged (29/29).

**Remaining ambiguous case — `chicken salad`:** This query can mean (a) a leafy salad with chicken breast or (b) a mayo-based chicken salad spread. USDA FNDDS "Salad, chicken" typically describes a mayo-based preparation (~200 kcal/100g). The profile uses `default_grams=200` which gives a conservative single-serving result for either interpretation. If the user wants grilled chicken on greens, the result may over-estimate; if they want a mayo sandwich filling, it may be accurate. Not fixable without further query context.

---

### Phase 9B (completed 2026-06-04)

Added composite-food guardrails to prevent known single-food phrases from being over-fragmented, plus USDA-steering profiles for common sandwiches. No new APIs, no routing architecture changes, no schema changes.

**Root cause of over-fragmentation:**
`_is_composite` fires when `" and "` is present in `core_food` (e.g. "peanut butter **and** jelly sandwich"). `_build_components` then splits on `" and "` → `["peanut butter", "jelly sandwich"]`. "jelly sandwich" had no matching USDA entry and triggered the generic sandwich fallback (450 kcal), summing to 188 + 677 = 865 kcal.

**Files changed:**
- `backend/app/services/composite_service.py` — added `_KNOWN_WHOLE_FOODS` frozenset; added known-whole-food fast-path at the top of `decompose_composite` that calls `get_nutrition(query, prefer_generic=True)` directly and skips component splitting.
- `backend/app/services/nutrition_service.py` — added 6 sandwich profiles in `_GENERIC_FOOD_PROFILES` (`peanut butter and jelly sandwich`, `peanut butter sandwich`, `grilled cheese sandwich`, `turkey sandwich`, `turkey sandwich on wheat`, `turkey sandwich on rye`); added PBJ short-form aliases (`pbj sandwich`, `peanut butter jelly sandwich`) to `_PROFILE_ALIASES`.
- `backend/tests/test_nutrition_unit.py` — added `TestCompositeGuardrails` class (9 new tests).

**Known-whole-food set:**
```
peanut butter and jelly sandwich  |  pbj sandwich  |  peanut butter jelly sandwich
peanut butter sandwich  |  grilled cheese sandwich
turkey sandwich  |  turkey sandwich on wheat  |  turkey sandwich on rye
```

**Before / after:**

| Query | Before | After |
| --- | --- | --- |
| `peanut butter and jelly sandwich` | 865 kcal (fragmented: PB + jelly sandwich) | ~387 kcal (167g × profile USDA) |
| `peanut butter sandwich` | 478 kcal from "Cookies, peanut butter sandwich" | ~364 kcal from "Sandwich, peanut butter" (avoid_terms blocks cookie) |
| `turkey sandwich on wheat` | 450 kcal (rule-based fallback) | ~340 kcal (profile USDA + 170g default) |

**Tests: 93/93 passing** (9 new Phase 9B tests). Phase 8B audit unchanged (29/29).

---

### Phase 9A (completed 2026-06-04)

Added profile-coverage alias tables to fix plural-form and preparation-method mismatches identified in Phase 8D. No nutrition values were changed. No new APIs, routing systems, or database schemas were modified.

**Files changed:**
- `backend/app/services/nutrition_service.py` — added `_PROFILE_ALIASES` dict; updated `_profile_for_query` to resolve aliases after direct lookup fails.
- `backend/app/services/verified_foods.py` — added `_VERIFIED_ALIASES` dict; updated `verified_entry_for_query` to resolve aliases.
- `backend/tests/test_nutrition_unit.py` — added `TestProfileAliases` class (20 new tests).

**Alias design:**

Two separate alias tables with different scope:

| Table | Location | Purpose |
| --- | --- | --- |
| `_PROFILE_ALIASES` | `nutrition_service.py` | Maps normalized query → canonical `_GENERIC_FOOD_PROFILES` key. Covers plural forms + prep-method variants. |
| `_VERIFIED_ALIASES` | `verified_foods.py` | Maps normalized query → canonical `_VERIFIED_FOODS` key. Covers plural forms only (nutrition is truly identical to singular). |

Prep-method variants (scrambled, fried, boiled, grilled) are in `_PROFILE_ALIASES` only — not in `_VERIFIED_ALIASES` — so the USDA search path still fires and can pick the most accurate cooked-form entry. Cooking-fat differences (butter for scrambled eggs, oil for grilled chicken) are not estimated in this phase.

**Observed improvements over Phase 8D baseline:**

| Query | Before | After |
| --- | --- | --- |
| `bananas` | 170 kcal (per-100g × 1, WARNING) | 100.3 kcal (118g verified, PASS) |
| `2 bananas` | 170 kcal (2 × 100g) | 200.6 kcal (2 × 118g verified) |
| `2 apples` | ~104 kcal (2 × 100g, WARNING) | ~189 kcal (2 × 182g profile) |
| `scrambled eggs` | 149 kcal "per 100g" (WARNING) | 74.5 kcal / 50g serving (serving context clear) |
| `grilled chicken breast` | 151 kcal "per 100g" (WARNING) | 165 kcal / 100g serving (serving context clear) |

**Tests: 84/84 passing** (20 new Phase 9A tests). Phase 8B audit unchanged (29/29).

---

### Phase 8D (completed 2026-06-04)

Added `backend/scripts/audit_phase8d.py` — a real-world query benchmark covering 46 realistic user-typed queries across 6 categories. No food-engine behavior was changed.

**Script design:**
- `Phase8DCase` dataclass with a tight PASS calorie range and an auto-computed WARNING band (~55%–165% of range endpoints).
- Three-tier verdict: **PASS** (in range, no critical concerns) / **WARNING** (plausible but has a concern: wrong routing, per-100g returned for a serving query, unexpected fallback) / **FAIL** (clearly wrong calories, wrong-food source, or zero when >0 expected).
- `_classify_root_cause()` maps each non-PASS result to one of: `source_selection`, `serving_size_scaling`, `quantity_parsing`, `modifier_handling`, `branded_food_routing`, `restaurant_food_routing`, `composite_interpretation`, `unknown`.
- Auto-generated recommendations section driven by root-cause frequency counts.
- `--verbose` shows source_name per row; `--json` emits machine-readable output.

**Live audit result (2026-06-04): 25/46 PASS (54%), 16 WARNING, 5 FAIL**

| Category | Score | Notes |
| --- | --- | --- |
| 1. Serving-size ambiguity | 7/7 (100%) | large/small/medium modifiers all handled correctly |
| 2. Egg and protein variations | 6/11 (54%) | verified registry handles egg counts; prep-modifier variants (scrambled/fried/boiled/grilled) all WARNING |
| 3. Sandwiches and modifiers | 3/6 (50%) | `peanut butter sandwich` FAIL (cookie source); PBJ composite WARN (865 kcal over-count) |
| 4. Restaurant and branded foods | 3/8 (37%) | OFF search returns 0 results for all tested chains/brands; everything falls to rule-based fallback |
| 5. Composite foods | 4/7 (57%) | `chicken rice bowl` FAIL (126 kcal per-100g, expected 318–985); `coffee with milk` calibration note below |
| 6. Quantity and scaling tests | 2/7 (28%) | plural forms miss profile lookup; per-100g × count instead of profile.default_grams × count |

**Key diagnostic findings:**

| Finding | Affected queries | Root cause |
| --- | --- | --- |
| OFF restaurant/packaged search returning 0 results | mcdonalds cheeseburger, mcdonalds fries, chipotle chicken bowl, starbucks caramel frappuccino, hershey bar, oreo cookies | All 6 show `restaurant_guess` or `packaged_guess` — rule-based fallbacks only. Passes only because some fallback estimates happen to land in range. |
| Prep-modifier variants have no profiles | scrambled eggs, fried eggs, boiled eggs, grilled chicken breast | Returns per-100g USDA data without a natural serving. Calories plausible (WARNING) but serving context missing. |
| Plural forms miss profile/verified lookup | 2 bananas, 3 bananas, 2 apples | Profile keys are singular (`banana`, `apple`). Plural form uses per-100g × count (100g each) instead of profile.default_grams × count (118g/182g each). ~15–20% undercounting. |
| PBJ composite over-fragments | peanut butter and jelly sandwich | `" and "` in core_food triggers COMPOSITE_MEAL; decomposed as `peanut butter` + `jelly sandwich` → 865 kcal (expected ~400–500). |
| Meal-type USDA queries return per-100g unscaled | chicken rice bowl, protein shake | USDA returns a per-100g entry for a meal-type food with no profile → underestimates calories significantly (126 kcal for a rice bowl). |
| `costco hot dog` wrong USDA source | costco hot dog | `costco` not in `_RESTAURANT_SIGNALS` → GENERIC_FOOD routing; USDA matches "Pickle relish, hot dog" → 91 kcal. |
| `coffee with milk` composite calibration | coffee with milk | Returns 251 kcal (composite: coffee ≈ 0 + full cup of milk ≈ 150 + overhead). FAIL against benchmark range 18–128. Range was too narrow; however the composite service's default "1 cup of milk" interpretation for "with milk" may over-count for typical users who add a splash, not a cup. |

**Fix targets for Phase 9 (ordered by user impact):**
1. **OFF search coverage** — investigate why McDonald's, Chipotle, Hershey, Oreo queries return 0 results. May be a query construction issue in packaged/restaurant service.
2. **Plural-form aliases** — add `"bananas"`, `"apples"`, `"chicken breasts"` as aliases in `_GENERIC_FOOD_PROFILES` pointing to the same profile as the singular form.
3. **Prep-modifier profiles** — add profiles for `scrambled eggs`, `fried eggs`, `boiled eggs`, `grilled chicken breast` with appropriate `default_grams` (2-egg serving ≈ 120g, single chicken breast ≈ 150g).
4. **Composite "with" serving sizes** — revisit how composite components are portioned; "with milk" should default to ~30g (tablespoon) not 244g (full cup) for a coffee add-in context.
5. **Meal-type USDA queries** — add profiles for `chicken rice bowl`, `protein shake` with appropriate default servings; or add meal-calorie-floor checks to prevent per-100g returns for multi-ingredient meals.
6. **`costco hot dog`** — either add `costco` to `_RESTAURANT_SIGNALS` or add a `hot dog` profile that avoids relish.

---

### Phase 8C (completed 2026-06-04)

Added `backend/scripts/audit_phase8c.py` — a broader diagnostic benchmark covering 25 food queries across 5 categories. No food-engine behavior was changed.

**Script design:**
- `Phase8CCase` dataclass with per-macro tolerance ranges (cal/protein/carbs/fat min–max).
- Evaluates actual vs. expected range for all four macros; overall PASS requires all four to pass.
- `_diagnose()` identifies likely failure causes: rule-based-fallback, unit-not-scaled, calories-way-too-high/low, service-miss-fallback.
- Failure details section lists which macros failed and why, with source type, serving description, and source name.
- `--verbose` flag adds source name per row in the main table.
- `--json` flag emits machine-readable output.

**Live audit result (2026-06-04): 19/25 (76%)**

| Category | Score | Notes |
| --- | --- | --- |
| Piece-based foods | 5/5 (100%) | All verified/profiled; scaling correct |
| Cup-based foods | 5/5 (100%) | All profiles have `unit_grams["cup"]`; scaling correct |
| Tablespoon/Teaspoon | 2/4 (50%) | olive oil + peanut butter pass; butter + sugar fail |
| Gram/Ounce proteins | 4/5 (80%) | 100g and 4 oz chicken pass; 4 oz steak fails |
| Mixed/simple foods | 3/6 (50%) | turkey sandwich, cheeseburger, chocolate donut pass |

**Failure root-cause analysis:**

| Query | Failure | Root cause |
| --- | --- | --- |
| `1 tbsp butter` | 717 kcal returned (expected 85–128) | No profile for `butter` → `_grams_from_unit` never called → per-100g USDA data returned unscaled |
| `1 tsp sugar` | 385 kcal returned (expected 10–25) | No profile for `sugar` → same per-100g unscaled issue; USDA source correct ("Sugars, granulated") |
| `4 oz steak` | 0 kcal returned (expected 195–350) | No profile for `steak` → `oz` quantity treated as item count; USDA steak search returns zero-calorie abbreviated result, triggers rule-based fallback at 0 |
| `peanut butter sandwich` | Wrong source | USDA matched "Cookies, peanut butter sandwich, regular" (a cookie); macros reflect a cookie per 100g, not a sandwich |
| `cheese pizza slice` | Wrong source | USDA matched "Cheese, provolone, sliced"; no pizza content |
| `hot dog` | Wrong source + 91 kcal | USDA matched "Pickle relish, hot dog" (the condiment) instead of the sausage |

**Note on USDA non-determinism:** `cheeseburger` returned 296 kcal on one run and 650 kcal on another due to USDA search result ordering variance. The 650 kcal run passes; 296 kcal fails. This is a known limitation of live USDA search.

**Identified fix targets for Phase 9:**
1. Add `GenericFoodProfile` entries for `butter` and `sugar` with `unit_grams` for tbsp/tsp → fixes 2 failures.
2. Add profile for `steak` with oz-compatible `default_grams` → fixes 1 failure.
3. Improve USDA query/scoring for `hot dog` and `cheese pizza slice` to avoid wrong-food source selection → fixes 2 failures.
4. `peanut butter sandwich` needs composite decomposition or a specific profile.

---

### Phase 8B (completed 2026-06-03)

Implemented the verified common-food architecture. A new `verified_foods.py` module provides an offline registry that bypasses live USDA search for a pilot set of 5 audited foods.

**Architecture:**
- `backend/app/services/verified_foods.py` — new module. `VerifiedFoodEntry` dataclass (per-100g nutrition + `default_grams` / `unit_grams` for scaling). `_VERIFIED_FOODS` dict keyed on `_normalize_query()` output. `verified_entry_for_query()` lookup helper.
- `nutrition_service._fetch_nutrition()` — verified fast-path inserted before any USDA network call when `prefer_generic=True`. Returns per-100g nutrition instantly without HTTP.
- `scripts/audit_generic_foods.py` — `_evaluate` updated to accept `"verified_generic"` as a valid subtype of `"generic"` in `expected_source_type` checks.

**Verified foods added (pilot):**

| Key | Source name | Cal/100g | Default serving |
| --- | --- | ---: | --- |
| `banana` | Bananas, overripe, raw | 85.0 | 118 g |
| `egg` / `eggs` | Eggs, Grade A, Large, egg whole | 148.0 | 50 g |
| `chicken breast` | Chicken, broilers or fryers, breast, meat only, cooked, roasted | 165.0 | 100 g |
| `white rice` | Rice, white, cooked, as ingredient | 130.0 | 158 g |
| `olive oil` | Oil, olive, salad or cooking | 884.0 | 13.5 g (1 tbsp) |

**Metadata returned by verified entries:**
- `source_type`: `"verified_generic"` (distinguishable from USDA-backed `"generic"`)
- `is_estimated`: `False`
- `confidence`: `1.0` at the service layer; normalised to `0.85` by the router (which overwrites confidence for all GENERIC_FOOD paths)

**Behavior preserved:**
- Verified entries coexist with `_GENERIC_FOOD_PROFILES` — profiles still handle all scaling (`default_grams`, `unit_grams`) via duck typing.
- Non-verified foods follow the existing USDA search path unchanged.
- Quantity and unit scaling are identical to the USDA path (same `grams/100` multiplier).
- `1 tbsp olive oil` → 119.3 kcal ✓, `2 eggs` → 148.0 kcal ✓, `1 cup white rice` → 205.4 kcal ✓.

**Tests:** 4 new Phase 8B regression tests + 7 existing tests updated to reflect verified-food behavior; **64 total passing**.

**Live audit result: 29/29 passed.**

### Phase 7B (completed 2026-06-03)

Fixed broccoli source returning `Broccoli raab, cooked` instead of plain broccoli.

**Profile change in `nutrition_service.py`:**

| Profile | Change |
| --- | --- |
| `broccoli` | Added `"raab"` to avoid_terms |

**Tests:** 1 new regression test (`test_broccoli_profile_penalizes_raab`); 60 total passing.

**Live audit result: 29/29 passed.** Broccoli now returns `Broccoli, cooked, as ingredient`.

### Phase 7A (completed 2026-06-03)

Implemented targeted food-engine profile fixes from Phase 7 audit review.

**Profile changes in `nutrition_service.py`:**

| Profile | Change |
| --- | --- |
| `broccoli` | Added `"chinese"` to avoid_terms |
| `oatmeal` | Added `"multigrain"` to avoid_terms; changed search_query to `"oatmeal cooked plain"` |
| `ground beef` | Added `"patties"` and `"frozen"` to avoid_terms (plural gap fix) |
| `sweet potato` | Added `"frozen"` to avoid_terms |
| `brown rice` | Added `"parboiled"` to avoid_terms |
| `pasta` | Added `"homemade"` to avoid_terms |

**Audit fix:** Widened `avocado` max_calories from 330 → 360 in `audit_generic_foods.py`.

**Tests:** 6 new regression tests added; 59 total passing.

**Live audit result: 29/29 passed.**

**Remaining suspicious sources (passes, not failures):**
- `oatmeal` → `Oatmeal, fast food, plain` — FNDDS fast-food entry; nutritionally close (80 cal/100g vs 71 cal/100g expected) but not ideal. The `"plain"` qualifier is correct; the source is acceptable for now.

### Phase 6 (completed 2026-06-03)

Expanded coverage benchmark in `scripts/audit_generic_foods.py`. No food-engine behavior changed.

- Added `COVERAGE_BENCHMARK` (16 cases): fruits, vegetables, grains, proteins, dairy, legumes.
- Each case has a calorie range and targeted `disallowed_source_terms` mirroring the profile's avoid_terms.
- Summary now reports three sections: source-quality, quantity-scaling, coverage.
- Live run result: **28/29 passed**. One failure:
  - `avocado` — audit range too tight; widened in Phase 7A.

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

1. ~~Run a live audit to confirm Phase 3 fixes~~ — done in Phase 5A; 8/8 passing.
2. ~~Expand benchmark to cover generic whole foods~~ — done in Phase 8C (25 foods, 5 categories).
3. ~~Real-world query diagnosis~~ — done in Phase 8D (46 queries, 6 categories, root-cause classification).
4. **Phase 9 fix targets** (combined from 8C + 8D root-cause analysis, ordered by user impact):
   - **OFF search coverage** — investigate why McDonald's, Chipotle, Hershey, Oreo all return 0 results from Open Food Facts. All show `restaurant_guess`/`packaged_guess`; only rule-based fallbacks fire.
   - ~~**Plural-form aliases**~~ — done in Phase 9A (`bananas`, `apples`, `oranges`, `chicken breasts` aliased in both `_PROFILE_ALIASES` and `_VERIFIED_ALIASES`).
   - ~~**Prep-modifier aliases**~~ — done in Phase 9A (`scrambled/fried/boiled/poached eggs`, `grilled/baked chicken breast` aliased in `_PROFILE_ALIASES`).
   - ~~**Unit-missing profiles**~~ — done in Phase 9D (`butter` tbsp=14.2g/tsp=4.7g, `sugar` tsp=4g/tbsp=12g).
   - ~~**Steak oz profile**~~ — done in Phase 9D (`steak` profile, default_grams=170, oz handled by `_grams_from_unit`).
   - ~~**Composite "with" portioning (coffee)**~~ — done in Phase 9D (`coffee with milk` in `_KNOWN_WHOLE_FOODS` + `"coffee with": 35` floor → 50 kcal fallback).
   - **Composite "with" portioning (other add-ins)** — "with X" for non-coffee composites may still over-portion; revisit if needed.
   - **`costco hot dog`** — add `costco` to `_RESTAURANT_SIGNALS` or add `hot dog` profile with avoid_terms for relish.
   - **`turkey sandwich on rye`** — USDA selects "Crackers, rye, sandwich-type with cheese filling" (817 kcal). Add `"crackers"` to avoid_terms for the `turkey sandwich on rye` profile.
5. Add regression tests for any Phase 9 fixes before merging.
6. Only after local validation, discuss whether any Supabase migration or deployment change is needed.
