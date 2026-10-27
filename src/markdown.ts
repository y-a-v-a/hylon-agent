import { escapeHtml } from "./dashboard.ts";
import { slugify } from "./ids.ts";

// Dependency-free markdown → HTML for the admin console: enough CommonMark to
// render a DNA document faithfully (frontmatter, headings, nested lists,
// blockquotes, fences, tables, emphasis, links) — not a general-purpose
// renderer. Everything is escaped first; links only keep safe schemes.

// ── Frontmatter ──────────────────────────────────────────────────────────────

export type FrontmatterValue = string | string[];

export interface Frontmatter {
  data: Record<string, FrontmatterValue>;
  /** The document after the frontmatter block. */
  body: string;
  /** 1-based line of the source the body starts on (for raw-view anchors). */
  bodyLine: number;
}

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineList(v: string): string[] {
  const inner = v.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map(unquote).filter(Boolean);
}

/**
 * Split a leading `---` YAML block off a document. Only the flat subset a DNA
 * uses is understood: `key: value`, quoted strings, `[a, b]`, and `- item`
 * lists under an empty key. Anything else is kept as its raw string.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/\r\n?/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { data: {}, body: src, bodyLine: 1 };
  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | null = null;
  for (const line of m[1]!.split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/) ?? line.match(/^-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    if (value.trim() === "") {
      data[key] = [];
      listKey = key;
    } else if (value.trim().startsWith("[") && value.trim().endsWith("]")) {
      data[key] = parseInlineList(value);
      listKey = null;
    } else {
      data[key] = unquote(value);
      listKey = null;
    }
  }
  return {
    data,
    body: src.slice(m[0].length),
    bodyLine: m[0].split("\n").length - (m[0].endsWith("\n") ? 1 : 0) + 1,
  };
}

// ── Inline ───────────────────────────────────────────────────────────────────

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // javascript:, data:, …
  return u; // relative, #fragment, /path
}

/** Render inline markdown; the input is raw (unescaped) text. */
export function renderInline(text: string): string {
  const slots: string[] = [];
  const hold = (html: string): string => `\u0000${slots.push(html) - 1}\u0000`;

  // 1. Code spans are opaque: nothing inside them is formatted.
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) =>
    hold(`<code>${escapeHtml(code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1"))}</code>`),
  );
  // 1b. HTML comments vanish; backslash escapes become literal characters.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|<>"'])/g, (_, ch: string) => hold(escapeHtml(ch)));
  // 2. Links, before emphasis, so underscores in URLs survive.
  // (One level of balanced parentheses is allowed inside the URL.)
  s = s.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => {
    const href = safeHref(url);
    const inner = emphasis(escapeHtml(label));
    return hold(
      href === null
        ? inner
        : `<a href="${escapeHtml(href)}"${/^https?:/i.test(href) ? ' rel="noreferrer" target="_blank"' : ""}>${inner}</a>`,
    );
  });
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, url: string) =>
    hold(`<a href="${escapeHtml(url)}" rel="noreferrer" target="_blank">${escapeHtml(url)}</a>`),
  );
  // 3. Everything else is escaped, then emphasised.
  s = emphasis(escapeHtml(s));
  // 4. Hard breaks (two trailing spaces or a backslash before the newline).
  s = s.replace(/(?: {2,}|\\)\n/g, "<br>\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]!);
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

// ── Blocks ───────────────────────────────────────────────────────────────────

export interface Heading {
  level: number;
  /** Plain text of the heading (inline markup stripped). */
  text: string;
  id: string;
}

interface Ctx {
  headings: Heading[];
  ids: Set<string>;
  /** Headings inside blockquotes/lists don't make the table of contents. */
  toc: boolean;
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function plain(md: string): string {
  return md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim();
}

function headingId(ctx: Ctx, text: string): string {
  const base = slugify(text) || "section";
  let id = base;
  for (let n = 2; ctx.ids.has(id); n++) id = `${base}-${n}`;
  ctx.ids.add(id);
  return id;
}

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/)![0];
  return m.replace(/\t/g, "    ").length;
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line);
}

const SETEXT = /^\s{0,3}(=+|-+)\s*$/;

/**
 * Whether `line` ends a running paragraph (CommonMark): any block start,
 * except that an ordered list may only interrupt when it starts at 1 — so a
 * hard-wrapped "1994. was the year…" stays prose. A table header followed by
 * its rule line interrupts too.
 */
