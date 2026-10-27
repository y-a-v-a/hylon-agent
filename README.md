# hylon

**A blueprint for an autonomous art-agent harness: feed it an artistic DNA,
and it generates works, has an independent AI jury grade them, and publishes
only what you approve.**

hylon is the generic extraction of [vana](https://github.com/y-a-v-a/vana) —
the *process* without the person. The harness encodes **no taste of its own**:
everything about what a work should be lives in one document you write,
`identity/DNA.md`. Everything else is the harness, the same for every artist:
the generate → jury → approve loop, the budgets, the archive in git, and
[three web interfaces](#three-interfaces) — a public catalogue for visitors, an
approval gateway for the artist, and an admin console for whoever runs the
machine.

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

## Three interfaces

The harness faces three audiences, and each gets its own web interface:

| Interface | For | Run it | Reachable from | Changes anything? |
|---|---|---|---|---|
| **Public catalogue** | visitors | `npm run build:site` → `dist-site/` on any static host (`vercel.json` included) | the web | no — static files |
| **Approval gateway** (the dashboard) | the artist | `npm run dashboard`, or served by the daemon — http://localhost:4737 | your machine and its network (e.g. a tailnet) | **yes — the only control surface** |
| **Admin console** | the operator | `npm run admin` — http://localhost:4747 | 127.0.0.1 only | no — read-only |

- **The public catalogue** is what the world sees: the approved works, each
  with its motivation, on an index page whose text comes from config `site`.
  Works are served under a restrictive CSP and make no external requests; the
  jury's verdict (`jury.json`) is never published. See
  [`ops/DEPLOY.md`](ops/DEPLOY.md).
- **The approval gateway** is the hard human gate. It lists the pending
  candidates and renders each in a sandboxed iframe beside its motivation and
  the jury's verdict, every juror's opinion and dissent included. Here you
  approve, reject (with a note the generator learns from), ask for a
  refinement, re-jury orphans, and ratify or decline the agent's DNA
  petitions. Notifications link here.
- **The admin console** is the instrument panel: what the artistic DNA
  currently is and whether the rubric in config still matches it, how the DNA
  has changed, which OpenRouter model is used for what, whether each one fits
  its role, and what it all costs. It only reads — see
  [The admin console](#the-admin-console).

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
npm run admin                      # the read-only admin console, http://localhost:4747
```

Going autonomous (launchd) and publishing (any static host / Vercel) are
documented in [`ops/DAEMON.md`](ops/DAEMON.md) and [`ops/DEPLOY.md`](ops/DEPLOY.md).

## Configuration — `agent.config.json`

| Key | What it does |
|---|---|
| `name` | display name (dashboard, notifications, OpenRouter X-Title) |
| `models.generator` / `models.jury` | **the OpenRouter model ids**. `jury` is one model (string) or a **panel** of up to 5 (array, e.g. `["minimax/minimax-m3", "openai/gpt-4o", "google/gemini-2.5-flash"]`): each juror grades independently and in parallel; the harness aggregates by strict per-gate majority (ties fail — prefer odd panels) and median scores, and records every juror's full opinion in `jury.json`, on the dashboard, and in the email. Keep the generator and every juror on different vendors |
| `generation` | `mode`: `"agentic"` (default — file-tool loop, needs a model with tool-calling support) or `"single-shot"` (one delimited completion, for models without tools); plus `maxTurns`, `temperature`, `maxTokens` (per turn) |
| `technologies` | the palette. `apis`: browser APIs the generator is told are in bounds (SVG, Canvas 2D, WebGL, Web Audio, CSS animation by default — the only hard limit is still zero external requests). `libraries`: vendored libraries by name → file (e.g. `"threejs": "vendor/three.min.js"`); the generator uses a `<script data-vendor="name"></script>` placeholder and the harness inlines the source at render/build time. See [`vendor/README.md`](vendor/README.md) |
| `rubric` | the jury's shape: hard-gate ids, scored dimensions + weights, `scoreMax`. Your DNA §8 defines what they *mean* — keep the two in sync |
| `thresholds` | weighted-total cutoffs for `strong` / `borderline` (else reject) |
| `amendments` | the self-amending DNA: `enabled`, `minSignals` (new signals before the agent may petition), `model` (empty = generator model) |
| `interval`, `workBudget`, `costFuse` | wake schedule, per-wake time budget, $ ceilings per wake/day |
| `paths` | DNA, catalogue, guidance, lifecycle directories, and the `usage` ledger (default `logs/usage.jsonl`) |
| `dashboard` | port + the hostname used in notification links (e.g. a tailnet host) |
| `admin` | `port` of the read-only admin console (default 4747; always bound to 127.0.0.1) |
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

## The admin console

The admin console (`src/admin.ts`, http://localhost:4747) is **read-only**: it
never writes the DNA, the config, or the workspace — ratifying a petition stays
the only path that rewrites `identity/DNA.md`. It re-reads everything on each
request, so config edits show up on reload.

- **Overview** — the DNA's essence and version, the model roster with a fitness
  light per role, today's spend against the fuse, works per lifecycle state, the
  daemon (running? when does it wake next? is its gateway port taken by another
  agent?), the environment, and a ranked *needs attention* list.
- **DNA** — the document rendered with a table of contents, its frontmatter and
  principles, and **the rubric as the harness reads it**: every gate and scored
  dimension cross-checked between the DNA and `agent.config.json` (undefined
  gates, drifted weights, stated thresholds that no longer match), how often each
  gate fails in practice, the mean score per dimension, and a dot plot of where
  juried works land against the reject / borderline / strong zones.
- **History** — the DNA's timeline: every commit that touched it, every
  petition (ratified, declined with your note, pending), any revision diffed
  against today's DNA, the signal count toward the next petition, and the
  guidance file with the entries the generator actually reads marked.
- **Models** — *who does what*: generate, refine, grade (each juror), draft
  petitions — each with the model, when it's called, and the call shape
  (temperature, tools, JSON mode, max_tokens). Per role: OpenRouter catalogue
  facts and fitness checks (tool calling for the agentic generator, JSON mode for
  jurors, unsupported temperature, max_tokens over the model's limit, context
  share, expiry dates), plus the harness invariants (two vendors, panel parity,
  duplicate jurors). Then what it has cost (30-day spend by purpose, calls /
  tokens / latency / upstream provider per model), **the jury's record** (each
  juror's verdict mix, dissents from its panel, and agreement with your own
  decisions at the gate), and the roster's history from git. `/model?id=…`
  checks any OpenRouter model's fitness for each role before you configure it.
- **Prompts** — exactly what each model is told, assembled by the harness's own
  prompt builders from today's DNA, catalogue and guidance, with token
  estimates against each model's context.
- **Config** — the effective config (defaults marked), paths, vendored
  libraries, and the environment (key masked; OpenRouter's usage/limit for it).

JSON versions live at `/api/overview.json`, `/api/models.json`, `/api/dna.json`.
Cost history comes from the **usage ledger**: every OpenRouter call appends one
line to `logs/usage.jsonl` (model, purpose, tokens, cost, latency, provider) —
local and gitignored, never read by either agent. The OpenRouter model catalogue
is cached in `.cache/` so the console still answers offline.

## Invariants (kept from vana)

- **The hard gate is sacred** — nothing reaches `published/` without your click.
- **Two vendors, always** — generator ≠ jury (and with a panel, no juror is the
  generator; the aggregation math belongs to the harness, never to a model).
- **Self-contained, enforced in layers** — a regex denylist at generation time,
  and a restrictive CSP + sandboxed iframe at render time.
- **`jury.json` is private** — committed as the record, never published.
- **The DNA is the only taste authority — and only you rewrite it.** The agent
  may *petition* to amend it from your accumulated decisions, but ratification
  at the gate is the sole code path that touches `identity/DNA.md`.
- **The budget is a fuse, not a target.**
- **The admin console only reads.** It is an instrument panel, not a second
  control surface — every decision stays at the gate.

The full as-built design is in [ARCHITECTURE.md](ARCHITECTURE.md); the build
log is in [PROGRESS.md](PROGRESS.md).

---

Process extracted from [vana](https://github.com/y-a-v-a/vana) by Vincent
Bruijn (y-a-v-a). Open license by default · no cookies · no tracking.
