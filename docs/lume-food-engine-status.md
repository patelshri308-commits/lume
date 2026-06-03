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

## Known Issues To Investigate Later

- Generic foods may return inaccurate calories/macros even when the app understands the food.
- USDA/generic matching needs better source ranking and clearer wrong-form rejection.
- Quantity handling and serving descriptions need to stay consistent across the API and frontend.
- The system should avoid vague estimates when reliable source data exists.
- Some older backend serving-column changes may be incomplete and should be preserved unless intentionally finished or replaced.
- The frontend is still mostly one large `App.tsx`; gradual extraction is preferred when touching specific features.

## Next Steps

1. Run the small audit and record current failures without changing behavior.
2. Prioritize the highest-impact generic-food issues from the audit.
3. Propose focused behavior changes before implementing them.
4. Add or update regression tests for any approved food-engine fixes.
5. Only after local validation, discuss whether any Supabase migration or deployment change is needed.
