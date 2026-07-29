# The daemon — going autonomous

`src/daemon.ts` is the long-running process. It:
- serves the approval dashboard continuously (`http://<dashboard.host>:<port>`)
- wakes every `interval` (config) → generate → jury → (on pass) notify you
- is bounded each wake by the work-budget and the $ fuse (`agent.config.json`)

Run it under launchd (macOS) so it survives crashes and reboots.

## Operating it (npm scripts)

| Command | What it does |
|---|---|
| `npm run daemon:install` | render the plist template (repo + node paths substituted) into `~/Library/LaunchAgents/` |
| `npm run daemon:start` | load + enable the launch agent (goes autonomous) |
| `npm run daemon:stop` | unload it |
| `npm run daemon:restart` | reload (use after a **code** change — daemon runs `tsx` on source) |
| `npm run daemon:logs` | `tail -f logs/daemon.out.log` |
| `npm run status` | one-shot health check (launchd state, dashboard, wakes, spend, pending) |
| `npm run once` | run one cycle now, on demand (separate from the schedule) |

## Going live (your explicit step — this starts autonomous, metered spend)

```sh
npm run daemon:install
npm run daemon:start
npm run daemon:logs
```

By default the first wake is one interval away. Use `npm run once` to test a
single cycle immediately without waiting for the schedule. Set
`AGENT_WAKE_ON_START=1` in the environment to wake immediately on daemon start.

## After a change
- **Code** change (`src/*.ts`): `npm run daemon:restart` (re-reads source).
- **Plist** change (`ops/com.agent.hylon.plist`): `npm run daemon:install` then
  `npm run daemon:restart`.

## Stopping

```sh
npm run daemon:stop
```

## Notes
- Secrets come from `.zshenv` (via `zsh -lc` in the plist) or `.env` — no
  secrets are stored in the plist or the repo. Only `OPENROUTER_API_KEY` is
  required; `SMTP_*` is optional (without it, notifications go to the log).
- Each wake auto-commits every candidate (pending *and* rejected); with
  `git.push` enabled it also pushes, and approvals (dashboard) push
  `workspace/published/`, which can trigger a deploy (see DEPLOY.md).
- Logs: `logs/daemon.out.log` / `logs/daemon.err.log` (gitignored).
- A single manual cycle without launchd: `npm run once` (bounded by the same
  budget/fuse). For one attempt only: `AGENT_MAX_ATTEMPTS=1 npm run once`.
  Other switches: `AGENT_NO_PUSH=1`, `AGENT_NO_EMAIL=1`.
- On Linux, wrap the same command (`node --import tsx src/daemon.ts`) in a
  systemd unit with `Restart=always` instead of launchd.
