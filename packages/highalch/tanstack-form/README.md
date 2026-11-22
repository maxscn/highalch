# @highalch/tanstack-form

`Form`: the app's own TanStack Form forms in [HighAlch stories](../story/README.md): type (`Form.when`), submit (`Form.submit`), expect (`Form.then`), read them for rules (`Form.state`), and `Form.typing`, a source for explorations. The app wires nothing: the `highalch()` Vite plugin (`@highalch/tanstack-form/vite`) lets stories find the forms it mounts.

```ts
import { Form } from "@highalch/tanstack-form";
import { highalch } from "@highalch/tanstack-form/vite"; // in the Vite (Vitest) config: plugins: [highalch()]
```

Peer dependencies: `@highalch/story`, `@tanstack/react-form`, `react`, `effect`. The guide to stories, with this package's steps in context, is
[`@highalch/story`'s README](../story/README.md#the-steps).
