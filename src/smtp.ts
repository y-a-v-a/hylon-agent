import tls from "node:tls";
import { hostname } from "node:os";

// Minimal SMTP-over-implicit-TLS client (port 465). No dependencies.
// STARTTLS (port 587) is intentionally not implemented — use a 465/SMTPS port.

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface MailInput {
  from: string;
  to: string;
  subject: string;
  body: string;
}

// ── Message building (pure, testable) ────────────────────────────────────────

/** RFC 2047 encode a header value if it contains non-ASCII (e.g. "·", "—"). */
export function encodeHeaderWord(s: string): string {
  return /[^\x00-\x7F]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`
    : s;
}

/** Wrap a base64 string to 76-char lines (CRLF), per MIME. */
export function wrapBase64(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

/** Build an RFC 5322 message: UTF-8 plain text, base64-encoded body. */
export function buildMessage(mail: MailInput, date: Date): string {
  const headers = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, "+0000")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = wrapBase64(Buffer.from(mail.body, "utf8").toString("base64"));
  return headers.join("\r\n") + "\r\n\r\n" + body + "\r\n";
}

// ── SMTP dialog (lockstep request/response) ──────────────────────────────────

interface Resp {
  code: number;
  lines: string[];
}

class SmtpConn {
  private buffer = "";
  private waiter: { resolve: (r: Resp) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly socket: tls.TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.buffer += d;
      this.flush();
    });
    socket.on("error", (e: Error) => this.waiter?.reject(e));
    socket.on("close", () => this.waiter?.reject(new Error("SMTP connection closed")));
  }

  private flush(): void {
    if (!this.waiter) return;
    const parts = this.buffer.split("\r\n");
    for (let i = 0; i < parts.length; i++) {
      // A reply is complete on a line "NNN " (space, not "NNN-" continuation).
      const m = /^(\d{3}) /.exec(parts[i]!);
      if (m) {
        const resp: Resp = { code: Number(m[1]), lines: parts.slice(0, i + 1) };
        this.buffer = parts.slice(i + 1).join("\r\n");
        const w = this.waiter;
        this.waiter = null;
        w!.resolve(resp);
        return;
      }
    }
  }

  read(): Promise<Resp> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.flush();
    });
  }

  send(line: string): void {
    this.socket.write(line + "\r\n");
  }

  raw(data: string): void {
    this.socket.write(data);
  }

  async expect(code: number, command?: string): Promise<Resp> {
    if (command !== undefined) this.send(command);
    const r = await this.read();
    if (r.code !== code) {
      const where = command ? ` after "${command.split(" ")[0]}"` : "";
      throw new Error(`SMTP: expected ${code}${where}, got ${r.code}: ${r.lines.join(" | ")}`);
    }
    return r;
  }
}

/** Send one message over authenticated implicit-TLS SMTP. Throws on any failure. */
export async function sendMail(cfg: SmtpConfig, mail: MailInput, now: Date = new Date()): Promise<void> {
  if (!cfg.secure) {
    throw new Error("Only implicit TLS is supported; use a secure SMTPS port (e.g. SMTP_PORT=465).");
  }
  const socket = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host });
  socket.setTimeout(20_000, () => socket.destroy(new Error("SMTP timed out")));

  await new Promise<void>((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });

  const conn = new SmtpConn(socket);
  try {
    const greeting = await conn.read();
    if (greeting.code !== 220) throw new Error(`SMTP greeting ${greeting.code}: ${greeting.lines.join(" | ")}`);

    await conn.expect(250, `EHLO ${hostname()}`);

    // AUTH LOGIN (credentials base64'd; never echoed into errors)
    conn.send("AUTH LOGIN");
    if ((await conn.read()).code !== 334) throw new Error("SMTP AUTH LOGIN not accepted");
    conn.send(Buffer.from(cfg.user, "utf8").toString("base64"));
    if ((await conn.read()).code !== 334) throw new Error("SMTP username not accepted");
    conn.send(Buffer.from(cfg.pass, "utf8").toString("base64"));
    if ((await conn.read()).code !== 235) throw new Error("SMTP authentication failed (bad user/pass?)");

    await conn.expect(250, `MAIL FROM:<${mail.from}>`);
    await conn.expect(250, `RCPT TO:<${mail.to}>`);
    await conn.expect(354, "DATA");
    conn.raw(buildMessage(mail, now) + ".\r\n");
    const accepted = await conn.read();
    if (accepted.code !== 250) {
      throw new Error(`SMTP message not accepted (${accepted.code}): ${accepted.lines.join(" | ")}`);
    }
    conn.send("QUIT");
  } finally {
    socket.end();
  }
}
