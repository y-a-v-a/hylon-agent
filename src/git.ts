import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitOptions {
  cwd: string;
  remote: string;
  branch: string;
  push: boolean;
  /** Paths to stage; defaults to the workspace + catalogue. */
  paths?: string[];
}

export interface GitResult {
  committed: boolean;
  pushed: boolean;
}

/**
 * Stage the candidate paths, commit, and (optionally) push. Tolerates an empty
 * commit (nothing changed) by returning committed:false rather than throwing.
 * Push failures DO throw — the daemon should surface a broken remote.
 */
export async function commitAndPush(message: string, opts: GitOptions): Promise<GitResult> {
  const paths = opts.paths ?? ["workspace", "catalogue.json"];
  await exec("git", ["add", "--", ...paths], { cwd: opts.cwd });

  try {
    await exec("git", ["commit", "-m", message], { cwd: opts.cwd });
  } catch (err) {
    const out = `${(err as { stdout?: string; stderr?: string }).stdout ?? ""}${(err as { stderr?: string }).stderr ?? ""}`;
    if (/nothing to commit|no changes added/i.test(out)) {
      return { committed: false, pushed: false };
    }
    throw err;
  }

  if (!opts.push) return { committed: true, pushed: false };
  await exec("git", ["push", opts.remote, opts.branch], { cwd: opts.cwd });
  return { committed: true, pushed: true };
}

// ── Read-only history (the admin console's DNA timeline and roster history) ──

export interface Revision {
  hash: string;
  /** Author date, ISO 8601. */
  date: string;
  subject: string;
}

/** Commits that touched `path`, newest first; [] outside a repo or on error. */
export async function fileHistory(cwd: string, path: string, limit = 100): Promise<Revision[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", `-n${limit}`, "--follow", "--format=%H%x1f%aI%x1f%s", "--", path],
      { cwd },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", date = "", subject = ""] = line.split("\x1f");
        return { hash, date, subject };
      });
  } catch {
    return [];
  }
}

/** A file's content at a revision; null when it didn't exist there (or no repo). */
export async function fileAt(cwd: string, rev: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["show", `${rev}:${path}`], { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Working-tree state of one path: "clean", "modified" (uncommitted edits),
 * "untracked", or null when git can't say (no repo, no git).
 */
export async function fileStatus(cwd: string, path: string): Promise<"clean" | "modified" | "untracked" | null> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain", "--", path], { cwd });
    const code = stdout.slice(0, 2);
    if (!stdout.trim()) return "clean";
    return code === "??" ? "untracked" : "modified";
  } catch {
    return null;
  }
}
