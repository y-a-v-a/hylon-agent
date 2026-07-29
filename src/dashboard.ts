import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import type { GeneratedMeta } from "./generator.ts";
import type { JuryVerdict } from "./jury.ts";
import { scoresLine } from "./notify.ts";
import { isValidId } from "./ids.ts";
import { decide, type Decision } from "./promote.ts";
import { runRefine, isRefining, markRefining } from "./refine.ts";
import { listOrphans, readOrphanRecord, rejuryOrphan, type OrphanItem } from "./orphans.ts";

// The refiner is injectable so tests can stub it (a real refine drives the generator).
let refiner: (id: string, feedback: string) => Promise<void> = runRefine;
export function setRefiner(fn: (id: string, feedback: string) => Promise<void>): void {
  refiner = fn;
}

// Likewise the re-jury (a real one calls the jury provider and spends money).
let rejurier: (id: string) => Promise<unknown> = rejuryOrphan;
export function setRejurier(fn: (id: string) => Promise<unknown>): void {
  rejurier = fn;
}

// The decider (approve/reject) is injectable too, for hermetic route tests.
type Decider = (id: string, decision: Decision, opts?: { push?: boolean; note?: string }) => Promise<unknown>;
let decider: Decider = decide;
export function setDecider(fn: Decider): void {
  decider = fn;
}

export interface PendingItem {
  id: string;
  meta: GeneratedMeta;
  verdict: JuryVerdict;
}

// ── Rendering (pure, testable) ───────────────────────────────────────────────
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parse an application/x-www-form-urlencoded body (pure, testable). */
export function parseFormBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawVal = eq < 0 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey.replace(/\+/g, " "))] = decodeURIComponent(
        rawVal.replace(/\+/g, " "),
      );
    } catch {
      // skip a malformed pair
    }
  }
  return out;
}

const STYLE = `
  :root{--ink:#1a1a1a;--muted:#6b6b6b;--line:#e3e0d8;--paper:#f4f1e9;--accent:#002fa7}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 Georgia,serif}
  header{padding:1.2rem 1.5rem;border-bottom:1px solid var(--line)}
  header a{color:var(--accent);text-decoration:none}
  main{max-width:60rem;margin:0 auto;padding:1.5rem}
  .badge{display:inline-block;padding:.1rem .5rem;border-radius:.2rem;font:600 13px/1.4 monospace;color:#fff}
  .strong{background:#1a7a3a}.borderline{background:#b8860b}.reject{background:#a02020}
  .card{border:1px solid var(--line);border-radius:.4rem;padding:1rem 1.2rem;margin:1rem 0;background:#fff}
  .muted{color:var(--muted)}
  .scores{font:13px/1.6 monospace}
  iframe{width:100%;height:60vh;border:1px solid var(--line);border-radius:.4rem;background:#fff}
  pre{white-space:pre-wrap;font:14px/1.55 Georgia,serif;background:#faf8f2;padding:1rem;border-radius:.3rem}
  form{display:inline}
  button{font:600 15px/1 Georgia,serif;padding:.6rem 1.4rem;border-radius:.3rem;border:1px solid var(--line);cursor:pointer}
  .approve{background:#1a7a3a;color:#fff;border-color:#1a7a3a}
  .rejectbtn{background:#fff;color:#a02020;border-color:#a02020;margin-left:.5rem}
  label{display:block;font:600 14px/1.4 Georgia,serif;margin-bottom:.35rem}
  textarea{width:100%;font:14px/1.5 Georgia,serif;padding:.6rem;border:1px solid var(--line);border-radius:.3rem;margin-bottom:.6rem;resize:vertical}
  .refinebtn{background:var(--accent);color:#fff;border-color:var(--accent)}
  .orphan{background:#4a4a4a}
  .rejurybtn{background:#4a4a4a;color:#fff;border-color:#4a4a4a}
  .err{font:13px/1.5 monospace;color:#a02020;word-break:break-word}
  h2.section{margin-top:2.5rem;border-top:1px solid var(--line);padding-top:1.5rem}
`;

const DEFAULT_NAME = "agent";

function shell(title: string, body: string, name = DEFAULT_NAME): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><header><a href="/">${escapeHtml(name)}</a> · approval gateway</header><main>${body}</main></body></html>`;
}

function badge(verdict: JuryVerdict): string {
  return `<span class="badge ${verdict.verdict}">${verdict.verdict} ${verdict.weighted_total}/${verdict.max_weighted}</span>`;
}

/** The orphan section of the landing page — omitted entirely when there are none. */
function orphanSection(orphans: OrphanItem[]): string {
  if (orphans.length === 0) return "";
  const rows = orphans
    .map(
      (it) => `<div class="card">
  <a href="/orphan/${encodeURIComponent(it.id)}"><strong>${escapeHtml(it.meta.title)}</strong></a>
  <span class="badge orphan">no verdict</span>
  <div class="muted">${escapeHtml(it.meta.summary)}</div>
  <p class="err">${escapeHtml(it.orphan?.error ?? "stranded (no record)")}</p>
