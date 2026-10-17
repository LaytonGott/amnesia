import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeProjectPath } from "../src/claude.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const ROOT = join(HERE, "fixtures", "root");
const tmp = mkdtempSync(join(tmpdir(), "amnesia-test-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("scan lists compacted sessions with totals", () => {
  const out = run(["--root", ROOT]);
  assert.ok(out.includes("6 sessions"));
  assert.ok(out.includes("4 with compaction"));
  assert.ok(out.includes("465,000"));
});

test("receipt follows a resume copy to its origin session", () => {
  const out = run(["aaaaaaaa-0000-0000-0000-000000000002", "--root", ROOT]);
  assert.ok(out.includes("origin"));
  assert.ok(out.includes("93.3%"));
});

test("receipt shows no compaction for a clean session", () => {
  const out = run(["bbbbbbbb-0000-0000-0000-000000000001", "--root", ROOT]);
  assert.ok(out.includes("no compaction events"));
});

test("restore writes a recoverable markdown file", () => {
  const outFile = join(tmp, "restored.md");
  const out = run([
    "restore",
    "aaaaaaaa-0000-0000-0000-000000000001",
    "--root",
    ROOT,
    "--out",
    outFile,
  ]);
  assert.ok(out.includes("recovered context written to"));
  const md = readFileSync(outFile, "utf8");
  assert.ok(md.includes("help me fix the auth bug in server.js"));
  assert.ok(md.includes("## How to use this file"));
  assert.ok(md.includes("this is context you lost to compaction"));
});

test("protect dry-run lists constraints without writing", () => {
  const target = join(tmp, "CLAUDE-dry.md");
  const out = run([
    "protect",
    "--project",
    "projC",
    "--root",
    ROOT,
    "--out",
    target,
  ]);
  assert.ok(out.includes("Never import the lobby module"));
  assert.ok(out.includes("dry run"));
  assert.ok(out.includes("absent from their replacement summaries"));
  assert.equal(existsSync(target), false);
});

test("protect --write updates the marked section idempotently", () => {
  const target = join(tmp, "CLAUDE.md");
  const args = [
    "protect",
    "--project",
    "projC",
    "--root",
    ROOT,
    "--write",
    "--out",
    target,
  ];
  run(args);
  run(args);
  const md = readFileSync(target, "utf8");
  assert.equal(md.split("amnesia:constraints:start").length - 1, 1);
  assert.equal(md.split("amnesia:constraints:end").length - 1, 1);
  assert.ok(md.includes("Keep them separate."));
});

test("--json emits valid machine-readable output", () => {
  const out = run([
    "--json",
    "aaaaaaaa-0000-0000-0000-000000000001",
    "--root",
    ROOT,
  ]);
  const j = JSON.parse(out);
  assert.equal(j.boundaries.length, 1);
  assert.equal(j.boundaries[0].preTokens, 120000);
  assert.equal(j.boundaries[0].originSession, null);
});

test("unknown session id fails with a nonzero exit", () => {
  assert.throws(() => run(["zzzzzzzz", "--root", ROOT]));
});

test("version prints the package version", () => {
  const out = run(["--version"]);
  const pkg = JSON.parse(
    readFileSync(join(HERE, "..", "package.json"), "utf8")
  );
  assert.ok(out.includes(pkg.version));
});

test("receipt labels precomputed compactions and UTC times", () => {
  const out = run([
    "eeeeeeee-0000-0000-0000-000000000001",
    "--root",
    ROOT,
  ]);
  assert.ok(out.includes("(precomputed)"));
  assert.ok(out.includes(" UTC "));
});

test("restore defaults into the amnesia store, not the project", () => {
  const store = join(tmp, "store");
  const out = execFileSync(
    process.execPath,
    [BIN, "restore", "aaaaaaaa-0000-0000-0000-000000000001", "--root", ROOT],
    { encoding: "utf8", env: { ...process.env, AMNESIA_HOME: store } }
  );
  assert.ok(out.includes("recovered context written to"));
  const dir = join(store, encodeProjectPath(process.cwd()));
  const files = readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith("restored-aaaaaaaa")));
});

test("home command shows the store locations", () => {
  const store = join(tmp, "store2");
  const out = execFileSync(process.execPath, [BIN, "home"], {
    encoding: "utf8",
    env: { ...process.env, AMNESIA_HOME: store },
  });
  assert.ok(out.includes(store));
  assert.ok(out.includes(encodeProjectPath(process.cwd())));
});
