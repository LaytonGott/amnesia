import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listCodexSessions, scanCodexSession } from "../src/codex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const CROOT = join(HERE, "fixtures", "codex");
const SID = "cccccccc-0000-0000-0000-000000000001";

const run = (args) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("listCodexSessions finds rollout files with parsed ids", () => {
  const files = listCodexSessions(CROOT);
  assert.equal(files.length, 1);
  assert.equal(files[0].session, SID);
});

test("scanCodexSession parses the compaction window", async () => {
  const files = listCodexSessions(CROOT);
  const env = await scanCodexSession(files[0]);
  assert.equal(env.cwd, "C:\\projects\\demo");
  assert.equal(env.contextWindow, 200000);
  assert.equal(env.compacteds.length, 1);
  const c = env.compacteds[0];
  assert.equal(c.windowNumber, 1);
  assert.equal(c.preTokens, 150000);
  assert.equal(c.postTokens, 30000);
  assert.equal(c.durationMs, 94000);
  assert.equal(c.keptCount, 2);
  assert.equal(c.beforeCount, 4);
  assert.equal(c.droppedUsers.length, 1);
  assert.ok(c.droppedUsers[0].text.includes("staging bucket"));
});

test("codex receipt shows tokens, dead time and dropped prompts", () => {
  const out = run(["codex", SID, "--root", CROOT]);
  assert.ok(out.includes("150,000"));
  assert.ok(out.includes("30,000"));
  assert.ok(out.includes("1m 34s"));
  assert.ok(out.includes("Never delete the staging bucket"));
  assert.ok(out.includes("Build the exporter"));
});

test("codex scan lists the session", () => {
  const out = run(["codex", "--root", CROOT]);
  assert.ok(out.includes("1 rollout session(s)"));
  assert.ok(out.includes(SID.slice(0, 8)));
});

test("codex --json is valid machine-readable output", () => {
  const out = run(["codex", SID, "--root", CROOT, "--json"]);
  const j = JSON.parse(out);
  assert.equal(j.agent, "codex");
  assert.equal(j.compacteds.length, 1);
  assert.equal(j.compacteds[0].preTokens, 150000);
  assert.equal(j.compacteds[0].droppedUsers.length, 1);
});