</div>`,
    )
    .join("\n");
  return `<h2 class="section">Orphaned (${orphans.length})</h2>
<p class="muted">Finished works the jury never graded. Re-jury one to send it back through the gate.</p>
${rows}`;
}

export function renderIndex(items: PendingItem[], orphans: OrphanItem[] = [], name = DEFAULT_NAME): string {
  const rows = items
    .map(
      (it) => `<div class="card">
  <a href="/candidate/${encodeURIComponent(it.id)}"><strong>${escapeHtml(it.meta.title)}</strong></a>
  ${badge(it.verdict)}
  <div class="muted">${escapeHtml(it.meta.summary)}</div>
</div>`,
    )
    .join("\n");
  const pending =
    items.length === 0
      ? `<p class="muted">No candidates awaiting confirmation.</p>`
      : `<h1>Pending (${items.length})</h1>${rows}`;
  return shell(`${name} · pending`, `${pending}${orphanSection(orphans)}`, name);
}

/** A stranded work: the work itself, why it never got a verdict, and a re-jury button. */
export function renderOrphan(
  id: string,
  meta: GeneratedMeta,
  orphan: OrphanItem["orphan"],
  motivation: string,
  name = DEFAULT_NAME,
): string {
  const enc = encodeURIComponent(id);
  const body = `
  <h1>${escapeHtml(meta.title)} <span class="badge orphan">no verdict</span></h1>
  <p>${escapeHtml(meta.summary)}</p>
  <div class="card">
    <strong>This work was never graded.</strong>
    <p class="err">${escapeHtml(orphan?.error ?? "stranded (no record)")}</p>
    <p class="muted">Stranded ${escapeHtml(orphan?.at ?? "at an unknown time")} · generation cost $${orphan?.costUsd?.toFixed(2) ?? "?"}${
      orphan?.violations?.length
        ? ` · <strong>self-containment violations:</strong> ${escapeHtml(orphan.violations.join("; "))}`
        : ""
    }</p>
  </div>
  <iframe src="/orphan/${enc}/work" title="work" sandbox="allow-scripts allow-downloads" referrerpolicy="no-referrer"></iframe>
  <div class="card">
    <form method="POST" action="/orphan/${enc}/rejury">
      <label>Re-jury — grade it now and send it to pending for your decision</label>
      <button class="rejurybtn" type="submit">Re-jury →</button>
    </form>
  </div>
  <h2>Motivation</h2>
  <pre>${escapeHtml(motivation)}</pre>`;
  return shell(`${name} · ${meta.title}`, body, name);
}

/** The work iframe + jury card, shared by the pending and resolved views. */
function workAndJury(id: string, meta: GeneratedMeta, verdict: JuryVerdict): string {
  return `
  <iframe src="/candidate/${encodeURIComponent(id)}/work" title="work" sandbox="allow-scripts allow-downloads" referrerpolicy="no-referrer"></iframe>
  <div class="card">
    <div class="scores">${escapeHtml(scoresLine(verdict.scores))}</div>
    <p><strong>Jury:</strong> ${escapeHtml(verdict.rationale)}</p>
    ${verdict.reservations ? `<p class="muted"><strong>Reservations:</strong> ${escapeHtml(verdict.reservations)}</p>` : ""}
    <p class="muted">Principles: ${escapeHtml(verdict.principles_invoked.join(", "))} · License: ${escapeHtml(meta.license)} · Jury: ${escapeHtml(verdict.jury_model)}</p>
  </div>`;
}

export function renderCandidate(
  id: string,
  meta: GeneratedMeta,
  verdict: JuryVerdict,
  motivation: string,
  refining = false,
  name = DEFAULT_NAME,
): string {
  const enc = encodeURIComponent(id);
  const actions = refining
    ? `<div class="card"><strong>Refining…</strong> the agent is reworking this candidate from your feedback. You'll be notified when it's ready — reload to check.</div>`
    : `<div class="card">
    <form method="POST" action="/candidate/${enc}/approve"><button class="approve" type="submit">Approve → publish</button></form>
  </div>
  <div class="card">
    <form method="POST" action="/candidate/${enc}/reject">
      <label for="note">Reject — optional note (the agent learns from it next round)</label>
      <textarea id="note" name="note" rows="2" placeholder="e.g. too reverent — I want more bite"></textarea>
      <button class="rejectbtn" type="submit">Reject</button>
    </form>
  </div>
  <div class="card">
    <form method="POST" action="/candidate/${enc}/refine">
      <label for="feedback">Refine — tell the agent what to change</label>
      <textarea id="feedback" name="feedback" rows="3" required placeholder="e.g. the canvas throws a TypeError on click — fix it; and raise the contrast"></textarea>
      <button class="refinebtn" type="submit">Refine →</button>
    </form>
  </div>`;
  const body = `
  <h1>${escapeHtml(meta.title)} ${badge(verdict)}</h1>
  <p>${escapeHtml(meta.summary)}</p>
  ${workAndJury(id, meta, verdict)}
  ${actions}
  <h2>Motivation</h2>
  <pre>${escapeHtml(motivation)}</pre>`;
  return shell(`${name} · ${meta.title}`, body, name);
}

/** A candidate that has already been decided — no action buttons, just status. */
export function renderResolved(
  id: string,
  meta: GeneratedMeta,
  verdict: JuryVerdict,
  status: "published" | "rejected",
  motivation: string,
  name = DEFAULT_NAME,
): string {
  const note =
    status === "published"
      ? `<strong>Published ✓</strong> — you already approved this; it lives in the catalogue.`
      : `<strong>Rejected</strong> — this candidate was set aside.`;
  const body = `
  <h1>${escapeHtml(meta.title)} ${badge(verdict)}</h1>
  <div class="card">${note} &nbsp; <a href="/">← back to pending</a></div>
  ${workAndJury(id, meta, verdict)}
  <h2>Motivation</h2>
  <pre>${escapeHtml(motivation)}</pre>`;
  return shell(`${name} · ${meta.title}`, body, name);
}

export function renderNotFound(name = DEFAULT_NAME): string {
  return shell(
    `${name} · not found`,
    `<h1>Nothing here</h1><p class="muted">That page doesn't exist. <a href="/">← back to pending</a></p>`,
    name,
  );
}

