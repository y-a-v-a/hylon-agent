# ARCHITECTURE — hylon

The **as-built** description of the system. For what changed relative to vana
(the origin project) see [`PROGRESS.md`](PROGRESS.md); for the artistic rubric
the agents apply, see your `identity/DNA.md`.

hylon is a local, interval-driven agent that generates web artworks in a
configured artistic DNA, has each one graded by an independent AI jury, gates
on a hard human approval, and publishes the approved subset as a static site.
The harness encodes **no taste of its own** — it *applies* `identity/DNA.md`.

## The loop

```
              identity/DNA.md  +  catalogue.json   (operating system + dedup corpus)
                                    │
                                    ▼
        GENERATOR — OpenRouter (models.generator)   agentic file-tool loop (write_file/
        OPENROUTER_API_KEY                          read_file/list_files, sandboxed to the
                                    │               staging dir): the model writes index.html
                                    │               + motivation.md + meta.json itself and
                                    │               self-corrects. ("single-shot" fallback
                                    ▼                mode for models without tool support)
        JURY — OpenRouter (models.jury)             applies the DNA rubric → gates + scores
        OPENROUTER_API_KEY                          (harness computes weighting + verdict)
                                    │
                 reject / gate-fail │ strong | borderline
            ┌───────────────────────┴───────────────────────┐
            ▼                                                ▼
   workspace/rejected/<id>                         workspace/pending/<id>
   (archived, discarded)                           + auto git commit (& push)
                                                            │
                                                            ▼
                          NOTIFY (SMTP if configured, else console log)
                          → link to the local approval dashboard
                                                            │
                                                            ▼
                          APPROVAL DASHBOARD (node:http, config port)
                          renders the work (sandboxed iframe) + motivation + verdict
                          [ Approve ]   [ Reject +note ]   [ Refine ]
                              │                                 │
                              ▼                                 ▼
                  workspace/published/<id>            workspace/rejected/<id>
                              │
                              ▼
                  build:site → dist-site/ → any static host (CSP headers included)
```

### Loop control (time-budgeted, loop-until-pass)

Each wake runs until a candidate passes **or** a budget is hit: generate →
jury → route; rejected candidates archive and the loop retries; the wake stops
on the time budget or the $ fuse. Budgets live in `agent.config.json`.

## Components (`src/`)

