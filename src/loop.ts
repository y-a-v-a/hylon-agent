import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { isoDate, makeId } from "./ids.ts";
import { generateCandidate, type GeneratedMeta, type GenerationResult } from "./generator.ts";
import { juryCandidate, type Verdict, type JuryVerdict } from "./jury.ts";
import { CostMeter, getOpenRouterPricing, usageCostUsd } from "./cost.ts";
import { upsertEntry, type CatalogueEntry } from "./catalogue.ts";
import { commitAndPush } from "./git.ts";
import { parkOrphan } from "./orphans.ts";

export const STATE_FILE = ".agent-state.json";

// ── Pure decision helpers (testable) ─────────────────────────────────────────

/** A candidate publishes only if it's self-contained AND the jury didn't reject. */
export function isPublishable(verdict: Verdict, violations: string[]): boolean {
  return violations.length === 0 && verdict !== "reject";
}

/** Make an id unique against existing ids by suffixing -2, -3, … */
export function uniqueId(baseId: string, exists: (id: string) => boolean): string {
  if (!exists(baseId)) return baseId;
  let n = 2;
  while (exists(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

// ── Wake orchestration (integration; `npm run once`) ─────────────────────────

export interface WakeResult {
  passed: boolean;
  attempts: number;
  stopReason: "passed" | "time-budget" | "fuse" | "max-attempts";
  detail?: string;
  publishedId?: string;
  spentUsd: number;
}

export interface AcceptedContext {
  id: string;
  dir: string;
  meta: GeneratedMeta;
  verdict: JuryVerdict;
}

export interface RunWakeOptions {
  /** Cap attempts (for testing/bounded runs); default: bounded only by time/fuse. */
  maxAttempts?: number;
  /** Override the push decision (default: config.git.push). */
  push?: boolean;
  /** Called when a candidate is accepted into pending/ (the notification gateway). */
  onAccepted?: (ctx: AcceptedContext) => Promise<void> | void;
}

function lifecycleExists(cfg: ReturnType<typeof loadConfig>, id: string): boolean {
  return (
    existsSync(join(cfg.abs.pending, id)) ||
    existsSync(join(cfg.abs.published, id)) ||
    existsSync(join(cfg.abs.rejected, id)) ||
    existsSync(join(cfg.abs.orphaned, id))
  );
}

function ensureDirs(cfg: ReturnType<typeof loadConfig>): string {
  for (const d of [cfg.abs.pending, cfg.abs.published, cfg.abs.rejected, cfg.abs.orphaned]) {
    mkdirSync(d, { recursive: true });
  }
  const work = join(cfg.abs.root, "workspace", ".work");
  mkdirSync(work, { recursive: true });
  return work;
}

export async function runWake(opts: RunWakeOptions = {}): Promise<WakeResult> {
  const cfg = loadConfig();
  const workRoot = ensureDirs(cfg);
  const today = isoDate(new Date());
  const meter = new CostMeter(join(cfg.abs.root, STATE_FILE), today, cfg.costFuse);
  const juryPricing = await getOpenRouterPricing(cfg.models.jury);
  const deadline = Date.now() + cfg.workBudget.minutes * 60_000;
  const push = opts.push ?? cfg.git.push;

  let attempts = 0;
  while (true) {
    const fuse = meter.tripped();
    if (fuse) return { passed: false, attempts, stopReason: "fuse", detail: fuse, spentUsd: meter.wakeSpent() };
    if (Date.now() > deadline) {
      return { passed: false, attempts, stopReason: "time-budget", spentUsd: meter.wakeSpent() };
    }
    if (opts.maxAttempts && attempts >= opts.maxAttempts) {
      return { passed: false, attempts, stopReason: "max-attempts", spentUsd: meter.wakeSpent() };
    }
    attempts++;

    const stage = mkdtempSync(join(workRoot, "cand-"));
    // Hoisted so the catch can tell "the generator failed" (nothing worth keeping)
    // from "a finished work was stranded" (keep it — see the orphan branch below).
    let gen: GenerationResult | undefined;
    let id: string | undefined;
    try {
      // 1. Generate
      gen = await generateCandidate(stage);
      meter.add(gen.costUsd);

      // 2. Identify + jury
      id = uniqueId(makeId(gen.files.meta.title, new Date()), (x) => lifecycleExists(cfg, x));
      const { verdict, usage } = await juryCandidate(id, gen.files);
      meter.add(usageCostUsd(juryPricing, usage));
      writeFileSync(join(stage, "jury.json"), JSON.stringify(verdict, null, 2) + "\n", "utf8");

      // 3. Route
      const publish = isPublishable(verdict.verdict, gen.violations);
      const destRoot = publish ? cfg.abs.pending : cfg.abs.rejected;
      const dest = join(destRoot, id);
      renameSync(stage, dest);

      // 4. Catalogue + persist
      const entry: CatalogueEntry = {
        id,
        title: gen.files.meta.title,
        year: Number(today.slice(0, 4)),
        source: gen.files.meta.references.join("; "),
        mechanism: gen.files.meta.mechanism,
        status: publish ? "pending" : "rejected",
      };
      upsertEntry(entry);

      const tag = publish ? "pending" : "reject";
      await commitAndPush(
        `${tag}: ${id} (${verdict.verdict} ${verdict.weighted_total}/${verdict.max_weighted}${gen.violations.length ? ", non-self-contained" : ""})`,
        { cwd: cfg.abs.root, remote: cfg.git.remote, branch: cfg.git.branch, push },
      );

      if (publish) {
        await opts.onAccepted?.({ id, dir: dest, meta: gen.files.meta, verdict });
        return { passed: true, attempts, stopReason: "passed", publishedId: id, spentUsd: meter.wakeSpent() };
      }
      // rejected → loop-until-pass continues
    } catch (err) {
      const message = (err as Error).message;
      // A complete work stranded before its verdict (the jury provider is the
      // usual culprit) is never destroyed: park it in orphaned/ so it reaches
      // git and can be re-juried by hand. `stage` still existing means step 3's
      // rename hasn't run — after that the work is already in a lifecycle dir
      // and the next commit sweeps it up.
      if (gen && id && existsSync(stage)) {
        parkOrphan(cfg.abs.orphaned, id, stage, {
          id,
          at: new Date().toISOString(),
          error: message,
          violations: gen.violations,
          costUsd: gen.costUsd,
        });
        upsertEntry({
          id,
          title: gen.files.meta.title,
          year: Number(today.slice(0, 4)),
          source: gen.files.meta.references.join("; "),
          mechanism: gen.files.meta.mechanism,
          status: "orphaned",
        });
        // Best-effort: if this commit also fails, the work is still on disk and
        // any later commit stages it (`git add -- workspace`).
        await commitAndPush(`orphan: ${id} (stranded before verdict)`, {
          cwd: cfg.abs.root,
          remote: cfg.git.remote,
          branch: cfg.git.branch,
          push,
        }).catch((e) => console.error(`[loop] orphan commit failed for ${id}: ${(e as Error).message}`));
        throw new Error(`Wake attempt ${attempts} failed: ${message} (work kept as orphan ${id})`);
      }
      // Nothing salvageable — clean up a half-written stage dir and rethrow.
      if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
      throw new Error(`Wake attempt ${attempts} failed: ${message}`);
    }
  }
}

// ── CLI: `npm run once` ──────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "once") {
    const maxAttempts = process.env.AGENT_MAX_ATTEMPTS ? Number(process.env.AGENT_MAX_ATTEMPTS) : undefined;
    const push = process.env.AGENT_NO_PUSH ? false : undefined;
    const onAccepted = process.env.AGENT_NO_EMAIL
      ? undefined
      : async (ctx: AcceptedContext) => {
          const { sendCandidateEmail } = await import("./notify.ts");
          await sendCandidateEmail(ctx.id, ctx.meta, ctx.verdict);
        };
    runWake({ maxAttempts, push, onAccepted })
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    console.error(`Unknown command: ${cmd ?? "(none)"}. Try: once`);
    process.exit(1);
  }
}
