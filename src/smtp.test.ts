import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeHeaderWord, wrapBase64, buildMessage } from "./smtp.ts";

test("encodeHeaderWord passes through pure ASCII", () => {
  assert.equal(encodeHeaderWord("Plain Subject"), "Plain Subject");
});

test("encodeHeaderWord RFC2047-encodes non-ASCII (·, —)", () => {
  const enc = encodeHeaderWord("agent · strong — The Original");
  assert.match(enc, /^=\?UTF-8\?B\?.+\?=$/);
  // round-trips back to the original
  const b64 = enc.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "");
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "agent · strong — The Original");
});

test("wrapBase64 wraps at 76 columns with CRLF", () => {
  const wrapped = wrapBase64("a".repeat(200));
  const lines = wrapped.split("\r\n");
  assert.equal(lines[0]!.length, 76);
  assert.equal(lines.length, 3); // 76 + 76 + 48
});

test("buildMessage has required headers, base64 body, blank-line separator", () => {
  const msg = buildMessage(
    { from: "agent@example.com", to: "artist@example.com", subject: "Hi", body: "Hello, world" },
    new Date("2026-06-16T14:01:44Z"),
  );
  assert.match(msg, /^From: agent@example\.com\r\n/);
  assert.match(msg, /\r\nTo: artist@example\.com\r\n/);
  assert.match(msg, /\r\nContent-Transfer-Encoding: base64\r\n/);
  assert.match(msg, /Date: .+\+0000\r\n/);
  assert.match(msg, /\r\n\r\n/); // header/body separator
  const body = msg.split("\r\n\r\n")[1]!.trim();
  assert.equal(Buffer.from(body, "base64").toString("utf8"), "Hello, world");
});
