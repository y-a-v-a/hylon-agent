import { loadConfig, loadSmtp, type Config } from "./config.ts";
import { sendMail } from "./smtp.ts";
import type { GeneratedMeta } from "./generator.ts";
import type { JuryVerdict } from "./jury.ts";

/** URL to the approval dashboard entry for a candidate. */
export function dashboardUrl(cfg: Config, id: string): string {
  const host = cfg.dashboard.host || "localhost";
  return `http://${host}:${cfg.dashboard.port}/candidate/${id}`;
}

export interface Email {
  subject: string;
  body: string;
}

/** One line of per-dimension scores, e.g. "novelty 4 · nuance 4 · craft 3". */
export function scoresLine(scores: Record<string, number>): string {
  return Object.entries(scores)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
}

/** Build the notification email (pure, testable). */
export function buildEmail(
  id: string,
  meta: GeneratedMeta,
  verdict: JuryVerdict,
  url: string,
  opts: { refined?: boolean } = {},
  name = "agent",
): Email {
  const tag = opts.refined ? "refined" : verdict.verdict;
  const total = `${verdict.weighted_total}/${verdict.max_weighted}`;
  const subject = `${name} · ${tag} ${total} — ${meta.title}`;
  const body = [
    opts.refined
      ? "Your refinement is ready, re-juried, and still awaiting your confirmation."
      : "A new candidate passed the jury and is awaiting your confirmation.",
    "",
    `  ${meta.title}`,
    `  ${meta.summary}`,
    "",
    `Verdict: ${verdict.verdict} — ${total}`,
    `Scores: ${scoresLine(verdict.scores)}`,
    `Principles: ${verdict.principles_invoked.join(", ")}`,
    `References: ${meta.references.join("; ")}`,
    "",
    "Jury rationale:",
    verdict.rationale,
    "",
    `Reservations: ${verdict.reservations ?? "none"}`,
    "",
    "Review & approve:",
    `  ${url}`,
    "",
    `Local: workspace/pending/${id}/index.html`,
    "",
    `— ${name}`,
  ].join("\n");
  return { subject, body };
}

/**
 * Notify the artist a candidate awaits the gate. Sends authenticated SMTP when
 * configured (SMTP_* env + email.to in config); otherwise logs to the console —
 * email is optional, the dashboard is the gate either way.
 */
export async function sendCandidateEmail(
  id: string,
  meta: GeneratedMeta,
  verdict: JuryVerdict,
  opts: { refined?: boolean } = {},
): Promise<void> {
  const cfg = loadConfig();
  const { subject, body } = buildEmail(id, meta, verdict, dashboardUrl(cfg, id), opts, cfg.name);
  const smtp = loadSmtp();
  if (!smtp || !cfg.email.to) {
    console.log(`[notify] email not configured — ${subject}\n${body}`);
    return;
  }
  await sendMail(smtp, { from: smtp.from, to: cfg.email.to, subject, body });
}
