# vendor/ — pinned libraries for the technology palette

Vendored libraries let works use Three.js-class dependencies **without
breaking the zero-external-requests invariant**. The generator never loads a
CDN and never pastes library code; it writes a placeholder:

```html
<script data-vendor="threejs"></script>
```

and the harness splices the real source in at render/build time (dashboard
preview and `npm run build:site`). The stored work stays small and reviewable;
the published page is one self-contained file.

## Adding a library (example: Three.js)

1. Pin the file into this directory and commit it:

   ```sh
   npm install --no-save three
   cp node_modules/three/build/three.min.js vendor/three.min.js
   ```

2. Declare it in `agent.config.json`:

   ```json
   "technologies": {
     "apis": ["svg", "canvas-2d", "webgl", "webaudio", "css-animation"],
     "libraries": { "threejs": "vendor/three.min.js" }
   }
   ```

3. That's it. The generator's prompt now offers the library and explains the
   placeholder; the jury is told the placeholder is sanctioned; a placeholder
   naming an *undeclared* library counts as a self-containment violation.

## Rules

- Use a **classic script build** (a global like `window.THREE`), not an ES
  module that needs an import map.
- The file must not contain the sequence `</script>` — the harness refuses to
  inline it if it does (it would break the surrounding page).
- Committing the file is the point: the repo must render its own works forever,
  with no network and no package registry involved.
- Mind the license of what you vendor; the work publicly states its own
  license, and the library ships inside the published page.
