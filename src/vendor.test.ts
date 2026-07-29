import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findVendorPlaceholders,
  validateVendorPlaceholders,
  injectVendorLibraries,
} from "./vendor.ts";

const PAGE = `<!doctype html><html><head>
<script data-vendor="threejs"></script>
<script data-vendor='tone'></script>
</head><body>
<script data-vendor="threejs"></script>
<script>init()</script>
</body></html>`;

test("findVendorPlaceholders finds names, deduplicated, both quote styles", () => {
  assert.deepEqual(findVendorPlaceholders(PAGE), ["threejs", "tone"]);
});

test("findVendorPlaceholders ignores ordinary and src scripts", () => {
  const html = `<script>x()</script><script src="data:text/javascript,"></script>`;
  assert.deepEqual(findVendorPlaceholders(html), []);
});

test("findVendorPlaceholders ignores a non-empty data-vendor script", () => {
  // Content inside the tag means it is not a pure placeholder — do not touch it.
  assert.deepEqual(findVendorPlaceholders(`<script data-vendor="x">evil()</script>`), []);
});

test("validateVendorPlaceholders flags only undeclared names", () => {
  assert.deepEqual(validateVendorPlaceholders(PAGE, ["threejs", "tone"]), []);
  assert.deepEqual(validateVendorPlaceholders(PAGE, ["threejs"]), [
    "undeclared vendored library: tone",
  ]);
});

test("injectVendorLibraries replaces every declared placeholder with inline source", () => {
  const out = injectVendorLibraries(PAGE, { threejs: "var THREE = {};", tone: "var Tone = {};" });
  assert.doesNotMatch(out, /data-vendor/);
  assert.equal(out.match(/var THREE = \{\};/g)?.length, 2); // both occurrences
  assert.match(out, /var Tone = \{\};/);
  assert.match(out, /vendored library, injected by the harness/);
  assert.match(out, /<script>init\(\)<\/script>/); // ordinary scripts untouched
});

test("injectVendorLibraries leaves undeclared placeholders as-is", () => {
  const out = injectVendorLibraries(PAGE, { threejs: "var THREE = {};" });
  assert.match(out, /<script data-vendor='tone'><\/script>/);
});
