import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const ROOT = join(HERE, "fx", "root");
const tmp = mkdtempSync(join(tmpdir(), "amnesia-card-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("card renders an HTML receipt with stats and dropped prompts", () => {
  const outFile = join(tmp, "card.html");
  const out = run([
    "card",
    "aaaaaaaa-0000-0000-0000-000000000001",
    "--root",
    ROOT,
    "--out",
    outFile,
  ]);
  assert.ok(out.includes("card written"));
  assert.ok(existsSync(outFile));
  const html = readFileSync(outFile, "utf8");
  assert.ok(html.includes("120,000"));
  assert.ok(html.includes("8,000"));
  assert.ok(html.includes("93.3% of context dropped"));
  assert.ok(html.includes("1m 35s"));
  assert.ok(html.includes("112,000 forgotten this session"));
  assert.ok(html.includes("auth bug"));
  assert.ok(html.includes("npx amnesia-cli"));
});

test("card on a clean session reports nothing to show", () => {
  const out = run([
    "card",
    "bbbbbbbb-0000-0000-0000-000000000001",
    "--root",
    ROOT,
  ]);
  assert.ok(out.includes("no compaction"));
});
