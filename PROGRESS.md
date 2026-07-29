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
- **2026-07-29** — Ported the full pipeline. `openrouter.ts` (new shared
  client), `generator.ts` rewritten for a single structured OpenRouter call
  with delimited-section parsing, `jury.ts` rubric-parameterized, notify made
  SMTP-optional; loop/orphans/refine/promote/dashboard/site/daemon carried over
  with generic naming (`AGENT_*` env, `.agent-state.json`). Typecheck clean.
- **2026-07-29** — Ported the whole test suite (118 tests passing), including
  new coverage for section parsing, custom-rubric math, and the file
  round-trip. `jury.live.ts` adapted as the opt-in live OpenRouter contract
  test.
- **2026-07-29** — Identity template (`identity/DNA.template.md` +
  `catalogue.seed.example.json`), ops (plist template with install-time path
  substitution, generic status.sh, DAEMON/DEPLOY docs, verify-deploy with URL
  argument), vercel.json CSP backstop, workspace scaffold. README +
  ARCHITECTURE rewritten for the generic harness. `npm run check` green.

- **2026-07-29** — Restored the **agentic generator** on OpenRouter. New
  `agentloop.ts`: a file-tool loop over OpenRouter tool calling
  (`write_file`/`read_file`/`list_files`, sandboxed to the staging dir) so the
  model writes its own files, reads them back, and self-corrects — the behavior
  vana got from the Claude Agent SDK, now provider-agnostic. Tool errors are
  fed back to the model instead of thrown; a premature stop with required files
  missing earns a reminder turn; cost accumulates per turn. `generation.mode`
  selects `"agentic"` (default) or `"single-shot"` (the delimited-section path,
  kept for models without tool support); `generation.maxTurns` bounds the loop.
  `openrouter.ts` refactored into `chatTurn()` (history + tools) with `chat()`
  as the single-exchange wrapper the jury uses. 129 tests passing.

- **2026-07-29** — **Live validation against OpenRouter** (with the real
  `OPENROUTER_API_KEY`): key valid; both configured models exist and
  `anthropic/claude-sonnet-4.5` reports tool support. `npm run test:live`
  (against a throwaway DNA, removed afterwards): the jury returned parseable
  JSON and the harness computed `reject 26/50` — contract holds. Live
  agent-loop smoke: Sonnet 4.5 wrote a file via `write_file`, read it back to
  verify, and finished in 3 turns for $0.011 — the agentic path works
  end-to-end.

- **2026-07-29** — Published as **github.com/y-a-v-a/hylon-agent** and marked
  as a GitHub **template repository**: this repo is a blueprint, meant to be
  copied ("Use this template") or forked before use — the agent's works are
  committed to git, and they belong in the operator's own repo. `git.push`
  ships as `false` so a fresh copy never pushes works at the blueprint.

- **2026-07-29** — **Technology palette.** New `technologies` config section:
  `apis` (SVG, Canvas 2D, WebGL, Web Audio, CSS animation by default) is prompt
  plumbing that tells the generator what is in bounds — nothing was ever
  *blocked* except network access, but the generator didn't know it. `libraries`
  maps names to vendored files (e.g. `threejs → vendor/three.min.js`): the
  generator writes `<script data-vendor="name"></script>` and the harness
  inlines the pinned source at render/build time (dashboard `/work` +
  `build:site`), so stored works stay small and published works stay one
  self-contained file. Undeclared placeholders are self-containment violations;
  the jury is told declared placeholders are sanctioned; vendor files are
  checked before any generation spend. New `vendor.ts` + vendor/README.md.
  141 tests passing.

- **2026-07-29** — **Self-amending DNA** (branch `self-amending-dna`). The
  artist initiates the DNA from their work *so far*; their live decisions
  (reject notes, refinement requests) are treated as signals of artistic
  drift. When ≥ `amendments.minSignals` new signals accumulate (checked after
  each wake, or forced via `npm run amend`), the agent files an **amendment
  petition**: rationale citing specific notes + the complete revised DNA,
  stored under `identity/amendments/pending/` (one at a time), committed, and
  surfaced on the dashboard as a colorized diff (new dependency-free LCS
  `diff.ts`) with Ratify / Decline (+note). Ratify is the only code path that
  rewrites `identity/DNA.md`; declined petitions and their notes are shown to
  future proposers so the agent never re-litigates. Rubric anchors (gate ids,
  dimension names) are protected by prompt and by review warnings; the "NO
  AMENDMENT" outcome is honored; petitions are fuse-metered. 164 tests passing.

- **2026-07-29** — **Jury panel** (branch `jury-panel`, stacked on
  `self-amending-dna`). `models.jury` now accepts one model (string, the
  default and minimum) or an array of up to 5. Jurors grade independently and
  in parallel, blind to each other; the harness aggregates deterministically:
  strict per-gate majority (ties fail — prefer odd panels), per-dimension
  median scores (one outlier can't swing the panel), thresholds on the
  aggregate. Every juror's full opinion — verdict, scores, rationale,
  reservations — is recorded on the verdict (`panel`, `unanimous`), rendered
  as "Panel opinions (split/unanimous)" on the dashboard, and listed in the
  notification email. Juror cost is metered per model (`juryCandidate` now
  returns the real combined cost); a juror failure fails the jury call and the
  orphan path keeps the work. Single-juror verdicts keep the exact previous
  shape. 175 tests passing.

## To go live after copying the template

0. On GitHub: **Use this template** (or fork) → your own repo, then clone that.
1. `cp .env.example .env` → set `OPENROUTER_API_KEY`.
2. `cp identity/DNA.template.md identity/DNA.md` → write your DNA (keep §8 in
   sync with `rubric` in `agent.config.json`, or edit both).
3. Optional: `identity/catalogue.seed.json` + `npm run seed`.
4. Pick models in `agent.config.json` (`models.generator` ≠ `models.jury`
   vendor), and set `git.push: true` once you want candidates pushed.
5. `npm run once` to test a cycle; `npm run dashboard` to gate; `ops/DAEMON.md`
   to go autonomous; `ops/DEPLOY.md` to publish.
