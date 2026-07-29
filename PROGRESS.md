# PROGRESS — hylon

Build log for **hylon**: a generic autonomous art-agent harness extracted from
[vana](https://github.com/y-a-v-a/vana). The process (generate → jury → human
gate → publish) is kept; everything bound to Vincent/y-a-v-a's artistic DNA is
stripped. Feed it a fresh `identity/DNA.md` and it runs.

## Goals (from the brief)

- [a] The artistic DNA is the only input — no taste in the harness.
- [b] OpenRouter is the default provider for **both** the generator and the jury.
- [c] A JSON config file (`agent.config.json`) configures the OpenRouter models.
- [d] `OPENROUTER_API_KEY` is the single base connector key.

## Design decisions

- **Generator rewritten for OpenRouter.** vana drove Claude Opus through the
  Agent SDK (a real file-writing tool loop). Generic version: one structured
  chat-completion call that returns three delimited sections
  (`===META===` / `===MOTIVATION===` / `===HTML===`), which the harness parses
  and writes to disk itself. Same on-disk contract as vana
  (`index.html` + `motivation.md` + `meta.json`), so the rest of the pipeline is
  untouched.
- **Rubric is config, not code.** vana hardcoded gates G1–G6 and the
  novelty/nuance/narrative/craft/wit weights (its DNA §8). Those are now
  `rubric` in `agent.config.json` (gate ids, score dimensions + weights,
  scoreMax); the DNA document defines what they *mean*. Defaults ship with
  vana's shape so the template DNA works out of the box.
- **The harness still does the math.** The jury model only supplies gate
  booleans + scores; weighting, thresholds and the verdict are computed
  deterministically (kept from vana — it's the reason the gate is testable).
- **Verdicts carry `max_weighted`** so jury.json is self-describing and the
  dashboard/emails don't need the config to render "40/50".
- **Email is optional.** SMTP env (`SMTP_HOST/SMTP_USER/SMTP_PASS`) unset →
  notifications fall back to console logging; the loop and dashboard still work.
  The only required secret is `OPENROUTER_API_KEY`.
- **Cost metering.** OpenRouter is asked for `usage: {include: true}` so it
  reports the real cost per call; the pricing-table lookup is kept as fallback.
  Fuse logic (per-wake + per-day USD caps) unchanged.
- **Kept from vana verbatim** (already generic): ids/slugs, in-process lock,
  cost fuse, guidance accumulation, git commit/push, SMTP client, dashboard
  routes + CSP/sandbox enforcement, orphan recovery, refine flow, site
  assembly, daemon scheduling.
- **Stripped:** historical catalogue seed (now an optional
  `identity/catalogue.seed.json`), y-a-v-a branding/prompts, Tailscale
  hostnames, `agent@vincentbruijn.nl` SMTP defaults, vana.y-a-v-a.org deploy
  specifics, `ONI_MAIL_*`/`VANA_*` env names (now `SMTP_*`/`AGENT_*`).

## Log

- **2026-07-29** — Read the full vana source (src/, ops/, identity/, config,
  tests). Decided the design above. Repo scaffold: package.json (no Agent SDK
  dependency), tsconfig, .gitignore, agent.config.json, .env.example.
