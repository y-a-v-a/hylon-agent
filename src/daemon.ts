import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { runWake, type AcceptedContext } from "./loop.ts";
import { sendCandidateEmail } from "./notify.ts";
import { startDashboard } from "./dashboard.ts";
import { withLock } from "./lock.ts";

// The long-running process: serves the approval dashboard continuously AND
// wakes on the configured interval to generate → jury → notify. Designed to run
// under launchd (RunAtLoad + KeepAlive). See ops/DAEMON.md.

const ts = (): string => new Date().toISOString();

let waking = false;

async function wake(): Promise<void> {
  if (waking) {
    console.log(`[daemon] ${ts()} wake skipped — previous still running`);
    return;
  }
  waking = true;
  const t0 = Date.now();
  console.log(`[daemon] ${ts()} wake start`);
  try {
    const result = await withLock(() =>
      runWake({
        onAccepted: async (ctx: AcceptedContext) => {
          // A notification failure must not crash the wake — the candidate is
          // already safely in pending/ and committed. Log and carry on.
          try {
            await sendCandidateEmail(ctx.id, ctx.meta, ctx.verdict);
            console.log(`[daemon] ${ts()} notified for ${ctx.id}`);
          } catch (err) {
            console.error(`[daemon] ${ts()} notify failed for ${ctx.id}: ${(err as Error).message}`);
          }
        },
      }),
    );
    console.log(`[daemon] ${ts()} wake done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[daemon] ${ts()} wake error: ${(err as Error).message}`);
  } finally {
    waking = false;
  }
}

function main(): void {
  const cfg = loadConfig();
  mkdirSync(join(cfg.abs.root, "logs"), { recursive: true });
  startDashboard();

  const intervalMs = cfg.interval.hours * 3_600_000;
  console.log(
    `[daemon] ${ts()} ${cfg.name} up. interval=${cfg.interval.hours}h work-budget=${cfg.workBudget.minutes}min ` +
      `fuse=$${cfg.costFuse.perWakeUsd}/wake $${cfg.costFuse.perDayUsd}/day generator=${cfg.models.generator} jury=${cfg.models.jury}`,
  );

  const scheduleNext = (ms: number): void => {
    setTimeout(() => void wake().finally(() => scheduleNext(intervalMs)), ms);
  };

  if (process.env.AGENT_WAKE_ON_START) {
    console.log(`[daemon] ${ts()} AGENT_WAKE_ON_START set — waking now`);
    void wake().finally(() => scheduleNext(intervalMs));
  } else {
    console.log(`[daemon] ${ts()} first wake in ${cfg.interval.hours}h`);
    scheduleNext(intervalMs);
  }

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`[daemon] ${ts()} ${sig} — exiting`);
      process.exit(0);
    });
  }
}

main();
