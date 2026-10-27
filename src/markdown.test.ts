import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, renderInline, renderMarkdown } from "./markdown.ts";

test("parseFrontmatter reads quoted values, inline lists, and dash lists", () => {
  const fm = parseFrontmatter(
    '---\ntitle: "Artistic DNA — X"\nversion: 0.3\naliases: [a, "b c"]\ntags:\n  - one\n  - two\n---\n# Body\n',
  );
  assert.equal(fm.data.title, "Artistic DNA — X");
  assert.equal(fm.data.version, "0.3");
  assert.deepEqual(fm.data.aliases, ["a", "b c"]);
  assert.deepEqual(fm.data.tags, ["one", "two"]);
  assert.equal(fm.body, "# Body\n");
  assert.equal(fm.bodyLine, 9);
});

test("parseFrontmatter passes a document without frontmatter through", () => {
  const fm = parseFrontmatter("# Just a doc\n");
  assert.deepEqual(fm.data, {});
  assert.equal(fm.body, "# Just a doc\n");
  assert.equal(fm.bodyLine, 1);
});

test("renderInline escapes html and formats emphasis, code, links", () => {
  assert.equal(renderInline("<b> & **bold** *it*"), "&lt;b&gt; &amp; <strong>bold</strong> <em>it</em>");
  assert.equal(renderInline("`a <b> **c**`"), "<code>a &lt;b&gt; **c**</code>");
  assert.equal(
    renderInline("[the doc](https://ex.com/a_b_c)"),
    '<a href="https://ex.com/a_b_c" rel="noreferrer" target="_blank">the doc</a>',
  );
  assert.equal(renderInline("*across\nlines*"), "<em>across\nlines</em>");
  assert.equal(renderInline("snake_case_word stays"), "snake_case_word stays");
});

test("renderInline drops unsafe link schemes but keeps the label", () => {
  assert.equal(renderInline("[x](javascript:alert(1))"), "x");
  assert.doesNotMatch(renderInline("[x](data:text/html,hi)"), /href/);
  assert.match(renderInline("[sec](#principles)"), /href="#principles"/);
});

test("renderMarkdown builds headings with unique ids and a table of contents", () => {
  const r = renderMarkdown("# Title\n\n## 3. Core principles\n\n## Notes\n\n## Notes\n\n> ## not in toc\n");
  assert.deepEqual(
    r.headings.map((h) => [h.level, h.id]),
    [
      [1, "title"],
      [2, "3-core-principles"],
      [2, "notes"],
      [2, "notes-2"],
    ],
  );
  assert.match(r.html, /<h2 id="3-core-principles">3\. Core principles<\/h2>/);
  assert.match(r.html, /<blockquote><h2 id="not-in-toc">/);
});

test("renderMarkdown: tight lists, lazy continuation, nesting, ordered start", () => {
  const r = renderMarkdown(
    "- **P1 — Name.** first line\n  continues here\n- P2\n  - nested\n\n3. three\n4. four\n",
  );
  assert.match(r.html, /<ul>\n<li><strong>P1 — Name\.<\/strong> first line\ncontinues here<\/li>/);
  assert.match(r.html, /<li>P2\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>/);
  assert.match(r.html, /<ol start="3">\n<li>three<\/li>\n<li>four<\/li>\n<\/ol>/);
});

test("renderMarkdown: loose lists keep paragraphs", () => {
  const r = renderMarkdown("- one\n\n- two\n");
  assert.match(r.html, /<li><p>one<\/p><\/li>/);
});

test("renderMarkdown: fences are escaped and never formatted", () => {
  const r = renderMarkdown('```json\n[{ "a": "<b>**x**</b>" }]\n```\n');
  assert.equal(r.html, '<pre><code class="lang-json">[{ &quot;a&quot;: &quot;&lt;b&gt;**x**&lt;/b&gt;&quot; }]</code></pre>');
});

test("renderMarkdown: tables with alignment, hr, paragraphs", () => {
  const r = renderMarkdown("| Key | Weight |\n|---|--:|\n| novelty | ×3 |\n\n---\n\npara one\npara two\n");
  assert.match(r.html, /<th>Key<\/th><th style="text-align:right">Weight<\/th>/);
  assert.match(r.html, /<td>novelty<\/td><td style="text-align:right">×3<\/td>/);
  assert.match(r.html, /<hr>/);
  assert.match(r.html, /<p>para one\npara two<\/p>/);
});

test("renderMarkdown: a hard-wrapped line starting with a year stays prose", () => {
  const r = renderMarkdown("The net art of the late\n1994. was a year of browsers.\n\n- item that wraps\n1994. continues it\n");
  assert.match(r.html, /<p>The net art of the late\n1994\. was a year of browsers\.<\/p>/);
  assert.match(r.html, /<li>item that wraps\n1994\. continues it<\/li>/);
  assert.doesNotMatch(r.html, /start="1994"/);
  assert.match(renderMarkdown("para\n1. a list may interrupt at 1\n").html, /<ol>\n<li>a list may interrupt at 1/);
});

test("renderMarkdown: backslash escapes, setext headings, comments, tables after a paragraph", () => {
  assert.equal(renderInline("\\*literal\\* and \\_this\\_"), "*literal* and _this_");
  const r = renderMarkdown("Title\n=====\n\nSub\n---\n\n<!-- a note\nspanning lines -->\nkept\n\nIntro:\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<!-- in code -->\n```\n");
  assert.deepEqual(r.headings.map((h) => [h.level, h.text]), [[1, "Title"], [2, "Sub"]]);
  assert.doesNotMatch(r.html, /a note|<hr>/);
  assert.match(r.html, /<p>kept<\/p>/);
  assert.match(r.html, /<p>Intro:<\/p>\n<table>/);
  assert.match(r.html, /&lt;!-- in code --&gt;/, "comments inside fences are code");
});
