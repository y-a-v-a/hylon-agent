import { existsSync } from "node:fs";
import { escapeHtml as e, renderDnaDiff } from "./dashboard.ts";
import { diffLines, diffStats } from "./diff.ts";
import { parseFrontmatter, renderInline, renderMarkdown } from "./markdown.ts";
import { maxWeighted, type Config } from "./config.ts";
import { bySeverity, countLevels, worst, type Check, type Level } from "./health.ts";
import { perMillion, vendorOf, type Catalog, type Endpoint, type ModelUse, type OpenRouterModel } from "./models.ts";
import { PURPOSES, type DailyUsage, type UsageSummary } from "./usage.ts";
import { summarizeWake, type JurorStat, type RubricPractice, type WorkRecord } from "./insights.ts";
import type { Revision } from "./git.ts";
import type { AmendmentItem } from "./amend.ts";
import type {
  DnaState,
  EnvState,
  HistoryState,
  ModelDetailState,
  ModelsState,
  OverviewState,
  PromptsState,
  UseView,
} from "./admin.ts";

// Pure HTML rendering for the admin console (admin.ts gathers the data).
// Same idiom as dashboard.ts: template strings, everything dynamic escaped,
// no client framework — one small script for chart tooltips.

export interface Chrome {
  name: string;
  /** The approval gateway's URL (the dashboard). */
  gateway: string;
  now: Date;
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  const a = Math.abs(n);
  return `$${n.toFixed(a < 0.01 ? 4 : a < 1 ? 3 : 2)}`;
}

