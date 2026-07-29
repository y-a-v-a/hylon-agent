import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.ts";

// Vendored libraries (Three.js-class dependencies) without breaking the
// zero-external-requests invariant. The operator pins a library file into the
// repo (e.g. vendor/three.min.js) and declares it in agent.config.json under
// technologies.libraries. The GENERATOR writes only a placeholder:
//
//   <script data-vendor="threejs"></script>
//
// The stored work keeps the placeholder (small, reviewable, jury-friendly);
// the harness splices in the real library source at RENDER/BUILD time — the
// dashboard's /work response and the public-site build. The published file is
// therefore still one self-contained page making zero external requests.

const PLACEHOLDER_RE = /<script\s+data-vendor=["']([A-Za-z0-9_-]+)["']\s*>\s*<\/script>/g;

/** Vendored-library names referenced by the html, in order, deduplicated. */
export function findVendorPlaceholders(html: string): string[] {
  const names: string[] = [];
  for (const m of html.matchAll(PLACEHOLDER_RE)) {
    if (!names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

/** Violations for placeholders that name a library the config does not declare. */
export function validateVendorPlaceholders(html: string, declared: string[]): string[] {
  return findVendorPlaceholders(html)
    .filter((n) => !declared.includes(n))
    .map((n) => `undeclared vendored library: ${n}`);
}

/** Replace declared placeholders with inline library source (pure, testable). */
export function injectVendorLibraries(html: string, sources: Record<string, string>): string {
  return html.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const src = sources[name];
    if (src === undefined) return whole; // undeclared → left as-is (flagged upstream)
    return `<script>\n/* ${name} — vendored library, injected by the harness */\n${src}\n</script>`;
  });
}

function loadLibrarySource(root: string, name: string, file: string): string {
  const p = resolve(root, file);
  if (!existsSync(p)) {
    throw new Error(
      `Vendored library "${name}" is declared in agent.config.json but ${file} does not exist. ` +
        `Pin the file into the repo (see vendor/README.md).`,
    );
  }
  const src = readFileSync(p, "utf8");
  if (/<\/script/i.test(src)) {
    throw new Error(
      `Vendored library "${name}" (${file}) contains "</script>" and cannot be inlined safely. ` +
        `Use a build of the library that does not embed that sequence.`,
    );
  }
  return src;
}

/**
 * Fail fast (before spending on generation) if a declared library file is
 * missing or not inline-safe.
 */
export function ensureVendorFiles(cfg: Config): void {
  const libraries = cfg.technologies?.libraries ?? {};
  for (const [name, file] of Object.entries(libraries)) {
    loadLibrarySource(cfg.abs.root, name, file);
  }
}

/**
 * An html→html injector bound to the config's declared libraries, with the
 * sources cached after first read. Identity for pages without placeholders.
 */
export function makeInjector(cfg: Config): (html: string) => string {
  const libraries = cfg.technologies?.libraries ?? {};
  const cache = new Map<string, string>();
  return (html: string): string => {
    const wanted = findVendorPlaceholders(html).filter((n) => n in libraries);
    if (wanted.length === 0) return html;
    const sources: Record<string, string> = {};
    for (const name of wanted) {
      if (!cache.has(name)) cache.set(name, loadLibrarySource(cfg.abs.root, name, libraries[name]!));
      sources[name] = cache.get(name)!;
    }
    return injectVendorLibraries(html, sources);
  };
}