| Module | Responsibility |
|---|---|
| `config.ts` | Loads `agent.config.json` (zod-validated, absolute paths); `OPENROUTER_API_KEY` (required) and optional `SMTP_*` from env; the `Rubric` type + `maxWeighted()` |
| `openrouter.ts` | The shared chat client: `chatTurn()` (full message history + OpenAI-style tools, for the agent loop) and `chat()` (single system+user exchange, for the jury); optional attribution headers; `usage: {include: true}` for provider-reported cost; every call (ok or failed) is appended to the usage ledger, tagged with its `purpose` and `run` |
| `usage.ts` | The usage ledger (`logs/usage.jsonl`): one line per OpenRouter call — model, purpose (`generate` / `refine` / `jury` / `amend`), run id, tokens, cost, latency, upstream provider, generation id. Best-effort writes; pure parsing and aggregation (`summarizeUsage`, `dailyUsage`) for the admin console |
| `agentloop.ts` | The generator's agent loop: file tools (`write_file`/`read_file`/`list_files`) sandboxed to the staging dir (`resolveWorkPath` blocks traversal), tool errors returned to the model for self-correction, premature-stop reminders while required files are missing, per-turn cost accumulation, `maxTurns` bound |
| `dna.ts` | Reads `identity/DNA.md` — the operating system for both agents (actionable error pointing at the template when missing) |
| `catalogue.ts` | `catalogue.json`: living index, optionally seeded from `identity/catalogue.seed.json`; `catalogueDigest()` for prompts, `upsertEntry()` for lifecycle; feeds the duplicate gate |
| `ids.ts` | `slugify` + `makeId` → candidate id `<UTC-date>-<title-slug>`; `isValidId` guards untrusted HTTP ids |
| `generator.ts` | Drives the agent loop (default) or a single delimited-section call (`generation.mode`); prompt = DNA + catalogue digest + recent artist guidance; validates the three files either way; `validateSelfContained()` blocks obvious external requests |
| `guidance.ts` | `identity/guidance.md` — artist guidance accumulated from reject-with-note. The **generator** reads recent entries; the **jury never reads it** |
| `vendor.ts` | The technology palette's library half: `<script data-vendor="name">` placeholders validated against config, and the pinned library source (e.g. `vendor/three.min.js`) inlined at render/build time — the dashboard `/work` response and `buildSite()` — so stored works stay small while published works stay one self-contained file. `technologies.apis` is prompt plumbing in `generator.ts` |
| `jury.ts` | The configured jury — one model or a **panel of up to 5** (`models.jury` string or array) — each called in parallel (JSON mode) applying the DNA rubric; the **models supply gate booleans + scores** (shape from config `rubric`), the **harness computes** weighting, gate-first logic, thresholds, and the verdict. Panels aggregate deterministically (`aggregatePanel`): strict per-gate majority (ties fail), median scores, and every juror's full opinion recorded on the verdict (`panel`, `unanimous`); verdicts carry `max_weighted` |
| `cost.ts` | `CostMeter` (persists daily spend to `.agent-state.json`); OpenRouter pricing lookup as fallback when the provider didn't report cost; `fuseCheck` |
| `loop.ts` | `runWake()` — orchestration; routes to pending/rejected; writes `jury.json`; upserts the catalogue; `npm run once` |
| `git.ts` | Scoped stage (`workspace/` + `catalogue.json`) + commit + optional push; read-only history helpers (`fileHistory`, `fileAt`, `fileStatus`) for the admin console |
| `smtp.ts` | Dependency-free SMTP-over-implicit-TLS (465) client |
| `notify.ts` | `buildEmail()` + `sendCandidateEmail()`; falls back to console logging when SMTP/email is not configured |
| `dashboard.ts` | `node:http` server: pending list, candidate view (sandboxed iframe + CSP), Approve / Reject (+note) / Refine, orphan recovery, status pages |
| `promote.ts` | `decide(id, approve\|reject, {note})` — pending→published/rejected, catalogue update, commit+push. **Approve is the only writer to `published/`** |
| `amend.ts` | The self-amending DNA: collects signals (guidance entries, refinement feedback, decision stats) since the last petition; when ≥ `amendments.minSignals`, one OpenRouter call drafts a rationale + complete revised DNA; stored as a pending petition under `identity/amendments/` (one at a time), with diff stats and rubric-anchor warnings. `decideAmendment()` — **ratify is the only writer to `identity/DNA.md`**; declined petitions + notes are fed to future proposers. CLI `npm run amend` |
| `diff.ts` | Dependency-free line diff (LCS) with context collapsing — renders the petition diff on the dashboard and in text |
| `refine.ts` | `runRefine(id, feedback)` — reworks a pending candidate in place from human feedback, re-juries, stays pending for the gate |
| `orphans.ts` | Works stranded before a verdict are parked, listed, and re-juriable — never silently deleted |
| `lock.ts` | In-process mutex so a refine and a scheduled wake never run at once |
| `site.ts` | `buildSite()` — assembles `dist-site/`; copies `index.html` + `motivation.md` + `meta.json`, **never `jury.json`**; catalogue index text from config `site` |
| `daemon.ts` | Long-running process: serves the dashboard + self-schedules wakes; launchd target |
| `admin.ts` | The **admin console** (`npm run admin`, 127.0.0.1 only, read-only): gathers the DNA, its history, the model roles, the ledger, the jury's record, the daemon's state and the environment, and serves them as pages + JSON. Every outside dependency (catalogue, key, git, process probes, clock, env) is injected, so routes test hermetically |
| `adminview.ts` | Pure HTML rendering for the console, in the dashboard's idiom (escaped template strings, no framework); inline-SVG charts with one tooltip script |
| `markdown.ts` | Dependency-free markdown → HTML (frontmatter, headings + TOC ids, nested lists, quotes, fences, tables, emphasis, safe links) for rendering the DNA, guidance and petitions |
| `dnainfo.ts` | Reads a DNA the way the harness depends on it: principles, gate and dimension definitions, stated weights and thresholds — cross-checked against `rubric`/`thresholds` in config (the coupling the template asks you to keep) |
| `models.ts` | The role map (`modelUses`: which model serves which purpose, called how — resolved exactly as generator/jury/amend resolve it), OpenRouter catalogue/endpoints/key lookups with memo + offline disk cache, per-role fitness checks and the model invariants, roster history from config revisions |
| `insights.ts` | Read-back of the record: every work and who settled its fate, per-juror stats (dissent, agreement with the artist), the rubric in practice, daemon-log parsing and the next-wake estimate |
| `health.ts` | The `Check` vocabulary (ok / info / warn / fail) the console ranks |