export function tok(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

const num = (n: number): string => n.toLocaleString("en-US");

/** OpenRouter labels unnamed keys with their own masked form ("sk-or-v1-d2b...4cf"). */
const isMaskedKeyLabel = (label: string): boolean => /^sk-or-/.test(label);
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** "2026-10-26 14:05 UTC" */
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return e(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** "3 h ago" / "in 5 h" relative to `now`. */
export function rel(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const d = t - now.getTime();
  const a = Math.abs(d);
  const unit =
    a < 60_000
      ? "just now"
      : a < 3_600_000
        ? `${Math.round(a / 60_000)} min`
        : a < 172_800_000
          ? `${Math.round(a / 3_600_000)} h`
          : `${Math.round(a / 86_400_000)} d`;
  if (unit === "just now") return unit;
  return d < 0 ? `${unit} ago` : `in ${unit}`;
}

function timeTag(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  return `<time class="nw" datetime="${e(iso)}" title="${e(when(iso))}">${e(rel(iso, now))}</time>`;
}

const ICON: Record<Level, string> = { ok: "✓", info: "i", warn: "!", fail: "✕" };
const LEVEL_WORD: Record<Level, string> = { ok: "ok", info: "note", warn: "warning", fail: "failure" };

function levelIcon(level: Level, title = LEVEL_WORD[level]): string {
  return `<span class="ic ${level}" role="img" aria-label="${e(title)}" title="${e(title)}">${ICON[level]}</span>`;
}

function pill(level: Level, text: string): string {
  return `<span class="pill ${level}">${ICON[level]} ${e(text)}</span>`;
}

/** A model id linking to its lookup page; it breaks only after the vendor slash. */
function modelLink(id: string): string {
  const slash = id.indexOf("/");
  const label =
    slash < 0 ? `<span>${e(id)}</span>` : `<span>${e(id.slice(0, slash + 1))}</span><wbr><span>${e(id.slice(slash + 1))}</span>`;
  return `<a class="model" href="/model?id=${encodeURIComponent(id)}">${label}</a>`;
}

function checkList(checks: Check[], opts: { hideOk?: boolean } = {}): string {
  const shown = opts.hideOk ? checks.filter((c) => c.level !== "ok") : checks;
  if (shown.length === 0) return "";
  return `<ul class="checks">${bySeverity(shown)
    .map(
      (c) => `<li class="${c.level}">${levelIcon(c.level)}<div><span class="cl">${
        c.href ? `<a href="${e(c.href)}">${e(c.label)}</a>` : e(c.label)
      }</span>${c.detail ? `<span class="cd">${e(c.detail)}</span>` : ""}</div></li>`,
    )
    .join("")}</ul>`;
}

function summaryOf(checks: Check[]): { level: Level; text: string } {
  const n = countLevels(checks);
  const level = worst(checks);
  if (n.fail) return { level, text: `${n.fail} failure${n.fail === 1 ? "" : "s"}${n.warn ? ` · ${n.warn} warning${n.warn === 1 ? "" : "s"}` : ""}` };
  if (n.warn) return { level, text: `${n.warn} warning${n.warn === 1 ? "" : "s"}` };
  return { level: level === "info" ? "ok" : level, text: n.info ? `all clear · ${n.info} note${n.info === 1 ? "" : "s"}` : "all clear" };
}

/** A single-series inline bar, 0–1. */
function bar(share: number, title?: string): string {
  const w = Math.max(0, Math.min(1, share)) * 100;
  return `<span class="bar"${title ? ` data-tip="${e(title)}" tabindex="0"` : ""}><span style="width:${w.toFixed(1)}%"></span></span>`;
}

function meter(share: number, level: Level = "info"): string {
  const w = Math.max(0, Math.min(1, share)) * 100;
  return `<span class="meter ${level}"><span style="width:${w.toFixed(1)}%"></span></span>`;
}

// ── Shell ────────────────────────────────────────────────────────────────────

type NavKey = "overview" | "dna" | "history" | "models" | "prompts" | "config" | "";

const NAV: [NavKey, string, string][] = [
  ["overview", "/", "Overview"],
  ["dna", "/dna", "DNA"],
  ["history", "/history", "History"],
  ["models", "/models", "Models"],
  ["prompts", "/prompts", "Prompts"],
  ["config", "/config", "Config"],
];

const STYLE = `
:root{
  color-scheme:light;
  --paper:#f4f1e9;--card:#fffdf8;--ink:#1a1a1a;--muted:#6b6b6b;--faint:#8f8b82;--line:#e3e0d8;--line2:#d3cec2;
  --accent:#002fa7;--accent-wash:#e7ebf6;--code:#ece8dd;
  --ok:#1a7a3a;--info:#002fa7;--warn:#9a6c00;--fail:#a02020;
  --ok-wash:#e3f0e6;--info-wash:#e7ebf6;--warn-wash:#f6ecd2;--fail-wash:#f7e3e3;
  --s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s0:#a8a49a;
  --v-strong:#1a7a3a;--v-borderline:#b8860b;--v-reject:#a02020;
  --grid:#e6e2d8;--axis:#c3c2b7;
  --serif:Georgia,"Times New Roman",serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{
    color-scheme:dark;
    --paper:#151513;--card:#1e1d1a;--ink:#ece9e1;--muted:#a8a49a;--faint:#8a867c;--line:#302e29;--line2:#403d36;
    --accent:#8ea6ff;--accent-wash:#22283a;--code:#2a2925;
    --ok:#5cbf7a;--info:#8ea6ff;--warn:#e0aa3a;--fail:#ec7a7a;
    --ok-wash:#1d2b21;--info-wash:#22283a;--warn-wash:#2f2716;--fail-wash:#311d1d;
    --s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s0:#6b685f;
    --v-strong:#3f9a5a;--v-borderline:#c9971f;--v-reject:#c65353;
    --grid:#2a2925;--axis:#403d36;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 var(--serif)}
a{color:var(--accent)}
a:hover{text-decoration-thickness:2px}
code,.mono{font-family:var(--mono);font-size:.84em}
code{background:var(--code);padding:.06em .32em;border-radius:.25em}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
.top .in{max-width:76rem;margin:0 auto;padding:.7rem 1.5rem;display:flex;flex-wrap:wrap;align-items:baseline;gap:.4rem 1.6rem}
.brand{font-size:1.05rem;white-space:nowrap}
.brand a{color:var(--ink);text-decoration:none}
.brand span{color:var(--muted)}
nav{display:flex;flex-wrap:wrap;gap:.2rem 1.1rem;flex:1}
nav a{color:var(--muted);text-decoration:none;padding:.1rem 0;border-bottom:2px solid transparent}
nav a:hover{color:var(--ink)}
nav a[aria-current]{color:var(--ink);border-bottom-color:var(--accent)}
.ext{font-size:.9rem;white-space:nowrap}
main{max-width:76rem;margin:0 auto;padding:1.6rem 1.5rem 4rem;min-width:0}
footer.foot{max-width:76rem;margin:0 auto;padding:1rem 1.5rem 2rem;color:var(--faint);font-size:.82rem;border-top:1px solid var(--line)}
h1{font-weight:400;font-size:1.9rem;line-height:1.2;margin:.2rem 0 .5rem}
h2{font-weight:400;font-size:1.4rem;margin:2.6rem 0 .8rem;padding-top:1.4rem;border-top:1px solid var(--line)}
main>h2:first-child{margin-top:0;padding-top:0;border-top:0}
h3{font-size:1.05rem;margin:1.4rem 0 .5rem}
.lede{color:var(--muted);max-width:46rem;margin:.2rem 0 1.4rem}
.muted{color:var(--muted)}
.small{font-size:.86rem}
.eyebrow{font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(21rem,100%),1fr));gap:1rem;margin:1rem 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:.5rem;padding:1rem 1.2rem;min-width:0}
.card h3{margin:0 0 .6rem;font-size:1rem;display:flex;align-items:baseline;justify-content:space-between;gap:.6rem}
.card h3 a{font-size:.85rem;font-weight:400}
.hero{padding:.4rem 0 1.2rem}
.essence{font-size:1.2rem;font-style:italic;max-width:48rem;margin:.4rem 0 .6rem}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}
.kv dt{color:var(--muted);font-size:.88rem}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.stats{display:flex;flex-wrap:wrap;gap:.6rem 1.8rem;margin:.2rem 0 .8rem}
.stat .v{font-size:1.45rem;line-height:1.1}
.stat .l{display:block;color:var(--muted);font-size:.8rem}
.pill{display:inline-block;border-radius:1rem;padding:.12rem .7rem;font-size:.85rem;white-space:nowrap}
.pill.ok{background:var(--ok-wash);color:var(--ok)}
.pill.info{background:var(--info-wash);color:var(--info)}
.pill.warn{background:var(--warn-wash);color:var(--warn)}
.pill.fail{background:var(--fail-wash);color:var(--fail)}
.tag{display:inline-block;font:12px/1.5 var(--mono);border:1px solid var(--line2);border-radius:.3rem;padding:0 .4rem;color:var(--muted);white-space:nowrap}
.ic{display:inline-grid;place-items:center;width:1.2rem;height:1.2rem;border-radius:50%;font:700 11px/1 var(--mono);flex:none;color:#fff}
.ic.ok{background:var(--ok)}.ic.info{background:var(--info)}.ic.warn{background:var(--warn)}.ic.fail{background:var(--fail)}
@media (prefers-color-scheme: dark){.ic{color:#151513}}
ul.checks{list-style:none;padding:0;margin:.4rem 0}
ul.checks li{display:flex;gap:.6rem;align-items:flex-start;padding:.45rem 0;border-top:1px solid var(--line)}
ul.checks li:first-child{border-top:0}
ul.checks .ic{margin-top:.18rem}
ul.checks .cl{display:block}
ul.checks .cd{display:block;color:var(--muted);font-size:.88rem}
table.t{border-collapse:collapse;width:100%;font-size:.93rem}
table.t th,table.t td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
table.t th{font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:400;white-space:nowrap}
table.t td.n,table.t th.n{text-align:right;font-family:var(--mono);font-size:.84rem;font-variant-numeric:tabular-nums;white-space:nowrap}
table.t tr.changed td.c{background:var(--accent-wash)}
.scroll{overflow-x:auto}
a.model{font-family:var(--mono);font-size:.86em}
a.model>span{white-space:nowrap}
.nw{white-space:nowrap}
.bar{display:inline-block;vertical-align:middle;width:7rem;height:.55rem;background:var(--grid);border-radius:.3rem;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent);border-radius:0 .3rem .3rem 0}
.meter{display:block;height:.5rem;background:var(--grid);border-radius:.3rem;overflow:hidden;margin:.35rem 0}
.meter>span{display:block;height:100%;border-radius:.3rem}
.meter.ok>span{background:var(--ok)}.meter.info>span{background:var(--accent)}.meter.warn>span{background:var(--warn)}.meter.fail>span{background:var(--fail)}
.mix{display:flex;gap:2px;height:.7rem;width:9rem;vertical-align:middle}
.mix span{display:block;height:100%}
.mix span:first-child{border-radius:.25rem 0 0 .25rem}.mix span:last-child{border-radius:0 .25rem .25rem 0}
.mix span:only-child{border-radius:.25rem}
.v-strong{background:var(--v-strong)}.v-borderline{background:var(--v-borderline)}.v-reject{background:var(--v-reject)}
.legend{display:flex;flex-wrap:wrap;gap:.3rem 1.1rem;font-size:.85rem;color:var(--muted);margin:.4rem 0}
.legend i{display:inline-block;width:.75rem;height:.75rem;border-radius:.15rem;margin-right:.35rem;vertical-align:-1px}
.legend i.dot{border-radius:50%}
svg.chart{display:block;width:100%;height:auto;overflow:visible}
svg.chart text{font:11px var(--mono);fill:var(--muted)}
svg.chart .grid{stroke:var(--grid);stroke-width:1}
svg.chart .axis{stroke:var(--axis);stroke-width:1}
svg.chart .col:hover .seg,svg.chart .col:focus .seg{opacity:.8}
svg.chart .col:focus{outline:none}
svg.chart .col:focus .hit{stroke:var(--accent);stroke-width:1.5}
svg.chart .fuse{stroke:var(--fail);stroke-width:1.5}
.tip{position:fixed;z-index:50;pointer-events:none;background:var(--card);color:var(--ink);border:1px solid var(--line2);box-shadow:0 4px 18px rgba(0,0,0,.14);border-radius:.4rem;padding:.45rem .65rem;font:12px/1.5 var(--mono);max-width:22rem}
.tip .tip-h{color:var(--muted);margin-bottom:.15rem}
.tip .tip-r{display:flex;gap:.5rem;align-items:center}
.tip .tip-r b{font-weight:700}
.tip .k{display:inline-block;width:.8rem;height:2px}
details{margin:.4rem 0}
details>summary{cursor:pointer;color:var(--accent)}
details[open]>summary{margin-bottom:.4rem}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12.5px/1.55 var(--mono);background:var(--code);border-radius:.35rem;padding:.8rem 1rem;margin:.4rem 0;max-height:36rem;overflow:auto}
.banner{border-left:3px solid var(--warn);background:var(--warn-wash);padding:.7rem 1rem;border-radius:0 .35rem .35rem 0;margin:0 0 1.2rem}
.banner.fail{border-color:var(--fail);background:var(--fail-wash)}
.banner p{margin:.2rem 0}
/* DNA page */
.doc{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:2.4rem;align-items:start}
.toc{position:sticky;top:4.2rem;max-height:calc(100vh - 5rem);overflow:auto;font-size:.88rem;padding-right:.5rem}
.toc ol{list-style:none;padding:0;margin:.3rem 0}
.toc li{margin:.18rem 0}
.toc li.l3{padding-left:.9rem;font-size:.84rem}
.toc a{color:var(--muted);text-decoration:none}
.toc a:hover{color:var(--accent)}
.toc .sep{border-top:1px solid var(--line);margin:.6rem 0;padding-top:.6rem}
.md{max-width:44rem;font-size:1.02rem;line-height:1.65}
.md h1{font-size:1.7rem}
.md h2{font-size:1.35rem}
.md h3{font-size:1.08rem}
.md h1,.md h2,.md h3,.md h4{scroll-margin-top:4.5rem}
.md blockquote{margin:1rem 0;padding:.2rem 1rem;border-left:3px solid var(--line2);color:var(--muted)}
.md li{margin:.25rem 0}
.md table{border-collapse:collapse;margin:1rem 0;font-size:.92rem}
.md th,.md td{border-bottom:1px solid var(--line);padding:.35rem .6rem;text-align:left}
.md pre{max-height:none}
.md hr{border:0;border-top:1px solid var(--line);margin:2rem 0}
.principles{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(17rem,100%),1fr));gap:.6rem}
.principle{background:var(--card);border:1px solid var(--line);border-radius:.45rem;padding:.6rem .8rem;font-size:.92rem}
.principle b{font-family:var(--mono);font-size:.82rem;color:var(--accent);margin-right:.35rem}
.principle p{margin:.25rem 0 0;color:var(--muted);font-size:.86rem}
/* History */
.timeline{list-style:none;padding:0;margin:.6rem 0;border-left:2px solid var(--line);margin-left:.45rem}
.timeline>li{position:relative;padding:.1rem 0 1.2rem 1.4rem}
.timeline>li::before{content:"";position:absolute;left:-.45rem;top:.4rem;width:.8rem;height:.8rem;border-radius:50%;background:var(--card);border:2px solid var(--line2)}
.timeline>li.ratified::before{background:var(--ok);border-color:var(--ok)}
.timeline>li.declined::before{background:var(--card);border-color:var(--fail)}
.timeline>li.proposed::before{background:var(--accent);border-color:var(--accent)}
.timeline>li.commit::before{background:var(--line2);border-color:var(--line2)}
.timeline .when{font:12px var(--mono);color:var(--muted)}
.timeline .what{display:block;margin:.1rem 0}
.diff{font:12px/1.55 var(--mono);background:var(--code);padding:1rem;border-radius:.35rem;overflow-x:auto;white-space:pre}
.diff .add{display:block;background:var(--ok-wash);color:var(--ok)}
.diff .del{display:block;background:var(--fail-wash);color:var(--fail)}
.diff .ctx{display:block;color:var(--muted)}
.diff .gap{display:block;color:var(--faint);font-style:italic}
.entry{border-top:1px solid var(--line);padding:.6rem 0}
.entry.seen{border-left:3px solid var(--accent);padding-left:.8rem}
.entry .md{font-size:.95rem}
form.lookup{display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0 1.2rem}
form.lookup input{flex:1;min-width:16rem;font:14px var(--mono);padding:.5rem .7rem;border:1px solid var(--line2);border-radius:.35rem;background:var(--card);color:var(--ink)}
form.lookup button{font:15px var(--serif);padding:.5rem 1.1rem;border-radius:.35rem;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
@media (prefers-color-scheme: dark){form.lookup button{color:#151513}}
.roles{display:flex;flex-wrap:wrap;gap:.35rem}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr));gap:.4rem 1.6rem}
.cols ul{margin:.2rem 0;padding-left:1.1rem}
.cols li{margin:.15rem 0}
.why{margin:.2rem 0 .8rem}
.use{scroll-margin-top:4.5rem}
section[id]{scroll-margin-top:4.5rem}
@media (max-width:52rem){
  .doc{grid-template-columns:minmax(0,1fr)}
  .toc{position:static;max-height:none}
  .grid{grid-template-columns:minmax(0,1fr)}
  .stats{gap:.6rem 1.2rem}
  .ext{display:none}
  main{padding:1.2rem 1rem 3rem}
  .top .in{padding:.6rem 1rem}
  h1{font-size:1.55rem}
}
`;

// One tooltip for every [data-tip] element: first line is the header, every
// later line a row ("value · label"; a leading "#rrggbb|" sets the row key).
// Built with textContent — labels may come from model ids and work titles.
const SCRIPT = `(()=>{const t=document.createElement("div");t.className="tip";t.hidden=true;document.body.appendChild(t);
const place=(x,y)=>{const r=t.getBoundingClientRect();let l=x+14,p=y+14;if(l+r.width>innerWidth-8)l=x-r.width-14;if(p+r.height>innerHeight-8)p=y-r.height-14;t.style.left=Math.max(8,l)+"px";t.style.top=Math.max(8,p)+"px"};
const show=(el,x,y)=>{t.replaceChildren();el.dataset.tip.split("\\n").forEach((line,i)=>{const d=document.createElement("div");if(i===0){d.className="tip-h";d.textContent=line}else{d.className="tip-r";const m=line.match(/^(#[0-9a-fA-F]{3,8}|var\\(--[a-z0-9-]+\\))\\|(.*)$/);if(m){const k=document.createElement("span");k.className="k";k.style.background=m[1];d.appendChild(k);line=m[2]}const parts=line.split(" · ");const b=document.createElement("b");b.textContent=parts[0];d.appendChild(b);if(parts.length>1){const s=document.createElement("span");s.textContent=parts.slice(1).join(" · ");d.appendChild(s)}}t.appendChild(d)});t.hidden=false;place(x,y)};
document.addEventListener("pointerover",ev=>{const el=ev.target.closest&&ev.target.closest("[data-tip]");if(el)show(el,ev.clientX,ev.clientY)});
document.addEventListener("pointermove",ev=>{if(!t.hidden)place(ev.clientX,ev.clientY)});
document.addEventListener("pointerout",ev=>{const el=ev.target.closest&&ev.target.closest("[data-tip]");if(el&&!el.contains(ev.relatedTarget))t.hidden=true});
document.addEventListener("focusin",ev=>{const el=ev.target.closest&&ev.target.closest("[data-tip]");if(el){const r=el.getBoundingClientRect();show(el,r.left+r.width/2,r.top+r.height/2)}});
document.addEventListener("focusout",()=>{t.hidden=true});})();`;

function shell(title: string, active: NavKey, body: string, c: Chrome): string {
  const nav = NAV.map(
    ([key, href, label]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${e(title)} · ${e(c.name)} admin</title><style>${STYLE}</style></head>
<body><header class="top"><div class="in">
<div class="brand"><a href="/">${e(c.name)}</a> <span>· administration</span></div>
<nav aria-label="Admin sections">${nav}</nav>
<a class="ext" href="${e(c.gateway)}">approval gateway ↗</a>
</div></header>
<main>${body}</main>
<footer class="foot">Read-only · bound to 127.0.0.1 · config and files are re-read on every request · rendered ${e(when(c.now.toISOString()))}</footer>
<script>${SCRIPT}</script>
</body></html>`;
}

export function renderNotFound(c: Chrome, message = "That page doesn't exist."): string {
  return shell("not found", "", `<h1>Nothing here</h1><p class="muted">${e(message)} <a href="/">← overview</a></p>`, c);
}

export function renderConfigError(message: string, raw: string | null): string {
  const c: Chrome = { name: "agent", gateway: "/", now: new Date() };
  return shell(
    "config error",
    "config",
    `<div class="banner fail"><p><strong>agent.config.json does not validate</strong> — the harness won't start until it does. Fix the file and reload this page.</p></div>
<h2>Validation error</h2><pre>${e(message)}</pre>
<h2>agent.config.json</h2>${raw === null ? `<p class="muted">The file could not be read.</p>` : `<pre>${e(raw)}</pre>`}`,
    c,
  );
}

// ── Charts ───────────────────────────────────────────────────────────────────

const PURPOSE_COLOR: Record<string, string> = {
  generate: "var(--s1)",
  refine: "var(--s2)",
  jury: "var(--s3)",
  amend: "var(--s4)",
  other: "var(--s0)",
};
const STACK_ORDER = [...PURPOSES, "other"];
const purposeColor = (p: string): string => (Object.hasOwn(PURPOSE_COLOR, p) ? PURPOSE_COLOR[p]! : "var(--s0)");

function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * exp >= x) return m * exp;
  return 10 * exp;
}

/** Path for a column segment with 4px rounded top corners (square at the base). */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function purposeLegend(present: string[]): string {
  return `<div class="legend">${STACK_ORDER.filter((p) => present.includes(p))
    .map((p) => `<span><i style="background:${PURPOSE_COLOR[p]}"></i>${e(p)}</span>`)
    .join("")}</div>`;
}

/** 30-day stacked columns of spend by purpose, with the daily fuse when it's on scale. */
export function dailyChart(days: DailyUsage[], perDayFuse: number): string {
  const maxDay = Math.max(0, ...days.map((d) => d.total));
  if (maxDay === 0) return `<p class="muted">No spend recorded in the last ${days.length} days.</p>`;
  const fuseOnScale = perDayFuse <= maxDay * 1.6;
  const yMax = niceCeil(fuseOnScale ? Math.max(maxDay, perDayFuse) : maxDay);
  const W = 720;
  const H = 210;
  const m = { l: 52, r: 10, t: 10, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const band = pw / days.length;
  const bw = Math.min(24, band - 3);
  const y = (v: number): number => m.t + ph - (v / yMax) * ph;
  const present = new Set<string>();
  const ticks = [0, yMax / 2, yMax];
  const grid = ticks
    .map((v) => `<line class="${v === 0 ? "axis" : "grid"}" x1="${m.l}" x2="${W - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${m.l - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${e(usd(v))}</text>`)
    .join("");
  const cols = days
    .map((d, i) => {
      const x = m.l + i * band + (band - bw) / 2;
      const segs = STACK_ORDER.map((p) => [p, d.byPurpose[p] ?? 0] as const).filter(([, v]) => v > 0);
      let base = 0;
      const rects = segs
        .map(([p, v], k) => {
          present.add(p);
          const y0 = y(base);
          const y1 = y(base + v);
          base += v;
          const gap = k > 0 ? 2 : 0; // surface gap between stacked segments
          // A sliver stays visible (the tooltip and table carry the exact value).
          const h = Math.max(1.5, y0 - y1 - gap);
          const top = k === segs.length - 1;
          const ys = y0 - gap - h;
          return top
            ? `<path class="seg" d="${roundedTop(x, ys, bw, h, 4)}" fill="${PURPOSE_COLOR[p]}"/>`
            : `<rect class="seg" x="${x.toFixed(1)}" y="${ys.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${PURPOSE_COLOR[p]}"/>`;
        })
        .join("");
      const tip = [
        d.date,
        `${usd(d.total)} · total, ${d.calls} call${d.calls === 1 ? "" : "s"}`,
        ...segs.map(([p, v]) => `${PURPOSE_COLOR[p]}|${usd(v)} · ${p}`),
      ].join("\n");
      return `<g class="col" tabindex="0" data-tip="${e(tip)}"><rect class="hit" x="${(m.l + i * band).toFixed(1)}" y="${m.t}" width="${band.toFixed(1)}" height="${ph}" fill="transparent"/>${rects}</g>`;
    })
    .join("");
  const xl = [0, Math.floor(days.length / 2), days.length - 1]
    .map((i) => `<text x="${(m.l + i * band + band / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${e(days[i]!.date.slice(5))}</text>`)
    .join("");
  const fuse = fuseOnScale
    ? `<line class="fuse" x1="${m.l}" x2="${W - m.r}" y1="${y(perDayFuse).toFixed(1)}" y2="${y(perDayFuse).toFixed(1)}"/><text x="${W - m.r}" y="${(y(perDayFuse) - 4).toFixed(1)}" text-anchor="end">daily fuse ${e(usd(perDayFuse))}</text>`
    : "";
  const rows = days
    .filter((d) => d.total > 0)
    .map((d) => `<tr><td class="mono">${e(d.date)}</td>${STACK_ORDER.map((p) => `<td class="n">${d.byPurpose[p] ? usd(d.byPurpose[p]) : "—"}</td>`).join("")}<td class="n">${usd(d.total)}</td><td class="n">${d.calls}</td></tr>`)
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spend per day over the last ${days.length} days, stacked by purpose">${grid}${cols}${fuse}${xl}</svg>
${purposeLegend([...present])}
${fuseOnScale ? "" : `<p class="small muted">The daily fuse (${e(usd(perDayFuse))}) is far above this range and is not drawn.</p>`}
<details><summary>Table view</summary><div class="scroll"><table class="t"><thead><tr><th>Date</th>${STACK_ORDER.map((p) => `<th class="n">${e(p)}</th>`).join("")}<th class="n">Total</th><th class="n">Calls</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

/** A small single-series column sparkline of daily totals. */
function sparkline(days: DailyUsage[]): string {
  const max = Math.max(0, ...days.map((d) => d.total));
  if (max === 0) return "";
  const W = 300;
  const H = 44;
  const band = W / days.length;
  const bw = Math.min(8, band - 2);
  const cols = days
    .map((d, i) => {
      const h = d.total > 0 ? Math.max(2, (d.total / max) * (H - 4)) : 0;
      const x = i * band + (band - bw) / 2;
      return `<g class="col" tabindex="0" data-tip="${e(`${d.date}\n${usd(d.total)} · ${d.calls} call${d.calls === 1 ? "" : "s"}`)}"><rect class="hit" x="${(i * band).toFixed(1)}" y="0" width="${band.toFixed(1)}" height="${H}" fill="transparent"/>${h ? `<path class="seg" d="${roundedTop(x, H - h, bw, h, 2)}" fill="var(--accent)"/>` : ""}</g>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H + 2}" role="img" aria-label="Daily spend, last ${days.length} days"><line class="axis" x1="0" x2="${W}" y1="${H + 0.5}" y2="${H + 0.5}"/>${cols}</svg>`;
}

function verdictMix(v: Record<"strong" | "borderline" | "reject", number>): string {
  const total = v.strong + v.borderline + v.reject;
  if (!total) return "—";
  const seg = (k: "strong" | "borderline" | "reject"): string =>
    v[k] ? `<span class="v-${k}" style="flex:${v[k]}"></span>` : "";
  return `<span class="mix" tabindex="0" data-tip="${e(`verdicts\nvar(--v-strong)|${v.strong} · strong\nvar(--v-borderline)|${v.borderline} · borderline\nvar(--v-reject)|${v.reject} · reject`)}">${seg("strong")}${seg("borderline")}${seg("reject")}</span>`;
}

const VERDICT_LEGEND = `<div class="legend"><span><i class="v-strong"></i>strong</span><span><i class="v-borderline"></i>borderline</span><span><i class="v-reject"></i>reject</span></div>`;

/**
 * Where juried works land on the rubric's scale: the reject / borderline /
 * strong zones from config, and one dot per work (stacked when equal),
 * colored by what happened to it at the gate.
 */
export function scaleChart(works: WorkRecord[], max: number, thresholds: { strong: number; borderline: number }): string {
  const W = 720;
  const m = { l: 14, r: 14 };
  const pw = W - m.l - m.r;
  const x = (v: number): number => m.l + (Math.max(0, Math.min(max, v)) / max) * pw;
  const juried = works.filter((w) => w.verdict);
  const bucket = new Map<number, WorkRecord[]>();
  for (const w of juried) {
    const k = Math.round(w.verdict!.weighted_total * 2) / 2;
    bucket.set(k, [...(bucket.get(k) ?? []), w]);
  }
  const stack = Math.max(1, ...[...bucket.values()].map((b) => b.length));
  const r = 5;
  const step = 2 * r + 3;
  const dotsH = juried.length ? stack * step + 6 : 0;
  const zoneY = 8 + dotsH;
  const H = zoneY + 46;
  const cls = (w: WorkRecord): { fill: string; label: string } =>
    w.status === "published"
      ? { fill: "var(--ok)", label: "you approved" }
      : w.status === "pending"
        ? { fill: "var(--accent)", label: "awaiting you" }
        : w.decidedBy === "artist"
          ? { fill: "var(--fail)", label: "you rejected" }
          : { fill: "var(--s0)", label: "jury rejected" };
  const dots = [...bucket.entries()]
    .flatMap(([k, ws]) =>
      ws.map((w, i) => {
        const c = cls(w);
        const cy = zoneY - 6 - r - i * step;
        return `<circle cx="${x(k).toFixed(1)}" cy="${cy}" r="${r}" fill="${c.fill}" stroke="var(--card)" stroke-width="2" tabindex="0" data-tip="${e(`${w.title}\n${w.verdict!.weighted_total}/${w.verdict!.max_weighted} · ${w.verdict!.verdict}\n${c.label} · ${w.id}`)}"/>`;
      }),
    )
    .join("");
  const zone = (from: number, to: number, color: string, label: string): string =>
    `<rect x="${x(from).toFixed(1)}" y="${zoneY}" width="${Math.max(0, x(to) - x(from) - 2).toFixed(1)}" height="8" rx="2" style="fill:color-mix(in srgb, ${color} 30%, transparent)"/><text x="${((x(from) + x(to)) / 2).toFixed(1)}" y="${zoneY + 38}" text-anchor="middle">${e(label)}</text>`;
  const ticks = [0, thresholds.borderline, thresholds.strong, max]
    .map((v) => `<text x="${x(v).toFixed(1)}" y="${zoneY + 22}" text-anchor="${v === 0 ? "start" : v === max ? "end" : "middle"}" style="font-size:10px">${v}</text>`)
    .join("");
  const present = new Map<string, string>();
  for (const w of juried) present.set(cls(w).label, cls(w).fill);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weighted totals of juried works on the rubric scale">
${zone(0, thresholds.borderline, "var(--v-reject)", "reject")}${zone(thresholds.borderline, thresholds.strong, "var(--v-borderline)", "borderline")}${zone(thresholds.strong, max, "var(--v-strong)", "strong")}
${ticks}${dots}</svg>
${juried.length ? `<div class="legend">${[...present].map(([label, fill]) => `<span><i class="dot" style="background:${fill}"></i>${e(label)}</span>`).join("")}</div>` : `<p class="small muted">No juried works yet — once there are, each one appears here as a dot at its weighted total.</p>`}`;
}

// ── Overview ─────────────────────────────────────────────────────────────────

export function renderOverview(o: OverviewState, c: Chrome, cfg: Config): string {
  const a = o.dna.analysis;
  const s = summaryOf(o.checks);
  const attention = o.checks.filter((x) => x.level !== "ok");
  const dnaLine =
    o.dna.source === "dna"
      ? [
          a?.version ? `version ${e(a.version)}` : "",
          a?.date ? `dated ${e(a.date)}` : "",
          o.dna.lastChange ? `last committed ${timeTag(o.dna.lastChange.date, c.now)}` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : `no DNA yet at <code>${e(o.dna.path)}</code>`;

  const hero = `<section class="hero">
<p class="eyebrow">${e(o.name)} · administration</p>
<h1>${e(o.dna.source === "dna" && a ? a.title : "No artistic DNA yet")}</h1>
${o.dna.source === "dna" && a?.essence ? `<p class="essence">${renderInline(a.essence)}</p>` : ""}
<p class="muted">${dnaLine} · <a href="/dna">read the DNA →</a></p>
<p><a href="#attention" style="text-decoration:none">${pill(s.level, s.text)}</a></p>
</section>`;

  const attentionHtml = `<h2 id="attention">Needs attention</h2>${
    attention.length ? checkList(attention) : `<p class="muted">Nothing — every check passes.</p>`
  }`;

  const coupling = a ? a.checks : [];
  const couplingSummary = summaryOf(coupling);
  const sig = o.history;
  const dnaCard = `<div class="card"><h3>Artistic DNA <a href="/dna">open →</a></h3>
${
  a && o.dna.source === "dna"
    ? `<div class="stats"><span class="stat"><span class="v">${a.principles.length}</span><span class="l">principles</span></span><span class="stat"><span class="v">${a.gates.filter((g) => g.inConfig && g.status === "defined").length}/${cfg.rubric.gates.length}</span><span class="l">gates defined</span></span><span class="stat"><span class="v">${Object.keys(cfg.rubric.weights).length}</span><span class="l">dimensions</span></span><span class="stat"><span class="v">${tok(a.stats.tokens)}</span><span class="l">≈ tokens</span></span></div>
<p>${pill(couplingSummary.level, `rubric coupling: ${couplingSummary.text}`)}</p>`
    : `<p class="muted">The agent can't run without one. See <a href="/dna">the template</a>.</p>`
}
<p class="small muted" style="margin-bottom:.1rem">Signals toward the next amendment petition: <strong>${sig.signalCount}</strong> of ${sig.minSignals}${sig.enabled ? "" : " (petitions disabled)"}</p>
${meter(sig.signalCount / Math.max(1, sig.minSignals), sig.signalCount >= sig.minSignals ? "warn" : "info")}
${sig.pending.length ? `<p>${pill("info", "petition awaiting ratification")} <a href="${e(c.gateway)}amendment/${encodeURIComponent(sig.pending[0]!.id)}">decide →</a></p>` : ""}
<p class="small"><a href="/history">History: ${sig.revisions.length} commit${sig.revisions.length === 1 ? "" : "s"}, ${sig.archived.length} decided petition${sig.archived.length === 1 ? "" : "s"} →</a></p>
</div>`;

  const modelRows = o.models.uses
    .map((u) => {
      const lvl = worst(u.checks);
      return `<tr><td>${e(u.use.title)}${u.use.enabled ? "" : ` <span class="tag">off</span>`}</td><td>${modelLink(u.use.model)}</td><td>${levelIcon(lvl === "info" ? "ok" : lvl, u.checks.filter((x) => x.level !== "ok").map((x) => x.label).join("; ") || "fit for the role")}</td></tr>`;
    })
    .join("");
  const modelsCard = `<div class="card"><h3>Models <a href="/models">roles →</a></h3>
<table class="t"><tbody>${modelRows}</tbody></table>
<p class="small muted">${o.models.invariants.filter((x) => x.level !== "ok").length === 0 ? `${levelIcon("ok")} Two vendors, always — holds.` : `${levelIcon(worst(o.models.invariants))} ${e(o.models.invariants.find((x) => x.level !== "ok")!.label)}`}</p>
</div>`;

  const sp = o.spend;
  const spendLevel: Level = sp.today >= sp.perDay ? "fail" : sp.today >= sp.perDay * 0.8 ? "warn" : "info";
  const spendCard = `<div class="card"><h3>Spend <a href="/models#usage">ledger →</a></h3>
<div class="stats"><span class="stat"><span class="v">${usd(sp.today)}</span><span class="l">today (UTC) of ${usd(sp.perDay)} fuse</span></span><span class="stat"><span class="v">${usd(sp.last30)}</span><span class="l">last 30 days · ${num(sp.calls30)} calls</span></span></div>
${meter(sp.today / sp.perDay, spendLevel)}
${sp.ledger ? sparkline(o.models.usage.daily) : `<p class="small muted">The usage ledger is empty — it records every OpenRouter call from now on (<code>${e(cfg.paths.usage)}</code>).</p>`}
<p class="small muted">Per-wake fuse ${usd(sp.perWake)} · work budget ${o.daemon.workBudgetMinutes} min per wake</p>
</div>`;

  const w = o.works.counts;
  const worksCard = `<div class="card"><h3>Works <a href="${e(c.gateway)}">gateway ↗</a></h3>
<div class="stats"><span class="stat"><span class="v">${w.pending}</span><span class="l">pending</span></span><span class="stat"><span class="v">${w.published}</span><span class="l">published</span></span><span class="stat"><span class="v">${w.rejected}</span><span class="l">rejected</span></span><span class="stat"><span class="v">${w.orphaned}</span><span class="l">orphaned</span></span><span class="stat"><span class="v">${o.works.historical}</span><span class="l">historical</span></span></div>
${o.works.pending.length ? `<ul class="small">${o.works.pending.slice(0, 5).map((p) => `<li><a href="${e(c.gateway)}candidate/${encodeURIComponent(p.id)}">${e(p.title)}</a> ${p.verdict ? `<span class="tag">${e(p.verdict.verdict)} ${p.verdict.weighted_total}/${p.verdict.max_weighted}</span>` : ""}</li>`).join("")}</ul>` : `<p class="small muted">Nothing awaits your decision.</p>`}
${o.practice.verdicts ? `<p class="small muted">Jury outcomes so far: ${verdictMix(o.practice.outcome)} ${o.practice.outcome.strong} strong · ${o.practice.outcome.borderline} borderline · ${o.practice.outcome.reject} reject</p>` : ""}
</div>`;

  const d = o.daemon;
  const running = d.pids === null ? pill("info", "process unknown") : d.pids.length ? pill("ok", `running · pid ${d.pids.join(", ")}`) : pill("warn", "not running");
  const lastEvents = d.events.filter((x) => x.kind !== "other").slice(-5).reverse();
  const daemonCard = `<div class="card" id="daemon"><h3>Daemon</h3>
<p>${running} ${d.dashboardForeign ? pill("warn", `gateway port taken by “${d.dashboardTitle ?? "?"}”`) : d.dashboardStatus ? pill("ok", `gateway answers (${d.dashboardStatus})`) : pill("info", "gateway not reachable")}</p>
<dl class="kv small"><dt>schedule</dt><dd>every ${d.schedule.intervalHours} h${d.schedule.intervalFromLog && d.schedule.intervalHours !== d.intervalHours ? ` <span class="muted">(config now says ${d.intervalHours} h — restart to apply)</span>` : ""} · ${d.workBudgetMinutes} min budget</dd>
<dt>last wake</dt><dd>${d.schedule.lastWake ? `${timeTag(d.schedule.lastWake.at, c.now)} — ${e(summarizeWake(d.schedule.lastWake).slice(0, 140))}` : "—"}</dd>
<dt>next wake</dt><dd>${d.schedule.inProgress ? "a wake is running now" : d.schedule.next && d.pids?.length !== 0 ? `${timeTag(d.schedule.next, c.now)} (estimated)` : "—"}</dd></dl>
${lastEvents.length ? `<details><summary>Recent log</summary><ul class="small">${lastEvents.map((x) => `<li><span class="mono">${e(when(x.at))}</span> ${e((x.kind === "wake-done" || x.kind === "wake-error" ? summarizeWake(x) : x.text).slice(0, 160))}</li>`).join("")}</ul></details>` : `<p class="small muted">No daemon log at <code>logs/daemon.out.log</code>.</p>`}
${d.errTail.length ? `<details><summary>Error log tail</summary><pre>${e(d.errTail.join("\n"))}</pre></details>` : ""}
</div>`;

  const env = o.env;
  const ki = env.keyInfo?.info;
  const envCard = `<div class="card"><h3>Environment <a href="/config">config →</a></h3>
<dl class="kv small">
<dt>OpenRouter key</dt><dd>${env.key ? `<code>${e(env.key)}</code>${ki?.label && !isMaskedKeyLabel(ki.label) ? ` <span class="muted">${e(ki.label)}</span>` : ""}` : `${levelIcon("fail")} not set`}</dd>
${ki ? `<dt>key usage</dt><dd>${usd(ki.usage ?? null)}${ki.limit != null ? ` of ${usd(ki.limit)} limit` : " · no limit"}${ki.is_free_tier ? " · free tier" : ""}</dd>` : env.keyInfo?.error ? `<dt>key check</dt><dd class="muted">${e(env.keyInfo.error)}</dd>` : ""}
<dt>email</dt><dd>${env.smtp === "configured" ? (env.emailTo ? `to ${e(env.emailTo)}` : "SMTP set, no recipient (email.to)") : env.smtp === "absent" ? "console log (no SMTP)" : `${levelIcon("fail")} ${e(env.smtp)}`}</dd>
<dt>git</dt><dd>${env.push ? `pushes to ${e(env.remote)}` : "commits locally (git.push = false)"}</dd>
${Object.keys(env.switches).length ? `<dt>switches</dt><dd>${Object.entries(env.switches).map(([k, v]) => `<code>${e(k)}=${e(v)}</code>`).join(" ")}</dd>` : ""}
</dl></div>`;

  return shell(
    "overview",
    "overview",
    `${hero}<div class="grid">${dnaCard}${modelsCard}${spendCard}${worksCard}${daemonCard}${envCard}</div>${attentionHtml}`,
    c,
  );
}

// ── DNA ──────────────────────────────────────────────────────────────────────

function gitStatusNote(dna: DnaState, now: Date): string {
  const parts: string[] = [];
  if (dna.lastChange)
    parts.push(`last committed ${timeTag(dna.lastChange.date, now)} — <a href="/history/${e(dna.lastChange.hash.slice(0, 12))}">${e(dna.lastChange.subject)}</a>`);
  if (dna.gitStatus === "modified") parts.push(`<span class="pill warn">! uncommitted edits</span>`);
  if (dna.gitStatus === "untracked") parts.push(`<span class="pill warn">! not committed yet</span>`);
  return parts.join(" · ");
}

export function renderDnaPage(
  dna: DnaState,
  practice: RubricPractice,
  works: WorkRecord[],
  history: HistoryState,
  c: Chrome,
  cfg: Config,
): string {
  const a = dna.analysis;
  const banner =
    dna.source === "template"
      ? `<div class="banner fail"><p><strong>No DNA at <code>${e(dna.path)}</code>.</strong> The agent can't run without one. Shown below is <code>identity/DNA.template.md</code> — copy it to <code>${e(dna.path)}</code> and make it yours.</p></div>`
      : dna.source === "none"
        ? `<div class="banner fail"><p><strong>No DNA at <code>${e(dna.path)}</code>, and no template either.</strong></p></div>`
        : a?.isTemplate
          ? `<div class="banner"><p><strong>Still the template?</strong> The DNA contains template placeholders (“&lt;your name&gt;”, “This is a TEMPLATE”). Both agents read them as part of your identity.</p></div>`
          : "";
  if (!a) return shell("DNA", "dna", banner, c);

  const fmRows = Object.entries(a.frontmatter)
    .map(([k, v]) => `<dt>${e(k)}</dt><dd>${Array.isArray(v) ? (v.length ? v.map((x) => e(x)).join(", ") : `<span class="muted">—</span>`) : e(v)}</dd>`)
    .join("");
  const idCard = `<div class="card">
<div class="stats"><span class="stat"><span class="v">${num(a.stats.words)}</span><span class="l">words</span></span><span class="stat"><span class="v">≈${tok(a.stats.tokens)}</span><span class="l">tokens in every prompt</span></span><span class="stat"><span class="v">${a.principles.length}</span><span class="l">principles</span></span><span class="stat"><span class="v">${dna.rendered.headings.filter((h) => h.level === 2).length}</span><span class="l">sections</span></span></div>
${fmRows ? `<dl class="kv">${fmRows}</dl>` : `<p class="muted small">No frontmatter.</p>`}
</div>`;

  const principles = a.principles.length
    ? `<div class="principles">${a.principles.map((p) => `<div class="principle"><b>${e(p.id)}</b>${renderInline(p.name)}${p.text ? `<p>${renderInline(p.text)}</p>` : ""}</div>`).join("")}</div>`
    : `<p class="muted">No principle ids (P1, P2, …) found. Both agents cite principles by id.</p>`;

  const opinions = practice.opinions;
  const gateRows = a.gates
    .map((g) => {
      const status: [Level, string] =
        g.status === "defined" ? ["ok", "defined"] : g.status === "mentioned" ? ["warn", "mentioned only"] : g.status === "missing" ? ["fail", "missing from DNA"] : ["warn", "not in config"];
      const fails = practice.gateFails[g.id] ?? 0;
      return `<tr><td class="mono">${e(g.id)}</td><td>${g.name ? renderInline(g.name) : `<span class="muted">—</span>`}</td><td>${g.inConfig ? "yes" : `<span class="muted">no</span>`}</td><td>${pill(status[0], status[1])}</td><td class="n">${opinions && g.inConfig ? `${fails} <span class="muted">/ ${opinions}</span>` : "—"}</td></tr>`;
    })
    .join("");
  const weightSum = Object.values(cfg.rubric.weights).reduce((s, w) => s + w, 0);
  const dimRows = a.dimensions
    .map((d) => {
      const status: [Level, string] =
        d.status === "ok" ? ["ok", "matches"] : d.status === "unweighted" ? ["info", "weight unstated"] : d.status === "mismatch" ? ["warn", "weight differs"] : d.status === "missing" ? ["fail", "missing from DNA"] : ["warn", "not in config"];
      const mean = practice.scoreMeans[d.id];
      return `<tr><td>${e(d.id)}</td><td class="n">${d.configWeight !== null ? `×${d.configWeight}` : "—"}</td><td class="n">${d.dnaWeight !== null ? `×${d.dnaWeight}` : "—"}</td><td>${d.configWeight !== null ? `${bar(d.configWeight / weightSum, `${d.id}\n${pct(d.configWeight / weightSum)} · of the weighted total`)} <span class="small muted">${pct(d.configWeight / weightSum)}</span>` : ""}</td><td>${opinions && mean !== undefined && d.configWeight !== null ? `${bar(mean / cfg.rubric.scoreMax, `${d.id}\n${mean.toFixed(2)} · mean score of ${opinions} opinions (0–${cfg.rubric.scoreMax})`)} <span class="small mono">${mean.toFixed(1)}</span>` : `<span class="muted">—</span>`}</td><td>${pill(status[0], status[1])}</td></tr>`;
    })
    .join("");
  const max = maxWeighted(cfg.rubric);
  const thrRows = a.thresholds
    .map((t) => `<tr><td>${t.key === "max" ? "maximum" : e(t.key)}</td><td class="n">${t.key === "max" ? "" : "≥ "}${t.config}</td><td class="n">${t.dna === null ? `<span class="muted">not stated</span>` : t.dna}</td><td>${t.dna === null ? pill("info", "not stated") : t.dna === t.config ? pill("ok", "matches") : pill("warn", "differs")}</td></tr>`)
    .join("");

  const rubric = `<section id="rubric"><h2>The rubric, as the harness reads it</h2>
<p class="lede">The <em>shape</em> lives in <code>agent.config.json</code> (gate ids, dimensions, weights, thresholds); the <em>meaning</em> lives in the DNA. The harness asks the jury exactly the config's gates and dimensions — anything the DNA defines beyond them is never enforced, and anything it leaves undefined, the jury has to guess.</p>
${checkList(a.checks, { hideOk: true }) || `<p>${pill("ok", "the DNA and the config agree")}</p>`}
<h3>Hard gates <span class="muted small">(any failure rejects)</span></h3>
<div class="scroll"><table class="t"><thead><tr><th>Id</th><th>As the DNA names it</th><th>In config</th><th>Coupling</th><th class="n">Failed in practice</th></tr></thead><tbody>${gateRows}</tbody></table></div>
<h3>Scored dimensions <span class="muted small">(0–${cfg.rubric.scoreMax} each, max weighted ${max})</span></h3>
<div class="scroll"><table class="t"><thead><tr><th>Dimension</th><th class="n">Config</th><th class="n">DNA</th><th>Share of total</th><th>Mean score in practice</th><th>Coupling</th></tr></thead><tbody>${dimRows}</tbody></table></div>
<h3>Thresholds</h3>
<div class="scroll"><table class="t"><thead><tr><th>Verdict</th><th class="n">Config</th><th class="n">DNA states</th><th>Coupling</th></tr></thead><tbody>${thrRows}</tbody></table></div>
<h3>Where works land</h3>
<p class="small muted">${practice.verdicts ? `${practice.verdicts} juried work${practice.verdicts === 1 ? "" : "s"}, by aggregate weighted total, against the configured zones. Where your approvals cluster tells you whether the thresholds sit where your taste does.` : ""}</p>
${scaleChart(works, max, cfg.thresholds)}
</section>`;

  const toc = `<aside class="toc" aria-label="Contents"><p class="eyebrow">Contents</p><ol>
<li><a href="#principles">Principles</a></li><li><a href="#rubric">Rubric, as read</a></li><li><a href="#document">The document</a></li></ol>
<ol class="sep">${dna.rendered.headings.filter((h) => h.level >= 2 && h.level <= 3).map((h) => `<li class="l${h.level}"><a href="#${e(h.id)}">${e(h.text)}</a></li>`).join("")}</ol>
<p class="sep small">${dna.source === "dna" ? `<a href="/dna.md">raw markdown</a> · ` : ""}<a href="/history">history (${history.revisions.length})</a> · <a href="/prompts">as prompted</a></p></aside>`;

  const main = `<div>${banner}
<p class="eyebrow">${dna.source === "dna" ? "the artistic DNA" : "template preview"} · <code>${e(dna.source === "dna" ? dna.path : "identity/DNA.template.md")}</code></p>
<h1>${e(a.title)}</h1>
<p class="muted">${[a.version ? `version ${e(a.version)}` : "", a.date ? `dated ${e(a.date)}` : "", gitStatusNote(dna, c.now)].filter(Boolean).join(" · ")}</p>
${a.essence ? `<p class="essence">${renderInline(a.essence)}</p>` : ""}
${idCard}
<section id="principles"><h2>Principles</h2>${principles}</section>
${rubric}
<section id="document"><h2>The document</h2><article class="md">${dna.rendered.html}</article></section>
</div>`;
  return shell("DNA", "dna", `<div class="doc">${toc}${main}</div>`, c);
}

// ── History ──────────────────────────────────────────────────────────────────

type TimelineEvent =
  | { at: string; kind: "commit" | "ratified"; rev: Revision; petition?: AmendmentItem }
  | { at: string; kind: "declined" | "ratified" | "proposed"; petition: AmendmentItem; rev?: undefined };

export function timeline(history: HistoryState): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const attached = new Set<string>();
  for (const rev of history.revisions) {
    const petition = history.archived.find((p) => p.record.status === "accepted" && rev.subject.includes(p.id));
    if (petition) attached.add(petition.id);
    events.push({ at: rev.date, kind: petition ? "ratified" : "commit", rev, ...(petition ? { petition } : {}) });
  }
  for (const p of history.archived) {
    if (attached.has(p.id)) continue;
    events.push({ at: p.record.decidedAt ?? p.record.at ?? "", kind: p.record.status === "accepted" ? "ratified" : "declined", petition: p });
  }
  for (const p of history.pending) events.push({ at: p.record.at ?? "", kind: "proposed", petition: p });
  const t = (iso: string): number => new Date(iso).getTime() || 0;
  return events.sort((x, y) => t(y.at) - t(x.at));
}

function petitionDetails(p: AmendmentItem): string {
  // Records are written by amend.ts, but read defensively: a hand-edited or
  // older amendment.json must not take the page down.
  const r = p.record;
  const signals = Number(r.signalCount) || 0;
  const warnings = Array.isArray(r.warnings) ? r.warnings.map(String) : [];
  return `<span class="small muted">${signals} signal${signals === 1 ? "" : "s"} · +${Number(r.diff?.added) || 0} −${Number(r.diff?.removed) || 0} lines${typeof r.model === "string" ? ` · drafted by ${modelLink(r.model)}` : ""} · ${usd(typeof r.costUsd === "number" ? r.costUsd : null)}</span>
${r.note ? `<p class="small"><strong>Your note:</strong> ${e(String(r.note))}</p>` : ""}
${warnings.length ? `<p class="small">${levelIcon("warn")} ${e(warnings.join("; "))}</p>` : ""}
<details><summary>Rationale</summary><div class="md">${renderMarkdown(p.rationale).html}</div></details>`;
}

export function renderHistory(history: HistoryState, dna: DnaState, c: Chrome): string {
  const s = history.signals;
  const signalList = s
    ? [
        ...s.guidance.map((g) => `<li><span class="tag">rejection note</span> ${renderInline(g.text.replace(/^## /, "").replace(/\n/, " — "))}</li>`),
        ...s.refinements.map((r) => `<li><span class="tag">refinement</span> <span class="mono small">${e(r.id)}</span> — ${e(r.feedback)}</li>`),
      ].join("")
    : "";
  const signals = `<section id="signals"><h2>Toward the next petition</h2>
<p class="lede">Your rejection notes and refinement requests are signals that what you want may be drifting from what the DNA says. When ${history.minSignals} have accumulated since the last petition, the agent may draft an amendment${history.enabled ? "" : " — <strong>petitions are currently disabled</strong>"}. Only your ratification rewrites the DNA.</p>
<div class="stats"><span class="stat"><span class="v">${history.signalCount} / ${history.minSignals}</span><span class="l">signals since ${s ? e(s.since.slice(0, 10) === "1970-01-01" ? "the beginning" : s.since.slice(0, 10)) : "—"}</span></span>${s ? `<span class="stat"><span class="v">${s.published}</span><span class="l">published since</span></span><span class="stat"><span class="v">${s.rejected}</span><span class="l">rejected since</span></span>` : ""}</div>
${meter(history.signalCount / Math.max(1, history.minSignals), history.signalCount >= history.minSignals ? "warn" : "info")}
${signalList ? `<details><summary>The ${history.signalCount} signal${history.signalCount === 1 ? "" : "s"}</summary><ul class="small">${signalList}</ul></details>` : `<p class="muted small">No signals since the last petition.</p>`}
</section>`;

  const events = timeline(history);
  const items = events
    .map((ev) => {
      const head = `<span class="when">${e(when(ev.at))}</span>`;
      if (ev.kind === "proposed") {
        return `<li class="proposed">${head}<span class="what">${pill("info", "petition awaiting you")} <a href="${e(c.gateway)}amendment/${encodeURIComponent(ev.petition.id)}">decide on the gateway →</a></span>${petitionDetails(ev.petition)}</li>`;
      }
      if (ev.kind === "declined") {
        return `<li class="declined">${head}<span class="what">${pill("fail", "petition declined")} <span class="mono small">${e(ev.petition.id)}</span></span>${petitionDetails(ev.petition)}</li>`;
      }
      if (ev.rev) {
        const link = `<a class="mono small" href="/history/${e(ev.rev.hash.slice(0, 12))}">${e(ev.rev.hash.slice(0, 7))}</a>`;
        return `<li class="${ev.kind}">${head}<span class="what">${ev.kind === "ratified" ? `${pill("ok", "amendment ratified")} ` : ""}${e(ev.rev.subject)} ${link}</span>${ev.petition ? petitionDetails(ev.petition) : ""}</li>`;
      }
      return `<li class="ratified">${head}<span class="what">${pill("ok", "amendment ratified")} <span class="mono small">${e(ev.petition.id)}</span></span>${petitionDetails(ev.petition)}</li>`;
    })
    .join("");
  const tl = `<section id="timeline"><h2>Timeline</h2>
<p class="lede">Every commit that touched <code>${e(dna.path)}</code>, and every petition — ratified, declined, or pending. ${dna.gitStatus === "modified" ? `${pill("warn", "the working copy has uncommitted edits")}` : ""}</p>
${items ? `<ol class="timeline">${items}</ol>` : `<p class="muted">No history yet — ${dna.source === "dna" ? "the DNA has never been committed." : "there is no DNA."}</p>`}
</section>`;

  const g = history.guidance;
  const newestFirst = [...g.entries].reverse();
  const guidance = `<section id="guidance"><h2>Guidance <span class="muted small">— the generator reads it, the jury never does</span></h2>
<p class="lede">Each rejection-with-note is appended to <code>identity/guidance.md</code>. The generator treats the ${g.window} newest entries as binding direction; the jury is never shown them, so accumulated guidance can't drift the gate. Entries with a blue rule are inside the generator's window.</p>
${newestFirst.length ? newestFirst.map((entry, i) => `<div class="entry${i < g.window ? " seen" : ""}"><div class="md">${renderMarkdown(entry.text.replace(/^## /, "#### ")).html}</div></div>`).join("") : `<p class="muted">No guidance yet.</p>`}
</section>`;

  return shell(
    "history",
    "history",
    `<p class="eyebrow">the DNA that drifts</p><h1>How the DNA got here</h1>
<p class="lede">The artist writes the DNA; the agent may petition to amend it from the artist's own decisions at the gate; only ratification changes it. This is that negotiation, on the record.</p>
${signals}${tl}${guidance}`,
    c,
  );
}

export function renderRevision(rev: Revision, then: string, current: string, history: Revision[], c: Chrome): string {
  const i = history.findIndex((r) => r.hash === rev.hash);
  const newer = i > 0 ? history[i - 1] : undefined;
  const older = i >= 0 ? history[i + 1] : undefined;
  const stats = diffStats(diffLines(then, current));
  const nav = `<p class="small">${older ? `<a href="/history/${e(older.hash.slice(0, 12))}">← older (${e(older.date.slice(0, 10))})</a>` : `<span class="muted">← oldest</span>`} · <a href="/history">timeline</a> · ${newer ? `<a href="/history/${e(newer.hash.slice(0, 12))}">newer (${e(newer.date.slice(0, 10))}) →</a>` : `<span class="muted">newest →</span>`}</p>`;
  const fm = parseFrontmatter(then);
  return shell(
    `DNA at ${rev.hash.slice(0, 7)}`,
    "history",
    `<p class="eyebrow">the DNA at <span class="mono">${e(rev.hash.slice(0, 7))}</span></p>
<h1>${e(rev.subject)}</h1>
<p class="muted">${e(when(rev.date))} · ${timeTag(rev.date, c.now)}</p>${nav}
<h2>From this version to today's DNA</h2>
<p class="small muted">${stats.added || stats.removed ? `+${stats.added} −${stats.removed} lines since this commit (green = in today's DNA, red = only in this version).` : "Identical to today's DNA."}</p>
${stats.added || stats.removed ? renderDnaDiff(then, current) : ""}
<details><summary>Read this version in full</summary><article class="md">${renderMarkdown(fm.body).html}</article></details>`,
    c,
  );
}

// ── Models ───────────────────────────────────────────────────────────────────

function catalogLine(cat: ModelsState["catalog"], now: Date, refreshHref: string): string {
  const src =
    cat.source === "live"
      ? `OpenRouter catalogue: ${num(cat.count)} models, fetched ${timeTag(cat.fetchedAt, now)}`
      : cat.source === "cache"
        ? `${pill("warn", "offline")} using the cached catalogue from ${e(when(cat.fetchedAt))} (${num(cat.count)} models)`
        : `${pill("warn", "catalogue unavailable")} ${e(cat.error ?? "")}`;
  return `<p class="small muted">${src} · <a href="${e(refreshHref)}">refresh</a></p>`;
}

function callShape(u: ModelUse): string {
  const parts = [`temperature ${u.call.temperature}`];
  if (u.call.tools) parts.push(`tools${u.call.maxTurns ? ` · ≤ ${u.call.maxTurns} turns` : ""}`);
  if (u.call.json) parts.push("JSON mode");
  parts.push(u.call.maxTokens ? `max_tokens ${num(u.call.maxTokens)}` : "max_tokens: provider default");
  return parts.map((p) => `<span class="tag">${e(p)}</span>`).join(" ");
}

function facts(m: OpenRouterModel | undefined): string {
  if (!m) return `<p class="small muted">Not in the catalogue.</p>`;
  const rows: [string, string][] = [
    ["context", m.context_length ? `${tok(m.context_length)} tokens` : "—"],
    ["max output", m.top_provider?.max_completion_tokens ? `${tok(m.top_provider.max_completion_tokens)} tokens` : "—"],
    ["price in / out", `${usd(perMillion(m.pricing?.prompt))} / ${usd(perMillion(m.pricing?.completion))} per 1M tokens`],
    ["modality", m.architecture?.modality ?? "—"],
    ["knowledge cutoff", m.knowledge_cutoff ?? "—"],
    ...(m.expiration_date ? ([["expires", m.expiration_date]] as [string, string][]) : []),
  ];
  return `<dl class="kv small">${rows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(v)}</dd>`).join("")}</dl>`;
}

function useAnchor(u: ModelUse): string {
  return `use-${u.role}${u.juror ? `-${u.juror.index}` : ""}`;
}

function useCard(v: UseView, summaries: UsageSummary[], now: Date): string {
  const u = v.use;
  const actual = summaries.filter((s) => s.model === u.model && u.purposes.includes(s.purpose as never));
  const calls = actual.reduce((s, x) => s + x.calls, 0);
  const runs = actual.reduce((s, x) => s + x.runs, 0);
  const cost = actual.reduce((s, x) => s + x.costUsd, 0);
  const last = actual.map((x) => x.lastAt).sort().at(-1);
  const anchor = useAnchor(u);
  return `<section class="card use" id="${anchor}">
<h3><span>${e(u.title)} ${u.enabled ? "" : `<span class="tag">disabled</span>`}</span><span class="small">${pill(worst(v.checks) === "info" ? "ok" : worst(v.checks), summaryOf(v.checks).text)}</span></h3>
<p>${modelLink(u.model)} <span class="tag">${e(vendorOf(u.model))}</span>${v.model?.name ? ` <span class="muted small">${e(v.model.name)}</span>` : ""}</p>
${u.inherited ? `<p class="small muted">${levelIcon("info")} ${e(u.inherited)}.</p>` : ""}
<p class="why">${e(u.why)}</p>
<div class="cols"><div><p class="eyebrow">When it runs</p><ul class="small">${u.triggers.map((t) => `<li>${e(t)}</li>`).join("")}</ul></div>
<div><p class="eyebrow">What it reads</p><ul class="small">${u.reads.map((t) => `<li>${e(t)}</li>`).join("")}</ul></div></div>
<p class="eyebrow" style="margin-top:.8rem">How it's called</p><p>${callShape(u)}</p>
<div class="cols"><div><p class="eyebrow">Catalogue</p>${facts(v.model)}</div>
<div><p class="eyebrow">Cost</p><dl class="kv small"><dt>one call ≈</dt><dd>${v.estCallUsd !== null ? `${usd(v.estCallUsd)} <span class="muted">(${tok(v.promptTokens)} in${u.role === "generator" ? ", first turn" : ""})</span>` : "—"}</dd>
<dt>recorded</dt><dd>${calls ? `${num(calls)} call${calls === 1 ? "" : "s"}${runs !== calls ? ` in ${num(runs)} run${runs === 1 ? "" : "s"}` : ""} · ${usd(cost)} · last ${timeTag(last, now)}` : `<span class="muted">nothing in the ledger yet</span>`}</dd>
${calls && runs ? `<dt>per run</dt><dd>${usd(cost / runs)}</dd>` : ""}</dl></div></div>
<p class="eyebrow" style="margin-top:.8rem">Fitness for this role</p>${checkList(v.checks)}
<p class="small muted">Called from ${u.code.map((x) => `<code>${e(x)}</code>`).join(", ")}</p>
</section>`;
}

function usageTable(summaries: UsageSummary[], now: Date): string {
  if (!summaries.length) return `<p class="muted">The ledger is empty. Every OpenRouter call made from now on is recorded here.</p>`;
  const rows = summaries
    .map((s) => `<tr><td>${modelLink(s.model)}</td><td class="nw"><i style="display:inline-block;width:.7rem;height:.7rem;border-radius:.15rem;background:${purposeColor(s.purpose)};margin-right:.35rem"></i>${e(s.purpose)}</td><td class="n">${num(s.calls)}</td><td class="n">${num(s.runs)}</td><td class="n">${s.errors ? `<span style="color:var(--fail)">${s.errors}</span>` : "0"}</td><td class="n">${tok(s.promptTokens)}</td><td class="n">${tok(s.completionTokens)}</td><td class="n">${usd(s.costUsd)}${s.estimatedCalls ? "*" : ""}</td><td class="n">${(s.avgMs / 1000).toFixed(1)} s</td><td class="small">${Object.entries(s.providers).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${e(p)} <span class="muted">${n}</span>`).join(", ") || "—"}</td><td class="small">${timeTag(s.lastAt, now)}</td></tr>`)
    .join("");
  const est = summaries.some((s) => s.estimatedCalls);
  return `<div class="scroll"><table class="t"><thead><tr><th>Model</th><th>Purpose</th><th class="n">Calls</th><th class="n">Runs</th><th class="n">Errors</th><th class="n">Tokens in</th><th class="n">Tokens out</th><th class="n">Cost</th><th class="n">Avg latency</th><th>Served by</th><th>Last</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted">A run is one agent-loop generation (many turns) or one jury sitting (one call per juror).${est ? " * includes calls whose cost OpenRouter didn't report, estimated from catalogue pricing." : ""}</p>`;
}

function jurorTable(jurors: JurorStat[], current: string[]): string {
  if (!jurors.length) return `<p class="muted">No verdicts on record yet.</p>`;
  const rows = jurors
    .map((j) => `<tr><td>${modelLink(j.model)}${current.includes(j.model) ? ` <span class="tag">on the panel</span>` : ` <span class="tag">retired</span>`}</td><td class="n">${j.graded}</td><td>${verdictMix(j.verdicts)}</td><td class="n">${pct(j.meanShare)}</td><td class="n">${j.panelSittings ? `${j.dissents} / ${j.panelSittings}` : "—"}</td><td class="n">${j.artistRuled ? `${pct(j.artistAgreed / j.artistRuled)} <span class="muted">(${j.artistAgreed}/${j.artistRuled})</span>` : "—"}</td><td class="small">${Object.entries(j.gateFails).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${e(g)} <span class="muted">×${n}</span>`).join(", ") || "—"}</td><td class="small mono">${e(j.firstId.slice(0, 10))} → ${e(j.lastId.slice(0, 10))}</td></tr>`)
    .join("");
  return `${VERDICT_LEGEND}<div class="scroll"><table class="t"><thead><tr><th>Juror</th><th class="n">Graded</th><th>Verdicts</th><th class="n">Mean score</th><th class="n">Dissents</th><th class="n">Agrees with you</th><th>Gates it fails</th><th>Active</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted"><strong>Dissents</strong>: panel sittings where this juror's pass/reject differed from the panel's. <strong>Agrees with you</strong>: of the works you ruled on at the gate (approved, or rejected after the jury passed them), how often its pass/reject matched your call — only works that reached you count, so a strict juror is judged on its passes.</p>`;
}

function rosterTable(roster: ModelsState["roster"], now: Date): string {
  if (!roster.length) return `<p class="muted">No committed history of <code>agent.config.json</code>.</p>`;
  const rows = roster
    .map((r) => `<tr class="changed"><td class="small">${e(r.date.slice(0, 10))}<br><span class="muted">${timeTag(r.date, now)}</span></td><td class="small">${e(r.subject)} <span class="mono muted">${e(r.hash.slice(0, 7))}</span></td><td class="${r.changed.includes("generator") ? "c" : ""}">${modelLink(r.roster.generator)}</td><td class="${r.changed.includes("jury") ? "c" : ""}">${r.roster.jury.map(modelLink).join("<br>")}</td><td class="${r.changed.includes("amend") ? "c" : ""}">${r.roster.amend ? modelLink(r.roster.amend) : `<span class="muted small">generator</span>`}</td></tr>`)
    .join("");
  return `<div class="scroll"><table class="t"><thead><tr><th>When</th><th>Commit</th><th>Generator</th><th>Jury</th><th>Amendments</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted">Each row is a commit where the model roster in <code>agent.config.json</code> changed; highlighted cells are what changed. Uncommitted edits aren't shown.</p>`;
}

export function renderModels(m: ModelsState, c: Chrome, cfg: Config): string {
  const jurors = m.uses.filter((u) => u.use.role === "jury");
  const gen = m.uses.find((u) => u.use.role === "generator")!;
  const amend = m.uses.find((u) => u.use.role === "amend")!;
  const row = (purpose: string, v: UseView, when: string, anchor: string): string =>
    `<tr><td><a href="#${anchor}">${e(purpose)}</a></td><td>${modelLink(v.use.model)}</td><td class="small">${e(when)}</td><td>${callShape(v.use)}</td><td>${levelIcon(worst(v.checks) === "info" ? "ok" : worst(v.checks), summaryOf(v.checks).text)}</td></tr>`;
  const matrix = `<div class="scroll"><table class="t"><thead><tr><th>Purpose</th><th>Model</th><th>When</th><th>Call</th><th></th></tr></thead><tbody>
${row("Generate a candidate", gen, "every wake attempt", useAnchor(gen.use))}
${row("Refine a candidate", gen, "when you click Refine", useAnchor(gen.use))}
${jurors.map((j) => row(j.use.juror ? `Grade — juror ${j.use.juror.index}/${j.use.juror.of}` : "Grade a candidate", j, "after every generation and refinement; orphan re-jury", useAnchor(j.use))).join("")}
${row(`Draft a DNA petition${amend.use.enabled ? "" : " (disabled)"}`, amend, `after a wake, at ≥ ${cfg.amendments.minSignals} signals`, useAnchor(amend.use))}
</tbody></table></div>
<p class="small muted">Also: before every wake the harness looks up the jury models' pricing on OpenRouter's public <code>/models</code> endpoint — that fails the wake fast if a juror id doesn't exist, and prices calls whose cost OpenRouter didn't report. All calls use one key.</p>`;

  const body = `<p class="eyebrow">OpenRouter</p><h1>Which model does what</h1>
<p class="lede">Every role is an OpenRouter model id in <code>agent.config.json</code> — one key, any vendor, swapped with a config edit. This page shows each role as the harness actually calls it, whether the model is fit for that, and what it has cost.</p>
${catalogLine(m.catalog, c.now, "/models?refresh=1")}
<section id="roles"><h2>Who does what</h2>${matrix}</section>
<section id="invariants"><h2>Invariants</h2>${checkList(m.invariants)}</section>
<section id="role-cards"><h2>Role by role</h2><div class="grid">${m.uses.map((v) => useCard(v, m.usage.summaries, c.now)).join("")}</div></section>
<section id="usage"><h2>What it has cost</h2>
<p class="lede">From the usage ledger (<code>${e(cfg.paths.usage)}</code>): one line per OpenRouter call, tagged with its purpose${m.usage.since ? `, since ${e(when(m.usage.since))}` : ""}.</p>
<h3>Spend per day, last 30 days</h3>${dailyChart(m.usage.daily, m.perDayFuse)}
<h3>By model and purpose</h3>${usageTable(m.usage.summaries, c.now)}
${m.usage.failures7d.length ? `<h3>Failed calls, last 7 days</h3><div class="scroll"><table class="t"><thead><tr><th>When</th><th>Model</th><th>Purpose</th><th>Error</th></tr></thead><tbody>${m.usage.failures7d.slice(-20).reverse().map((f) => `<tr><td class="small mono">${e(when(f.at))}</td><td>${modelLink(f.model)}</td><td>${e(f.purpose)}</td><td class="small">${e(f.error ?? "")}</td></tr>`).join("")}</tbody></table></div>` : ""}
</section>
<section id="jury-record"><h2>The jury's record</h2>
<p class="lede">Read back from every <code>jury.json</code>: how each juror model has actually judged, alone or on a panel.</p>
${jurorTable(m.jurors, jurors.map((j) => j.use.model))}</section>
<section id="roster"><h2>Roster history</h2>${rosterTable(m.roster, c.now)}</section>`;
  return shell("models", "models", body, c);
}

export function renderModelDetail(d: ModelDetailState, c: Chrome): string {
  const datalist = `<datalist id="model-ids">${d.ids.map((id) => `<option value="${e(id)}">`).join("")}</datalist>`;
  const form = `<form class="lookup" method="GET" action="/model"><input name="id" list="model-ids" value="${e(d.id)}" placeholder="vendor/model, e.g. google/gemini-2.5-flash" aria-label="OpenRouter model id" autocomplete="off" spellcheck="false"><button type="submit">Check fitness</button></form>${datalist}`;
  if (!d.id) {
    return shell(
      "model lookup",
      "models",
      `<p class="eyebrow">model lookup</p><h1>Is a model fit for a role?</h1>
<p class="lede">Look up any OpenRouter model to see its catalogue entry, the providers serving it, and how it would fare in each of the harness's roles as they're configured now — before you put it in <code>agent.config.json</code>.</p>${form}${catalogLine(d.catalog, c.now, "/model?refresh=1")}`,
      c,
    );
  }
  const m = d.model;
  const roles = d.roles.length
    ? `<div class="roles">${d.roles.map((u) => `<a class="tag" href="/models#${useAnchor(u)}">${e(u.title)}</a>`).join("")}</div>`
    : `<p class="small muted">Not used in any role right now.</p>`;
  const fitness = `<div class="grid">${d.fitness
    .map((f) => `<div class="card"><h3>${e(f.use.role === "generator" ? "As generator" : f.use.role === "jury" ? "As a juror" : "As amendment drafter")} <span class="small">${pill(worst(f.checks) === "info" ? "ok" : worst(f.checks), summaryOf(f.checks).text)}</span></h3>${checkList(f.checks)}</div>`)
    .join("")}</div>`;
  const ep = d.endpoints
    .map((x: Endpoint) => `<tr><td>${e(x.provider_name ?? "—")}${x.tag ? ` <span class="muted small mono">${e(x.tag)}</span>` : ""}</td><td>${e(x.quantization ?? "—")}</td><td class="n">${x.context_length ? tok(x.context_length) : "—"}</td><td class="n">${x.max_completion_tokens ? tok(x.max_completion_tokens) : "—"}</td><td class="n">${usd(perMillion(x.pricing?.prompt))}</td><td class="n">${usd(perMillion(x.pricing?.completion))}</td><td class="n">${typeof x.uptime_last_30m === "number" ? `${x.uptime_last_30m.toFixed(0)}%` : "—"}</td><td class="n">${typeof x.uptime_last_1d === "number" ? `${x.uptime_last_1d.toFixed(1)}%` : "—"}</td><td>${(x.supported_parameters ?? []).includes("tools") ? "✓" : "—"}</td><td>${(x.supported_parameters ?? []).includes("response_format") ? "✓" : "—"}</td></tr>`)
    .join("");
  const body = `<p class="eyebrow">model · <a href="/model">look up another</a></p>
<h1>${e(m?.name ?? d.id)}</h1>
<p>${modelLink(d.id)} <span class="tag">${e(vendorOf(d.id))}</span> · <a href="https://openrouter.ai/${e(d.id.replace(/:.*$/, ""))}" rel="noreferrer" target="_blank">openrouter.ai ↗</a></p>
${roles}
${m ? "" : `<div class="banner fail"><p><strong>${e(d.id)} is not in the OpenRouter catalogue.</strong> Check the id; retired models disappear from the listing.</p></div>`}
${form}
${m?.description ? `<p class="lede">${e(m.description)}</p>` : ""}
<div class="card"><h3>Catalogue</h3>${facts(m)}${m?.supported_parameters?.length ? `<p class="small muted">Parameters: ${m.supported_parameters.map((p) => `<code>${e(p)}</code>`).join(" ")}</p>` : ""}</div>
${d.usage.length ? `<h2>In your ledger</h2>${usageTable(d.usage, c.now)}` : ""}
${d.juror ? `<h2>As a juror, so far</h2>${jurorTable([d.juror], d.roles.filter((r) => r.role === "jury").map((r) => r.model))}` : ""}
<h2>Fitness by role</h2><p class="lede">Each role as it is configured now (temperature, max_tokens, tools, JSON mode, prompt size), with this model in it.</p>${fitness}
<h2>Providers</h2>${d.endpointsError ? `<p class="muted">${e(d.endpointsError)}</p>` : d.endpoints.length ? `<div class="scroll"><table class="t"><thead><tr><th>Provider</th><th>Quant.</th><th class="n">Context</th><th class="n">Max out</th><th class="n">$/M in</th><th class="n">$/M out</th><th class="n">Up 30 m</th><th class="n">Up 1 d</th><th>Tools</th><th>JSON</th></tr></thead><tbody>${ep}</tbody></table></div><p class="small muted">OpenRouter routes each call to one of these; the ledger records which one served it.</p>` : `<p class="muted">No providers listed.</p>`}`;
  return shell(d.id, "models", body, c);
}

// ── Prompts ──────────────────────────────────────────────────────────────────

export function renderPrompts(p: PromptsState, catalog: Catalog, c: Chrome): string {
  const banner =
    p.dnaSource !== "dna"
      ? `<div class="banner"><p><strong>There is no DNA yet</strong> — these prompts are assembled with the template in its place, to show the shape.</p></div>`
      : "";
  const cards = p.previews
    .map((pv) => {
      const fits = pv.models
        .map((id) => {
          const m = catalog.models.find((x) => x.id === id);
          const ctx = m?.context_length;
          const inUsd = m ? Number(m.pricing?.prompt) * pv.tokens : NaN;
          return `<li>${modelLink(id)} — ${ctx ? `${((pv.tokens / ctx) * 100).toFixed(pv.tokens / ctx < 0.01 ? 2 : 1)}% of ${tok(ctx)} context` : "context unknown"}${Number.isFinite(inUsd) ? ` · input ≈ ${usd(inUsd)}` : ""}</li>`;
        })
        .join("");
      return `<section class="card" id="prompt-${pv.key}"><h3><span>${e(pv.title)}</span><span class="tag">≈ ${tok(pv.tokens)} tokens in</span></h3>
<ul class="small">${fits}</ul>
<p class="small muted">${e(pv.note)}</p>
<details><summary>System prompt <span class="muted small">(${tok(Math.ceil(pv.system.length / 4))} tokens)</span></summary><pre>${e(pv.system)}</pre></details>
<details><summary>Task <span class="muted small">(${tok(Math.ceil(pv.user.length / 4))} tokens)</span></summary><pre>${e(pv.user)}</pre></details>
${pv.tools ? `<details><summary>Tools <span class="muted small">(${tok(Math.ceil(pv.tools.length / 4))} tokens, sent every turn)</span></summary><pre>${e(pv.tools)}</pre></details>` : ""}
</section>`;
    })
    .join("");
  return shell(
    "prompts",
    "prompts",
    `<p class="eyebrow">what each model is told</p><h1>Prompts</h1>
<p class="lede">Assembled live by the harness's own prompt builders from today's DNA, catalogue, guidance and config — exactly what the next call would send, with the candidate and your feedback as placeholders. Token counts are estimates (≈ 4 characters per token).</p>
${banner}${cards}`,
    c,
  );
}

// ── Config ───────────────────────────────────────────────────────────────────

/** Dotted paths present in `effective` but absent from `raw` — filled in by defaults. */
export function defaultedKeys(raw: unknown, effective: unknown, prefix = ""): string[] {
  if (!effective || typeof effective !== "object" || Array.isArray(effective)) return [];
  const out: string[] = [];
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(effective as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in r)) out.push(path);
    else out.push(...defaultedKeys(r[k], v, path));
  }
  return out;
}

export function renderConfig(cfg: Config, raw: string | null, env: EnvState, c: Chrome): string {
  const { abs, ...effective } = cfg;
  let parsedRaw: unknown = null;
  try {
    parsedRaw = raw ? JSON.parse(raw) : null;
  } catch {
    parsedRaw = null;
  }
  const defaulted = parsedRaw ? defaultedKeys(parsedRaw, effective) : [];
  const ki = env.keyInfo?.info;
  const envRows: [string, string][] = [
    ["OPENROUTER_API_KEY", env.key ? `<code>${e(env.key)}</code>` : `${levelIcon("fail")} not set`],
    ...(ki
      ? ([
          ...(ki.label && !isMaskedKeyLabel(ki.label) ? ([["key label", e(ki.label)]] as [string, string][]) : []),
          ["usage (all time)", usd(ki.usage ?? null)],
          ["usage today / week / month", `${usd(ki.usage_daily ?? null)} / ${usd(ki.usage_weekly ?? null)} / ${usd(ki.usage_monthly ?? null)}`],
          ["credit limit", ki.limit != null ? `${usd(ki.limit)} (${usd(ki.limit_remaining ?? null)} left)` : "none"],
          ["free tier", ki.is_free_tier ? "yes" : "no"],
        ] as [string, string][])
      : env.keyInfo?.error
        ? ([["key check", `<span class="muted">${e(env.keyInfo.error)}</span>`]] as [string, string][])
        : []),
    ["SMTP", env.smtp === "configured" ? "configured" : env.smtp === "absent" ? "not configured — notifications go to the console" : `${levelIcon("fail")} ${e(env.smtp)}`],
    ["email.to", env.emailTo ? e(env.emailTo) : `<span class="muted">—</span>`],
    ["git", env.push ? `commits and pushes to ${e(env.remote)}` : `commits locally; push is off (${e(env.remote)})`],
    ...Object.entries(env.switches).map(([k, v]) => [k, `<code>${e(v)}</code>`] as [string, string]),
  ];
  const pathRows = Object.entries(cfg.paths)
    .map(([k, v]) => {
      const p = (abs as Record<string, string>)[k];
      const exists = p ? existsSync(p) : false;
      return `<tr><td class="mono">${e(k)}</td><td class="mono">${e(v)}</td><td>${exists ? levelIcon("ok", "exists") : `<span class="muted small">absent</span>`}</td></tr>`;
    })
    .join("");
  const libs = env.libraries.length
    ? `<table class="t"><thead><tr><th>Name</th><th>File</th><th class="n">Size</th><th>State</th></tr></thead><tbody>${env.libraries.map((l) => `<tr><td class="mono">${e(l.name)}</td><td class="mono">${e(l.file)}</td><td class="n">${l.exists ? `${Math.round(l.bytes / 1024)} KB` : "—"}</td><td>${!l.exists ? pill("fail", "missing") : !l.inlineSafe ? pill("fail", "contains </script>") : pill("ok", "ready")}</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">None declared. Browser APIs in bounds: ${cfg.technologies.apis.map((x) => `<code>${e(x)}</code>`).join(" ")}</p>`;
  return shell(
    "config",
    "config",
    `<p class="eyebrow">agent.config.json + environment</p><h1>Configuration</h1>
<p class="lede">The configuration as the harness sees it after validation and defaults. Edit <code>agent.config.json</code> and reload — this console re-reads it on every request (the daemon reads it once, at start-up).</p>
<section id="env"><h2>Environment</h2><dl class="kv">${envRows.map(([k, v]) => `<dt>${e(k)}</dt><dd>${v}</dd>`).join("")}</dl></section>
<section id="libraries"><h2>Vendored libraries</h2>${libs}</section>
<section id="paths"><h2>Paths</h2><div class="scroll"><table class="t"><thead><tr><th>Key</th><th>Configured</th><th>On disk</th></tr></thead><tbody>${pathRows}</tbody></table></div></section>
<section id="effective"><h2>Effective configuration</h2>
${defaulted.length ? `<p class="small muted">Filled in from defaults (not in the file): ${defaulted.map((k) => `<code>${e(k)}</code>`).join(" ")}</p>` : ""}
<pre>${e(JSON.stringify(effective, null, 2))}</pre></section>
<section id="raw"><h2>The file</h2>${raw === null ? `<p class="muted">Not readable.</p>` : `<pre>${e(raw)}</pre>`}</section>`,
    c,
  );
}
