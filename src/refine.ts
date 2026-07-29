import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { isValidId, isoDate } from "./ids.ts";
import { refineCandidate } from "./generator.ts";
import { juryCandidate, type JuryVerdict } from "./jury.ts";
import { CostMeter, getOpenRouterPricing, usageCostUsd } from "./cost.ts";
import { upsertEntry } from "./catalogue.ts";
import { commitAndPush } from "./git.ts";
import { withLock } from "./lock.ts";
import { STATE_FILE } from "./loop.ts";

// Presence of this file in a candidate dir means "a refinement is in flight".
// It is gitignored and not in the published allowlist, so it stays local/private.
const MARKER = ".refining";

export function isRefining(dir: string): boolean {
  return existsSync(join(dir, MARKER));
}

/** Exclusively mark a candidate as refining; throws if one is already in flight. */
export function markRefining(dir: string, feedback: string, now: Date): void {
  writeFileSync(join(dir, MARKER), JSON.stringify({ at: now.toISOString(), feedback }, null, 2), {
    flag: "wx",
  });
}

function clearRefining(dir: string): void {
  rmSync(join(dir, MARKER), { force: true });
}

function appendRefineLog(dir: string, feedback: string, verdict: JuryVerdict, now: Date): void {
  const entry =
    `\n## Refinement ${now.toISOString()}\n\n` +
    `**Feedback:** ${feedback}\n\n` +
    `**Re-juried:** ${verdict.verdict} ${verdict.weighted_total}/${verdict.max_weighted}\n`;
  appendFileSync(join(dir, "refinements.md"), entry, "utf8");
}

/**
 * Apply human feedback to a pending candidate: the agent reworks it in place,
 * it is re-juried, and it stays in pending/ for the human gate (a directed
 * refinement is never auto-rejected). Serialized against the scheduled wake via
 * the in-process lock; respects the daily $ fuse; notifies when done. The caller
 * sets the `.refining` marker before invoking this; it is cleared here on exit.
 */
export async function runRefine(
  id: string,
  feedback: string,
  opts: { push?: boolean; email?: boolean; now?: Date } = {},
): Promise<void> {
  if (!isValidId(id)) throw new Error(`Invalid candidate id: ${id}`);
  const cfg = loadConfig();
  const dir = join(cfg.abs.pending, id);
  if (!existsSync(dir)) throw new Error(`Not a pending candidate: ${id}`);
  const now = opts.now ?? new Date();

  await withLock(async () => {
    try {
      const meter = new CostMeter(join(cfg.abs.root, STATE_FILE), isoDate(now), cfg.costFuse);
      const tripped = meter.tripped();
      if (tripped) throw new Error(`fuse: ${tripped}`);

      const gen = await refineCandidate(dir, feedback);
      meter.add(gen.costUsd);

      const pricing = await getOpenRouterPricing(cfg.models.jury);
      const { verdict, usage } = await juryCandidate(id, gen.files);
      meter.add(usageCostUsd(pricing, usage));
      writeFileSync(join(dir, "jury.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");

      appendRefineLog(dir, feedback, verdict, now);
      upsertEntry({
        id,
        title: gen.files.meta.title,
        year: Number(isoDate(now).slice(0, 4)),
        source: gen.files.meta.references.join("; "),
        mechanism: gen.files.meta.mechanism,
        status: "pending",
      });

      await commitAndPush(
        `refine: ${id} (${verdict.verdict} ${verdict.weighted_total}/${verdict.max_weighted}${gen.violations.length ? ", non-self-contained" : ""})`,
        { cwd: cfg.abs.root, remote: cfg.git.remote, branch: cfg.git.branch, push: opts.push ?? cfg.git.push },
      );

      if (opts.email ?? !process.env.AGENT_NO_EMAIL) {
        const { sendCandidateEmail } = await import("./notify.ts");
        try {
          await sendCandidateEmail(id, gen.files.meta, verdict, { refined: true });
        } catch (err) {
          console.error(`[refine] email failed for ${id}: ${(err as Error).message}`);
        }
      }
    } finally {
      clearRefining(dir);
    }
  });
}
