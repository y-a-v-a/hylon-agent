# hylon

**A generic autonomous art agent: feed it an artistic DNA, and it generates
works, has an independent AI jury grade them, and publishes only what you
approve.**

hylon is the generic extraction of [vana](https://github.com/y-a-v-a/vana) —
the *process* without the person. The harness encodes **no taste of its own**:
everything about what a work should be lives in one document you write,
`identity/DNA.md`.

> **This repo is a blueprint, not an installation.** Don't run the agent from
> this repository — make your own copy first. It's a GitHub template: click
> **Use this template** (or fork it), so your agent gets its own repo. That
> matters because the repo *is* the artwork's archive: every candidate the
> agent makes — pending, rejected, orphaned — is committed to git, and your
> works belong in your repository, not in the blueprint.

## How it works

```
DNA  →  generate (OpenRouter model)  →  jury (different OpenRouter model)  →  hard human gate  →  publish
        a self-contained web work       scores it against the DNA's rubric    you approve from     to any static host
                                        (the harness computes the verdict)    the local dashboard
```

- **Generator** — an agentic file-tool loop (OpenRouter tool calling): the
  model writes a single self-contained `index.html` (plus a motivation and
  metadata) with its own `write_file`/`read_file` tools, reading its work back
  and self-correcting before handing it in. Zero external requests in the work.
- **Jury** — a *different* model grades it against your DNA's rubric. The
  model only supplies gate booleans and scores; the harness computes the
  weighting, thresholds, and verdict deterministically.
- **Hard gate** — nothing goes live without your approval on the local
  dashboard. The jury's verdict stays private; the work and its motivation go
  public.
- **Autonomous** — a daemon wakes on an interval, bounded by a time + dollar
  budget, and notifies you (email, or console log) when something clears the
  jury.

Both agents run through **OpenRouter** with a single key, so any model pairing
is one config edit away.

## Quickstart

```sh
# 1. On GitHub: "Use this template" (or fork) → your-name/your-agent
git clone git@github.com:your-name/your-agent.git && cd your-agent
npm install
cp .env.example .env               # set OPENROUTER_API_KEY (the only required secret)
cp identity/DNA.template.md identity/DNA.md
$EDITOR identity/DNA.md            # ← make it yours; this is the whole point
npm run seed                       # optional: seeds catalogue.json (from identity/catalogue.seed.json if present)
npm test                           # dependency-less node:test suite
npm run once                       # one generate → jury → (maybe) notify cycle
npm run dashboard                  # the approval gateway, http://localhost:4737
```

Going autonomous (launchd) and publishing (any static host / Vercel) are
documented in [`ops/DAEMON.md`](ops/DAEMON.md) and [`ops/DEPLOY.md`](ops/DEPLOY.md).

## Configuration — `agent.config.json`

| Key | What it does |
|---|---|
| `name` | display name (dashboard, notifications, OpenRouter X-Title) |
| `models.generator` / `models.jury` | **the OpenRouter model ids** for each agent — keep them different vendors so no model grades its own output |
| `generation` | `mode`: `"agentic"` (default — file-tool loop, needs a model with tool-calling support) or `"single-shot"` (one delimited completion, for models without tools); plus `maxTurns`, `temperature`, `maxTokens` (per turn) |
| `technologies` | the palette. `apis`: browser APIs the generator is told are in bounds (SVG, Canvas 2D, WebGL, Web Audio, CSS animation by default — the only hard limit is still zero external requests). `libraries`: vendored libraries by name → file (e.g. `"threejs": "vendor/three.min.js"`); the generator uses a `<script data-vendor="name"></script>` placeholder and the harness inlines the source at render/build time. See [`vendor/README.md`](vendor/README.md) |
| `rubric` | the jury's shape: hard-gate ids, scored dimensions + weights, `scoreMax`. Your DNA §8 defines what they *mean* — keep the two in sync |
| `thresholds` | weighted-total cutoffs for `strong` / `borderline` (else reject) |
| `amendments` | the self-amending DNA: `enabled`, `minSignals` (new signals before the agent may petition), `model` (empty = generator model) |
| `interval`, `workBudget`, `costFuse` | wake schedule, per-wake time budget, $ ceilings per wake/day |
| `paths` | DNA, catalogue, guidance, and lifecycle directories |
| `dashboard` | port + the hostname used in notification links (e.g. a tailnet host) |
| `email.to` | notification recipient (empty = console log) |
| `git` | remote/branch and whether wakes auto-push. Ships as `push: false`; flip it to `true` once the agent lives in **your** repo and you want every candidate pushed (that also makes approvals trigger a site deploy) |
| `site` | title/lede/footer of the assembled public catalogue page |

Secrets come from `.env` (or your shell env): `OPENROUTER_API_KEY` is the base
connector key for both agents; `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` (+ optional
`SMTP_PORT`/`SMTP_FROM`) enable real email if you want it.

## The lifecycle

```
workspace/pending/<id>/     awaiting your approval    { index.html, motivation.md, meta.json, jury.json }
workspace/published/<id>/   approved — publicly served
workspace/rejected/<id>/    archived, discarded
workspace/orphaned/<id>/    finished but never juried (recoverable from the dashboard)
catalogue.json              every work + status; feeds the duplicate gate and the generator's memory
```

From the dashboard you can **Approve**, **Reject** (optionally with a note the
generator learns from next round), **Refine** (the agent reworks a pending
candidate from your feedback), and **Re-jury** orphans.

## The self-amending DNA

You initiate the DNA from your artistic work *so far* — but your decisions at
the gate are themselves artistic statements, and they may drift away from what
the document says. hylon treats that drift as material: when enough new signals
accumulate (rejection notes and refinement requests — `amendments.minSignals`,
default 5), the agent may file an **amendment petition**: a rationale citing
your specific notes, plus the complete revised DNA. The petition lands on the
dashboard as a colorized diff with **Ratify** / **Decline** (+note) buttons.

- Ratifying is the **only** code path that rewrites `identity/DNA.md` — the
  agent proposes, you legislate. Every petition, accepted or declined, is
  archived under `identity/amendments/` and committed, so the DNA's git
  history reads as the record of an identity negotiated between artist and
  machine.
- Declined petitions (and your notes on them) are shown to future proposers so
  the agent doesn't re-litigate what you turned down.
- Petitions are conservative by prompt (amend only what the signals support,
  never touch the rubric anchors wired to config), fuse-metered, and checked
  after each wake. Force one anytime with `npm run amend`.

## Invariants (kept from vana)

- **The hard gate is sacred** — nothing reaches `published/` without your click.
- **Two vendors, always** — generator ≠ jury.
- **Self-contained, enforced in layers** — a regex denylist at generation time,
  and a restrictive CSP + sandboxed iframe at render time.
- **`jury.json` is private** — committed as the record, never published.
- **The DNA is the only taste authority — and only you rewrite it.** The agent
  may *petition* to amend it from your accumulated decisions, but ratification
  at the gate is the sole code path that touches `identity/DNA.md`.
- **The budget is a fuse, not a target.**

The full as-built design is in [ARCHITECTURE.md](ARCHITECTURE.md); the build
log is in [PROGRESS.md](PROGRESS.md).

---

Process extracted from [vana](https://github.com/y-a-v-a/vana) by Vincent
Bruijn (y-a-v-a). Open license by default · no cookies · no tracking.
