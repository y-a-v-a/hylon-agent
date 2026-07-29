import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { loadCatalogue, writeCatalogue, type CatalogueStatus } from "./catalogue.ts";
import { isValidId } from "./ids.ts";
import { appendGuidance } from "./guidance.ts";
import { commitAndPush } from "./git.ts";

export type Decision = "approve" | "reject";

export interface DecisionResult {
  id: string;
  status: Extract<CatalogueStatus, "published" | "rejected">;
  dir: string;
}

/** Map a human decision to its terminal status + commit verb (pure, testable). */
export function statusFor(decision: Decision): {
  status: Extract<CatalogueStatus, "published" | "rejected">;
  verb: string;
} {
  return decision === "approve"
    ? { status: "published", verb: "publish" }
    : { status: "rejected", verb: "reject" };
}

function setCatalogueStatus(id: string, status: CatalogueStatus): void {
  const entries = loadCatalogue();
  const entry = entries.find((e) => e.id === id);
  if (entry) {
    entry.status = status;
    writeCatalogue(entries);
  }
}

/**
 * Apply the human gate: move a pending candidate to published/ (approve) or
 * rejected/ (reject), update the catalogue, and commit + push. Approving is the
 * ONLY path that writes to published/ — the directory the public site serves.
 */
export async function decide(
  id: string,
  decision: Decision,
  opts: { push?: boolean; note?: string } = {},
): Promise<DecisionResult> {
  if (!isValidId(id)) throw new Error(`Invalid candidate id: ${id}`);
  const cfg = loadConfig();
  const src = join(cfg.abs.pending, id);
  if (!existsSync(src)) throw new Error(`No pending candidate: ${id}`);

  const { status, verb } = statusFor(decision);
  const destRoot = decision === "approve" ? cfg.abs.published : cfg.abs.rejected;
  const dest = join(destRoot, id);
  if (existsSync(dest)) throw new Error(`Destination already exists: ${dest}`);

  renameSync(src, dest);
  setCatalogueStatus(id, status);

  const paths = ["workspace", "catalogue.json"];
  const note = opts.note?.trim();
  if (decision === "reject" && note) {
    // Provenance with the work + accumulate it as generator guidance.
    writeFileSync(join(dest, "rejection.md"), `# Rejection note\n\n${note}\n`, "utf8");
    let title = id;
    try {
      title = (JSON.parse(readFileSync(join(dest, "meta.json"), "utf8")) as { title?: string }).title ?? id;
    } catch {
      // fall back to id
    }
    appendGuidance(title, note, new Date());
    paths.push(cfg.paths.guidance);
  }

  await commitAndPush(`${verb}: ${id}${decision === "reject" && note ? " (+note)" : ""}`, {
    cwd: cfg.abs.root,
    remote: cfg.git.remote,
    branch: cfg.git.branch,
    push: opts.push ?? cfg.git.push,
    paths,
  });

  return { id, status, dir: dest };
}
