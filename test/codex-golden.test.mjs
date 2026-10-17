import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listCodexSessions, scanCodexSession } from "../src/codex.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const CROOT = join(HERE, "fx", "golden");
const SID = "99999999-0000-0000-0000-000000000001";

const run = (args) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

test("golden rollout: parser invariants hold exactly", async () => {
  const files = listCodexSessions(CROOT);
  assert.equal(files.length, 1);
  const env = await scanCodexSession(files[0]);
  assert.equal(env.cwd, "C:\\projects\\golden");
  assert.equal(env.contextWindow, 200000);
  assert.equal(env.compacteds.length, 2);

  const [e1, e2] = env.compacteds;
  assert.equal(e1.windowNumber, 1);
  assert.equal(e1.preTokens, 150000);
  assert.equal(e1.postTokens, 45000);
  assert.equal(e1.durationMs, 50000);
  assert.equal(e1.beforeCount, 6);
  assert.equal(e1.beforeMessages, 5);
  assert.equal(e1.beforeOutputs, 1);
  assert.equal(e1.keptCount, 3);
  assert.equal(e1.droppedUsers.length, 1);
  assert.ok(e1.droppedUsers[0].text.includes("never touch the config folder"));

  assert.equal(e2.windowNumber, 2);
  assert.equal(e2.preTokens, 175000);
  assert.equal(e2.postTokens, null);
  assert.equal(e2.durationMs, 75000);
  assert.equal(e2.beforeCount, 11);
  assert.equal(e2.keptCount, 2);
  assert.equal(e2.droppedUsers.length, 3);

  const u = new Map(env.unknowns.map((x) => [`${x.kind}:${x.name}`, x.count]));
  assert.equal(u.get("line:future_feature"), 1);
  assert.equal(u.get("event_msg:mystery_event"), 1);
  assert.equal(u.get("unparseable:line"), 1);
});

test("golden rollout: receipt prints exact values + drift note", () => {
  const out = run(["codex", SID, "--root", CROOT]);
  assert.ok(out.includes("150,000 \u2192 45,000 tokens (window 200,000)"));
  assert.ok(out.includes("(70% dropped)"));
  assert.ok(out.includes("50s"));
  assert.ok(
    out.includes("6 context items (5 messages, 1 tool outputs) \u2192 3 retained")
  );
  assert.ok(out.includes("1 human prompt"));
  assert.ok(out.includes("175,000 \u2192 ? tokens (window 200,000)"));
  assert.ok(out.includes("75s"));
  assert.ok(
    out.includes("11 context items (8 messages, 3 tool outputs) \u2192 2 retained")
  );
  assert.ok(out.includes("3 human prompts"));
  assert.ok(out.includes("line:future_feature"));
  assert.ok(out.includes("amnesia may need an update"));
});

test("golden rollout: scan aggregates totals + drift note", () => {
  const out = run(["codex", "--root", CROOT]);
  assert.ok(out.includes("4 dropped prompt(s) in total"));
  assert.ok(out.includes("2m 5s"));
  assert.ok(out.includes("note: unrecognized journal entries"));
  assert.ok(out.includes("unparseable \u00d7"));
});

test("golden rollout: json carries unknowns", () => {
  const out = run(["codex", SID, "--root", CROOT, "--json"]);
  const j = JSON.parse(out);
  assert.equal(j.unknowns.length, 3);
  assert.equal(j.compacteds[0].beforeMessages, 5);
  assert.equal(j.compacteds[1].postTokens, null);
});
