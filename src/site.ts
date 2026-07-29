import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { GeneratedMeta } from "./generator.ts";
import { escapeHtml } from "./dashboard.ts";

export interface PublishedWork {
  id: string;
  meta: GeneratedMeta;
}

export interface SiteText {
  title: string;
  lede: string;
  footer: string;
}

const DEFAULT_SITE: SiteText = { title: "machine works", lede: "", footer: "" };

// Per-work files copied into the public site. jury.json (the private jury
// verdict) is deliberately omitted so it never ships to visitors.
const PUBLIC_FILES = ["index.html", "motivation.md", "meta.json"];

/** Read published works (newest first), skipping any malformed dirs. */
export function listPublished(publishedRoot: string): PublishedWork[] {
  if (!existsSync(publishedRoot)) return [];
  const works: PublishedWork[] = [];
  for (const e of readdirSync(publishedRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(
        readFileSync(join(publishedRoot, e.name, "meta.json"), "utf8"),
      ) as GeneratedMeta;
      works.push({ id: e.name, meta });
    } catch {
      // skip
    }
  }
  return works.sort((a, b) => b.id.localeCompare(a.id));
}

/** The living catalogue page. Self-contained; text comes from config `site`. */
export function renderCatalogueIndex(works: PublishedWork[], site: SiteText = DEFAULT_SITE): string {
  const items =
    works.length === 0
      ? `<p class="muted">The catalogue is empty — for now.</p>`
      : works
          .map((w) => {
            const year = w.id.slice(0, 4);
            return `<li>
    <a href="/${encodeURIComponent(w.id)}/">${escapeHtml(w.meta.title)}</a>
    <span class="year">${escapeHtml(year)}</span>
    <span class="ref">${escapeHtml(w.meta.references.join("; "))}</span>
    <div class="summary">${escapeHtml(w.meta.summary)}</div>
  </li>`;
          })
          .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(site.title)}</title>
<style>
  :root{--ink:#1a1a1a;--muted:#6b6b6b;--accent:#002fa7;--paper:#f4f1e9;--line:#e3e0d8}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 Georgia,serif}
  main{max-width:46rem;margin:0 auto;padding:3rem 1.5rem 5rem}
  h1{font-weight:400;font-size:1.6rem;margin:0 0 .2rem}
  .lede{color:var(--muted);margin:0 0 2.5rem}
  .muted{color:var(--muted)}
  ul{list-style:none;margin:0;padding:0}
  li{padding:1.1rem 0;border-top:1px solid var(--line)}
  li a{color:var(--accent);text-decoration:none;font-size:1.15rem}
  .year{color:var(--muted);font:13px/1 monospace;margin-left:.5rem}
  .ref{display:block;color:var(--muted);font-size:.85rem;margin-top:.15rem}
  .summary{margin-top:.35rem}
  footer{margin-top:3rem;color:var(--muted);font-size:.8rem;border-top:1px solid var(--line);padding-top:1rem}
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(site.title)}</h1>
  ${site.lede ? `<p class="lede">${escapeHtml(site.lede)}</p>` : ""}
  <ul>
${items}
  </ul>
  ${site.footer ? `<footer>${escapeHtml(site.footer)}</footer>` : ""}
</main>
</body>
</html>
`;
}

/**
 * Assemble the public site into `outDir`: each published work's PUBLIC_FILES
 * (never jury.json) plus the catalogue index. The output dir is rebuilt fresh.
 * `inject` finalizes each work's index.html (vendored-library splicing) so the
 * published file is complete and self-contained on its own.
 */
export function buildSite(
  publishedRoot: string,
  outDir: string,
  site: SiteText = DEFAULT_SITE,
  inject: (html: string) => string = (html) => html,
): { count: number } {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const works = listPublished(publishedRoot);
  for (const w of works) {
    const dest = join(outDir, w.id);
    mkdirSync(dest, { recursive: true });
    for (const f of PUBLIC_FILES) {
      const src = join(publishedRoot, w.id, f);
      if (!existsSync(src)) continue;
      if (f === "index.html") {
        writeFileSync(join(dest, f), inject(readFileSync(src, "utf8")), "utf8");
      } else {
        copyFileSync(src, join(dest, f));
      }
    }
  }
  writeFileSync(join(outDir, "index.html"), renderCatalogueIndex(works, site), "utf8");
  return { count: works.length };
}

// CLI: `npm run build:site`
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const { makeInjector } = await import("./vendor.ts");
  const outDir = join(cfg.abs.root, "dist-site");
  const { count } = buildSite(cfg.abs.published, outDir, cfg.site, makeInjector(cfg));
  console.log(`Built site: ${count} work(s) → ${outDir} (jury.json excluded)`);
}
