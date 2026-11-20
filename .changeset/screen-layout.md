---
"@lowalch/tanstack-db": patch
"@highalch/story": patch
---

Screens take their engines as pipe steps, and can be laid out for rules. Breaking: `Screen.make({ css, width, height })` mounts and checks a component only; `.pipe(Takumi.frames({ baselines, output, update }))` gives it frames (replacing the `painter`, `baselines`, `output` and `update` options and `Takumi.layer()`), and `.pipe(Takumi.layout())` gives it a layout engine (the `LayoutOf` service, beside `PainterOf`). A screen has only the steps and readers its engines give: `shot` and `render(element, { every })` with frames, `Card.layout()` with a layout engine. `Card.layout()` is a rule reader of every element's box, and `Screen.overflowing(layout)` lists what spills out of its box, named by element (`section.card > h1.title: text "WWWW…" runs 788px past its right edge`), honouring `overflow` from the computed style. `Form.typing` now tries a string field's longest accepted value (`Schema.isMaxLength(n)`) before its seeded samples, so an exploration reaches a field's declared edge.
