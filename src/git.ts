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
