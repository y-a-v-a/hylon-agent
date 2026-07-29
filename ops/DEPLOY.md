# Deploy — the public site

The public site is **assembled, not raw**: `npm run build:site` reads
`workspace/published/*` and writes `dist-site/` containing, per work,
`index.html` + `motivation.md` + `meta.json` — and a catalogue `index.html`
(title/lede/footer from `site` in `agent.config.json`). **`jury.json` is never
copied** (the private jury verdict stays private). A visitor lands on each
work's `index.html`; `motivation.md` is reachable at `/<id>/motivation.md`.

Any static host works. The included `vercel.json` adds the restrictive CSP that
backstops self-containment — replicate those headers if you host elsewhere.

## Vercel native Git integration (the low-friction path)

1. **Create the project**
   - vercel.com → **Add New… → Project** → **Import Git Repository** → your clone of this repo

2. **Configure build settings** (on the import screen)
   - **Framework Preset:** Other
   - **Build Command:** `npm run build:site`
   - **Output Directory:** `dist-site`
   - **Install Command:** `npm ci`
   - Root Directory: `./` (default). No environment variables needed.

3. **Deploy.** The first build serves the current catalogue (empty is fine).

4. **Point a domain** — Project → **Settings → Domains** → add yours, set the
   CNAME it shows at your DNS.

Every push to the deploy branch triggers a rebuild. When you Approve a
candidate, the dashboard pushes `workspace/published/` → redeploy with the new
work. `dist-site` is the only thing served, so `jury.json` never ships.

> Optional: to deploy only when published works change (not on every push), set
> an **Ignored Build Step** in Vercel:
> `git diff --quiet HEAD^ HEAD -- workspace/published src/site.ts || exit 1`

## Verifying

```sh
npm run verify:deploy -- https://your-domain.example
```

Checks: catalogue 200, restrictive CSP present, a work + its motivation served,
and `/<id>/jury.json` → **404** (must not exist).