function interruptsParagraph(line: string, next: string | undefined): boolean {
  const item = line.match(ITEM);
  if (item && /\d/.test(item[2]!)) return parseInt(item[2]!, 10) === 1;
  if (isBlockStart(line)) return true;
  return line.includes("|") && next !== undefined && TABLE_RULE.test(next) && next.includes("-");
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function renderTable(header: string, rule: string, rows: string[]): string {
  const aligns = splitRow(rule).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "",
  );
  const cell = (tag: string, c: string, i: number): string =>
    `<${tag}${aligns[i] ? ` style="text-align:${aligns[i]}"` : ""}>${renderInline(c)}</${tag}>`;
  const head = splitRow(header).map((c, i) => cell("th", c, i)).join("");
  const body = rows.map((r) => `<tr>${splitRow(r).map((c, i) => cell("td", c, i)).join("")}</tr>`).join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

/** Parse one list starting at lines[start]; returns the html and the next index. */
function renderList(lines: string[], start: number, ctx: Ctx): { html: string; next: number } {
  const first = lines[start]!.match(ITEM)!;
  const baseIndent = indentOf(first[1]!);
  const ordered = /\d/.test(first[2]!);
  const startNum = ordered ? parseInt(first[2]!, 10) : 1;
  const items: string[][] = [];
  let loose = false;
  let i = start;

  while (i < lines.length) {
    const m = lines[i]!.match(ITEM);
    if (!m || indentOf(m[1]!) !== baseIndent || /\d/.test(m[2]!) !== ordered) break;
    const contentIndent = indentOf(m[1]!) + m[2]!.length + 1;
    const body = [m[3]!];
    i++;
    while (i < lines.length) {
      const line = lines[i]!;
      if (line.trim() === "") {
        // A blank line continues the item only if indented content follows.
        let j = i + 1;
        while (j < lines.length && lines[j]!.trim() === "") j++;
        if (j < lines.length && indentOf(lines[j]!) > baseIndent) {
          loose = true;
          for (; i < j; i++) body.push("");
          continue;
        }
        const n = j < lines.length ? lines[j]!.match(ITEM) : null;
        if (n && indentOf(n[1]!) === baseIndent && /\d/.test(n[2]!) === ordered) loose = true;
        break;
      }
      const ind = indentOf(line);
      if (ind > baseIndent) {
        // Nested content: dedent by the item's content column (or as far as it goes).
        body.push(line.slice(Math.min(ind, contentIndent)).replace(/^\t/, ""));
        i++;
        continue;
      }
      const sibling = line.match(ITEM);
      if (sibling && indentOf(sibling[1]!) === baseIndent && /\d/.test(sibling[2]!) === ordered) break;
      if (!interruptsParagraph(line, lines[i + 1])) {
        body.push(line.trim()); // lazy continuation of the item's paragraph
        i++;
        continue;
      }
      break;
    }
    // Skip the blank lines between items (already noted as loose above).
    while (i < lines.length && lines[i]!.trim() === "") {
      const n = lines.slice(i).find((l) => l.trim() !== "");
      const nm = n?.match(ITEM);
      if (nm && indentOf(nm[1]!) === baseIndent && /\d/.test(nm[2]!) === ordered) i++;
      else break;
    }
    items.push(body);
  }

  const lis = items.map((body) => {
    let html = renderBlocks(body, { ...ctx, toc: false });
    if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
    return `<li>${html}</li>`;
  });
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return { html: `<${tag}${startAttr}>\n${lis.join("\n")}\n</${tag}>`, next: i };
}

function renderBlocks(lines: string[], ctx: Ctx): string {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[2]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) code.push(lines[i++]!);
      i++; // closing fence (or EOF)
      const lang = fence[3] ? ` class="lang-${escapeHtml(fence[3])}"` : "";
      out.push(`<pre><code${lang}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const h = line.match(HEADING);
    if (h) {
      const level = h[1]!.length;
      const text = plain(h[2]!);
      const id = headingId(ctx, text);
      if (ctx.toc) ctx.headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${renderInline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (QUOTE.test(lines[i]!) || quoted.length > 0)) {
        if (!QUOTE.test(lines[i]!) && isBlockStart(lines[i]!)) break;
        quoted.push(lines[i]!.replace(/^\s{0,3}> ?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(quoted, { ...ctx, toc: false })}</blockquote>`);
      continue;
    }

    if (ITEM.test(line)) {
      const { html, next } = renderList(lines, i, ctx);
      out.push(html);
      i = next;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const header = line;
      const rule = lines[i + 1]!;
      const rows: string[] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) rows.push(lines[i++]!);
      out.push(renderTable(header, rule, rows));
      continue;
    }

    // Paragraph: until a blank line or the start of another block — or a
    // setext underline (=== / ---), which turns it into a heading.
    const para: string[] = [line.trimStart()];
    i++;
    let setext = 0;
    while (i < lines.length && lines[i]!.trim() !== "") {
      const under = lines[i]!.match(SETEXT);
      if (under) {
        setext = under[1]!.startsWith("=") ? 1 : 2;
        i++;
        break;
      }
      if (interruptsParagraph(lines[i]!, lines[i + 1])) break;
      para.push(lines[i++]!.trimStart()); // trailing spaces kept: they mark hard breaks
    }
    if (setext) {
      const raw = para.join(" ").trim();
      const id = headingId(ctx, plain(raw));
      if (ctx.toc) ctx.headings.push({ level: setext, text: plain(raw), id });
      out.push(`<h${setext} id="${id}">${renderInline(raw)}</h${setext}>`);
      continue;
    }
    const inner = renderInline(para.join("\n"));
    if (inner.trim()) out.push(`<p>${inner}</p>`);
  }
  return out.join("\n");
}

export interface Rendered {
  html: string;
  /** Top-level headings in document order, with their anchor ids. */
  headings: Heading[];
}

/** Remove HTML comments (possibly multi-line) outside fenced code. */
function stripComments(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let prose: string[] = [];
  const flush = (): void => {
    if (prose.length) out.push(...prose.join("\n").replace(/<!--[\s\S]*?-->/g, "").split("\n"));
    prose = [];
  };
  for (const line of lines) {
    const f = line.match(FENCE);
    if (fence === null && f) {
      flush();
      fence = f[2]!;
      out.push(line);
    } else if (fence !== null) {
      out.push(line);
      if (line.trim().startsWith(fence)) fence = null;
    } else prose.push(line);
  }
  flush();
  return out;
}

/** Render a markdown document (no frontmatter — split it off first). */
export function renderMarkdown(md: string): Rendered {
  const ctx: Ctx = { headings: [], ids: new Set(), toc: true };
  const html = renderBlocks(stripComments(md.replace(/\r\n?/g, "\n").split("\n")), ctx);
  return { html, headings: ctx.headings };
}
