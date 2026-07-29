import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { isValidId, isoDate } from "./ids.ts";
import { readGeneratedFiles, type GeneratedMeta } from "./generator.ts";
import { juryCandidate, type JuryVerdict } from "./jury.ts";
import { CostMeter } from "./cost.ts";
import { upsertEntry } from "./catalogue.ts";
import { commitAndPush } from "./git.ts";
import { withLock } from "./lock.ts";

/**
 * An orphan is a work the generator finished but that never reached a verdict:
 * the jury call failed, so the wake threw before the candidate could be routed.
 * Such a work used to be deleted with its staging dir — paid for, complete, and
 * gone. It is now parked in workspace/orphaned/ so it reaches git like every
 * other work, and can be re-juried by hand from the dashboard.
 */
export const ORPHAN_FILE = "orphan.json";

const STATE_FILE = ".agent-state.json";

export interface OrphanRecord {
  id: string;
  /** ISO timestamp of the failure that stranded the work. */
  at: string;
  /** The error that stranded it — almost always the jury provider. */
  error: string;
  /** Self-containment violations found at generation time (empty = clean). */
  violations: string[];
  /** Generation cost already spent on this work, USD. */
  costUsd: number;
}

export function writeOrphanRecord(dir: string, record: OrphanRecord): void {
  writeFileSync(join(dir, ORPHAN_FILE), JSON.stringify(record, null, 2) + "\n", "utf8");
}

/**
 * Move a stranded staging dir into orphaned/ and record why it was stranded.
 * This is the step that turns a lost work into a kept one, so it is deliberately
 * small and side-effect-obvious: no catalogue, no git, no network. Returns the
 * destination dir.
 */
export function parkOrphan(
  orphanedRoot: string,
  id: string,
  stageDir: string,
  record: OrphanRecord,
): string {
  mkdirSync(orphanedRoot, { recursive: true });
  const dest = join(orphanedRoot, id);
  renameSync(stageDir, dest);
  writeOrphanRecord(dest, record);
  return dest;
}

export function readOrphanRecord(dir: string): OrphanRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, ORPHAN_FILE), "utf8")) as OrphanRecord;
  } catch {
    return null;
  }
}

export interface OrphanItem {
  id: string;
  meta: GeneratedMeta;
  orphan: OrphanRecord | null;
}

/** Every stranded work, oldest id first. Malformed dirs are skipped, not thrown on. */
export function listOrphans(cfg: Config): OrphanItem[] {
  if (!existsSync(cfg.abs.orphaned)) return [];
  const items: OrphanItem[] = [];
  for (const entry of readdirSync(cfg.abs.orphaned, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(cfg.abs.orphaned, entry.name);
    try {
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as GeneratedMeta;
      items.push({ id: entry.name, meta, orphan: readOrphanRecord(dir) });
    } catch {
      // skip a malformed orphan dir
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Re-run the jury on a stranded work and move it into pending/ for the human
 * gate. Unlike the unattended wake, a re-jury never auto-rejects: you asked for
 * this work back, so you get to see it and decide — the same rule refine.ts
 * follows for directed reworks. The orphan record stays with the work as
 * provenance (it is not in the site's public allowlist, so it stays private).
 *
 * Serialized against the scheduled wake via the in-process lock, and subject to
 * the daily $ fuse.
 */
export async function rejuryOrphan(
  id: string,
  opts: { push?: boolean; email?: boolean; now?: Date } = {},
): Promise<JuryVerdict> {
  if (!isValidId(id)) throw new Error(`Invalid candidate id: ${id}`);
  const cfg = loadConfig();
  const src = join(cfg.abs.orphaned, id);
  if (!existsSync(src)) throw new Error(`Not an orphaned candidate: ${id}`);
  const dest = join(cfg.abs.pending, id);
  if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);
  const now = opts.now ?? new Date();

  return withLock(async () => {
    const meter = new CostMeter(join(cfg.abs.root, STATE_FILE), isoDate(now), cfg.costFuse);
    const tripped = meter.tripped();
    if (tripped) throw new Error(`fuse: ${tripped}`);

    const files = readGeneratedFiles(src);
    const { verdict, costUsd: juryCostUsd } = await juryCandidate(id, files);
    meter.add(juryCostUsd);

    // Only once the jury has actually returned do we touch the work: a second
    // failure leaves the orphan exactly where it was, still re-juriable.
    writeFileSync(join(src, "jury.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");
    renameSync(src, dest);

    upsertEntry({
      id,
      title: files.meta.title,
      year: Number(isoDate(now).slice(0, 4)),
      source: files.meta.references.join("; "),
      mechanism: files.meta.mechanism,
      status: "pending",
    });

    await commitAndPush(`rejury: ${id} (${verdict.verdict} ${verdict.weighted_total}/${verdict.max_weighted})`, {
      cwd: cfg.abs.root,
      remote: cfg.git.remote,
      branch: cfg.git.branch,
      push: opts.push ?? cfg.git.push,
    });

    if (opts.email ?? !process.env.AGENT_NO_EMAIL) {
      const { sendCandidateEmail } = await import("./notify.ts");
      try {
        await sendCandidateEmail(id, files.meta, verdict);
      } catch (err) {
        console.error(`[rejury] email failed for ${id}: ${(err as Error).message}`);
      }
    }
    return verdict;
  });
}

// CLI: `npm run orphans` / `npm run orphans -- rejury <id>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const [cmd, arg] = process.argv.slice(2);
  if (!cmd || cmd === "list") {
    const items = listOrphans(cfg);
    if (items.length === 0) console.log("No orphaned works.");
    for (const it of items) {
      console.log(`${it.id}\n  ${it.meta.title}\n  stranded: ${it.orphan?.error ?? "(no record)"}`);
    }
  } else if (cmd === "rejury" && arg) {
    rejuryOrphan(arg)
      .then((v) => console.log(`${arg} → pending (${v.verdict} ${v.weighted_total}/${v.max_weighted})`))
      .catch((e) => {
        console.error(e.message);
        process.exit(1);
      });
  } else {
    console.error(`Unknown command: ${cmd}. Try: list | rejury <id>`);
    process.exit(1);
  }
}
