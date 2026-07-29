import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCatalogueIndex, buildSite, type PublishedWork } from "./site.ts";

const work: PublishedWork = {
  id: "2026-06-16-the-original",
  meta: {
    title: "The <Original>",
    summary: "A & B",
    mechanism: "blob",
    principles: ["P1"],
    references: ["Benjamin"],
    license: "CC BY-SA 4.0",
  },
};

const SITE = { title: "my machine works", lede: "the lede line", footer: "the footer line" };

test("renderCatalogueIndex lists works with escaped titles and links", () => {
  const html = renderCatalogueIndex([work], SITE);
  assert.match(html, /href="\/2026-06-16-the-original\/"/);
  assert.match(html, /The &lt;Original&gt;/);
});

test("renderCatalogueIndex uses the configured site text", () => {
  const html = renderCatalogueIndex([work], SITE);
  assert.match(html, /<title>my machine works<\/title>/);
  assert.match(html, /the lede line/);
  assert.match(html, /the footer line/);
});

test("renderCatalogueIndex omits empty lede/footer", () => {
  const html = renderCatalogueIndex([work], { title: "t", lede: "", footer: "" });
  assert.doesNotMatch(html, /<p class="lede">/);
  assert.doesNotMatch(html, /<footer>/);
});

test("renderCatalogueIndex handles an empty catalogue", () => {
  assert.match(renderCatalogueIndex([]), /catalogue is empty/);
});

test("buildSite finalizes each work's index.html through the injector", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-site-inject-"));
  try {
    const pub = join(root, "published");
    const out = join(root, "out");
    const wdir = join(pub, "2026-06-16-the-original");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(join(wdir, "index.html"), `<script data-vendor="threejs"></script>`);
    writeFileSync(join(wdir, "motivation.md"), "why");
    writeFileSync(join(wdir, "meta.json"), JSON.stringify(work.meta));

    buildSite(pub, out, SITE, (html) => html.replace(/<script data-vendor="threejs"><\/script>/, "<script>var THREE={}</script>"));

    const published = readFileSync(join(out, "2026-06-16-the-original", "index.html"), "utf8");
    assert.match(published, /var THREE=\{\}/);
    assert.doesNotMatch(published, /data-vendor/);
    // the stored source keeps its placeholder — injection is a build step
    assert.match(readFileSync(join(wdir, "index.html"), "utf8"), /data-vendor="threejs"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildSite copies index.html + motivation.md + meta.json but NEVER jury.json", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-site-"));
  try {
    const pub = join(root, "published");
    const out = join(root, "out");
    const wdir = join(pub, "2026-06-16-the-original");
    mkdirSync(wdir, { recursive: true });
    writeFileSync(join(wdir, "index.html"), "<h1>work</h1>");
    writeFileSync(join(wdir, "motivation.md"), "why");
    writeFileSync(join(wdir, "meta.json"), JSON.stringify(work.meta));
    writeFileSync(join(wdir, "jury.json"), JSON.stringify({ secret: "verdict" }));

    const { count } = buildSite(pub, out, SITE);
    assert.equal(count, 1);

    const od = join(out, "2026-06-16-the-original");
    assert.ok(existsSync(join(od, "index.html")), "work index.html present");
    assert.ok(existsSync(join(od, "motivation.md")), "motivation.md present");
    assert.ok(existsSync(join(od, "meta.json")), "meta.json present");
    assert.ok(!existsSync(join(od, "jury.json")), "jury.json MUST NOT be published");
    assert.ok(existsSync(join(out, "index.html")), "catalogue index present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