// ── Data ─────────────────────────────────────────────────────────────────────
export function listPending(cfg: Config): PendingItem[] {
  if (!existsSync(cfg.abs.pending)) return [];
  const items: PendingItem[] = [];
  for (const entry of readdirSync(cfg.abs.pending, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(cfg.abs.pending, entry.name);
    try {
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as GeneratedMeta;
      const verdict = JSON.parse(readFileSync(join(dir, "jury.json"), "utf8")) as JuryVerdict;
      items.push({ id: entry.name, meta, verdict });
    } catch {
      // skip malformed candidate dirs
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export type Lifecycle = "pending" | "published" | "rejected";

/** Find which lifecycle dir holds a candidate, searching pending→published→rejected. */
export function candidateLocation(cfg: Config, id: string): { status: Lifecycle; dir: string } | null {
  const roots: [Lifecycle, string][] = [
    ["pending", cfg.abs.pending],
    ["published", cfg.abs.published],
    ["rejected", cfg.abs.rejected],
  ];
  for (const [status, root] of roots) {
    const dir = join(root, id);
    if (existsSync(dir)) return { status, dir };
  }
  return null;
}

// CSP for a rendered work: it must make ZERO external requests. This is the real
// enforcement of self-containment (the generator regex is only a first pass).
// default-src 'none' blocks external loads; connect-src 'none' blocks
// fetch/XHR/WebSocket/sendBeacon/EventSource; inline + data: + blob: are allowed
// so legitimately self-contained works still render.
export const WORK_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; " +
  "style-src 'unsafe-inline'; script-src 'unsafe-inline' 'unsafe-eval' blob:; " +
  "font-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

// ── Server ───────────────────────────────────────────────────────────────────
function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > limit) throw new Error("request body too large");
  }
  return data;
}

export async function handle(req: IncomingMessage, res: ServerResponse, cfg: Config): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["candidate","<id>","work"]
  const name = cfg.name ?? DEFAULT_NAME;

  if (req.method === "GET" && parts.length === 0) {
    return send(res, 200, "text/html; charset=utf-8", renderIndex(listPending(cfg), listOrphans(cfg), name));
  }

  if (parts[0] === "orphan" && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    if (!isValidId(id)) return send(res, 404, "text/html; charset=utf-8", renderNotFound(name));
    const dir = join(cfg.abs.orphaned, id);
    if (!existsSync(dir)) return send(res, 404, "text/html; charset=utf-8", renderNotFound(name));

    if (req.method === "GET" && parts.length === 2) {
      const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as GeneratedMeta;
      const motivation = readFileSync(join(dir, "motivation.md"), "utf8");
      const html = renderOrphan(id, meta, readOrphanRecord(dir), motivation, name);
      return send(res, 200, "text/html; charset=utf-8", html);
    }

    if (req.method === "GET" && parts[2] === "work") {
      const work = join(dir, "index.html");
      if (!existsSync(work)) return send(res, 404, "text/html; charset=utf-8", renderNotFound(name));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": WORK_CSP });
      res.end(readFileSync(work, "utf8"));
      return;
    }

    if (req.method === "POST" && parts[2] === "rejury") {
      // Fire and forget, like refine: the jury call takes seconds and the lock
      // serializes it against a running wake. Landing page shows the result.
      void rejurier(id).catch((err) => console.error(`[rejury] ${id}: ${(err as Error).message}`));
      res.writeHead(303, { Location: "/" });
      return void res.end();
    }
  }

  if (parts[0] === "candidate" && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    // Untrusted input: reject anything that isn't a well-formed candidate id
    // before it can reach the filesystem (path-traversal guard).
    if (!isValidId(id)) return send(res, 404, "text/html; charset=utf-8", renderNotFound(name));
    const loc = candidateLocation(cfg, id);

    if (req.method === "GET" && parts.length === 2) {
      // Truly unknown → bounce to the landing page; decided → status page.
      if (!loc) {
        res.writeHead(303, { Location: "/" });
        res.end();
        return;
      }
      const meta = JSON.parse(readFileSync(join(loc.dir, "meta.json"), "utf8")) as GeneratedMeta;
      const verdict = JSON.parse(readFileSync(join(loc.dir, "jury.json"), "utf8")) as JuryVerdict;
      const motivation = readFileSync(join(loc.dir, "motivation.md"), "utf8");
      const html =
        loc.status === "pending"
          ? renderCandidate(id, meta, verdict, motivation, isRefining(loc.dir), name)
          : renderResolved(id, meta, verdict, loc.status, motivation, name);
      return send(res, 200, "text/html; charset=utf-8", html);
    }

    if (req.method === "GET" && parts[2] === "work") {
      const work = loc ? join(loc.dir, "index.html") : null;
      if (!work || !existsSync(work)) return send(res, 404, "text/html; charset=utf-8", renderNotFound(name));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": WORK_CSP });
      res.end(readFileSync(work, "utf8"));
      return;
    }

    if (req.method === "POST" && (parts[2] === "approve" || parts[2] === "reject")) {
      const decision: Decision = parts[2] === "approve" ? "approve" : "reject";
      let note: string | undefined;
      if (decision === "reject") {
        try {
          note = parseFormBody(await readBody(req)).note?.trim() || undefined;
        } catch {
          note = undefined; // oversized/garbled body → reject without a note
        }
      }
      try {
        await decider(id, decision, note ? { note } : {});
        res.writeHead(303, { Location: "/" });
        res.end();
      } catch (err) {
        send(res, 409, "text/html; charset=utf-8", renderNotFound(name));
      }
      return;
    }

    if (req.method === "POST" && parts[2] === "refine") {
      const back = { Location: `/candidate/${encodeURIComponent(id)}` };
      if (!loc || loc.status !== "pending") return send(res, 409, "text/html; charset=utf-8", renderNotFound(name));
      if (isRefining(loc.dir)) {
        res.writeHead(303, back);
        return void res.end();
      }
      let feedback: string;
      try {
        feedback = (parseFormBody(await readBody(req)).feedback ?? "").trim();
      } catch {
        return send(res, 413, "text/html; charset=utf-8", renderNotFound(name));
      }
      if (!feedback) {
        res.writeHead(303, back);
        return void res.end();
      }
      try {
        markRefining(loc.dir, feedback, new Date()); // exclusive; throws if one is in flight
      } catch {
        res.writeHead(303, back);
        return void res.end();
      }
      void refiner(id, feedback).catch((err) => console.error(`[refine] ${id}: ${(err as Error).message}`));
      res.writeHead(303, back);
      return void res.end();
    }
  }

  send(res, 404, "text/html; charset=utf-8", renderNotFound(name));
}

export function startDashboard(): ReturnType<typeof createServer> {
  const cfg = loadConfig();
  const server = createServer((req, res) => {
    handle(req, res, cfg).catch((err) => send(res, 500, "text/plain", `Error: ${err.message}`));
  });
  server.listen(cfg.dashboard.port, "0.0.0.0", () => {
    const host = cfg.dashboard.host || "localhost";
    console.log(`[dashboard] http://${host}:${cfg.dashboard.port}`);
  });
  return server;
}

// CLI: `npm run dashboard`
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard();
}
