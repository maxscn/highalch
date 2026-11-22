# CRM transition example

Template for the CRM team: `f(state, action) => next state` transition tests reported to HighAlch Console.

- `tests/composer.transition.test.ts` — the composer state machine (Effect Schema state/actions)
  driven by `Fuzz.run` with seeded action sequences, an invariant, JSON round-trips, and a
  deliberately failing invariant showing the shrunk counterexample.
- `tests/customer-card.transition.test.tsx` — a React component rendered in happy-dom for every
  case generated from an Effect Schema (`fromEffect` + `Fuzz.cases` + `reactHtml`), with edge tags.

```bash
vp test --project console-example    # from the repository root
```

Without `HIGHALCH_URL` + credentials the reporter writes to `.highalch/runs/<id>/` in the working
folder; inspect `results/*.json` and `artifacts/*.html`.
