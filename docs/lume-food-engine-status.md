# Lume Food Engine Status

Phase 1 scope: document the current generic-food benchmark goals and add a small local audit script. This phase does not change food-engine behavior, production settings, Render, Vercel, Supabase, env secrets, schema, or deployment configuration.

## Current Benchmark Goal

The near-term target is reliable generic whole-food nutrition before expanding deeper into branded packaged foods, restaurant meals, barcode scans, and complex composite meals.

The audit should help check:

- Calories and macros are in a reasonable range.
- Source type is clear.
- Estimated fallbacks are visible.
- Serving descriptions are understandable.
- Quantity scaling works for simple queries.

## Small Phase 1 Audit Set

The script currently checks:

- `banana`
- `white rice`
- `100g chicken breast`
- `whole milk`
- `almonds`
- `pasta`
- `1 tbsp olive oil`
- `2 eggs`

Run it locally only when a live spot check is wanted:

```bash
cd backend
python3 scripts/audit_generic_foods.py
```

For structured output:

```bash
cd backend
python3 scripts/audit_generic_foods.py --json
```

The script may call USDA through existing backend code. Do not treat one live run as a permanent truth source; use it as a quick signal for current behavior.

## Current Phase 1 Audit Results

Run date: `2026-06-02 CDT`

Command:

```bash
cd backend
python3 scripts/audit_generic_foods.py
```

Summary: `7/8 passed`

| Query | Status | Calories | Estimated | Serving | Source | Notes |
| --- | --- | ---: | --- | --- | --- | --- |
| `banana` | PASS | 100.3 | false | `118 g serving` | `Bananas, overripe, raw` | Source-backed, but source display is more specific than ideal. |
| `white rice` | PASS | 153.3 | false | `158 g serving` | `Rice, white, glutinous, unenriched, cooked` | Passed range check, but glutinous rice may be the wrong default. |
| `100g chicken breast` | PASS | 165.0 | false | `100 g` | `Chicken, broilers or fryers, breast, meat only, cooked, roasted` | Good source-backed result. |
| `whole milk` | PASS | 151.3 | false | `244 g serving` | `Milk, buttermilk, fluid, whole` | Passed range check, but buttermilk is likely the wrong source for plain whole milk. |
| `almonds` | FAIL | 250 | true | `None` | `None` | Worst failure: estimated fallback and calories outside the expected range. |
| `pasta` | PASS | 176.4 | false | `140 g serving` | `Pasta, gluten-free, corn, cooked` | Passed range check, but gluten-free corn pasta is likely the wrong default. |
| `1 tbsp olive oil` | PASS | 119.3 | false | `1 tbsp` | `Oil, corn, peanut, and olive` | Calories are reasonable, but source is a mixed-oil entry rather than plain olive oil. |
| `2 eggs` | PASS | 196.0 | false | `100 g serving` | `Egg, whole, cooked, fried` | Passed range check, but fried egg may be the wrong default for plain eggs. |

## Known Issues To Investigate Later

- Generic foods may return inaccurate calories/macros even when the app understands the food.
- USDA/generic matching needs better source ranking and clearer wrong-form rejection.
- Quantity handling and serving descriptions need to stay consistent across the API and frontend.
- The system should avoid vague estimates when reliable source data exists.
- Some older backend serving-column changes may be incomplete and should be preserved unless intentionally finished or replaced.
- The frontend is still mostly one large `App.tsx`; gradual extraction is preferred when touching specific features.

## Next Steps

1. Fix `almonds` first because it is the only current hard failure: estimated fallback, no source, and calories outside the expected range.
2. Then improve source ranking for passed-but-suspicious items: `whole milk`, `pasta`, `1 tbsp olive oil`, `2 eggs`, and `white rice`.
3. Propose focused behavior changes before implementing them.
4. Add or update regression tests for any approved food-engine fixes.
5. Only after local validation, discuss whether any Supabase migration or deployment change is needed.