Pure logic is unit-tested with `node:test` + `node:assert` — no test framework
dependency. `npm test` (251 tests); `npm run check` = typecheck + tests +
build:site. `npm run test:live` makes one real jury call (~$0.005) to verify
the OpenRouter contract.

## The two agents (division of labour)

The generator and the jury should be **different vendors** so no model grades
its own output — both are just OpenRouter model ids in `agent.config.json`.
The jury can be a **panel**: configure `models.jury` as an array (1–5) and each
juror grades the candidate independently, blind to the others. The harness
aggregates: a gate passes only on a strict majority (a tie fails — prefer odd
panels), scores take the per-dimension median (so one outlier juror cannot
swing the panel), and the verdict is derived from the aggregate exactly as for
a single juror. Every opinion — including the dissents — is recorded on the
verdict and shown on the dashboard and in the notification. A juror failure
fails the whole jury call; the orphan mechanism keeps the finished work
re-juriable. The jury only supplies *judgements*; all arithmetic and the
pass/fail decision are computed deterministically in `jury.ts`, so the gate is
testable and not at the mercy of a model doing weighted sums. The rubric
*shape* (gate ids, score dimensions, weights, score ceiling) is config; the
rubric *meaning* is DNA.

## Configuration & secrets

- `agent.config.json` — name, models, generation params, rubric, thresholds,
  interval/budgets/fuse, lifecycle paths (+ the usage ledger), dashboard port +
  link host, admin console port,
  notification recipient, git remote/branch, public-site text.
- Environment (`.env` or shell): `OPENROUTER_API_KEY` (required, both agents),
  `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`SMTP_PORT`/`SMTP_FROM` (optional email).
- Runtime switches: `AGENT_MAX_ATTEMPTS`, `AGENT_NO_PUSH`, `AGENT_NO_EMAIL`,
  `AGENT_WAKE_ON_START`.

## Invariants

- **The hard gate is sacred** — nothing reaches `published/` (and the live
  site) without an Approve click. The loop is write-only to `pending/` and
  `rejected/`.
- **Two vendors, always** — generator ≠ jury.
- **Self-contained, enforced in layers** — `validateSelfContained` (regex
  denylist) fails fast at generation time; the real guarantee is a restrictive
  **CSP + sandboxed iframe** at render time (dashboard `/work` and
  `vercel.json` on the public site).
- **`jury.json` is private** — committed as the record, never published.
- **The DNA is the only taste authority for the gate — and only the artist
  rewrites it.** `guidance.md` (from reject-with-note) steers the **generator**
  only; the jury never reads it, so accumulated guidance can't drift the gate.
  The agent may **petition** to fold accumulated signals into the DNA
  (`amend.ts`), but ratification at the human gate is the sole code path that
  writes `identity/DNA.md`, and every petition is archived + committed.
- **Untrusted ids are validated** — an HTTP-supplied candidate id must pass
  `isValidId` before it is joined into any lifecycle path.
- **The budget is a fuse, not a target** — time first, dollars as the backstop.
- **The admin console only reads** — it binds to 127.0.0.1, answers GET/HEAD
  only, and has no code path that writes the DNA, the config, or the workspace.
