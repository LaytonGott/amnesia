import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeProjectPath } from "../src/claude.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const ROOT = join(HERE, "fx", "root");
const tmp = mkdtempSync(join(tmpdir(), "amnesia-hooks-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const STORE = join(tmp, "store");
const ENV = { ...process.env, AMNESIA_HOME: STORE };

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: ENV,
    ...opts,
  });

const projStore = (cwd) => join(STORE, encodeProjectPath(cwd));

const fixtureInput = (cwd, event) =>
  JSON.stringify({
    session_id: "aaaaaaaa-0000-0000-0000-000000000001",
    transcript_path: join(
      ROOT,
      "projA",
      "aaaaaaaa-0000-0000-0000-000000000001.jsonl"
    ),
    cwd,
    trigger: "auto",
    hook_event_name: event,
  });

const constraintsInput = (cwd) =>
  JSON.stringify({
    session_id: "dddddddd-0000-0000-0000-000000000001",
    transcript_path: join(
      ROOT,
      "projC",
      "dddddddd-0000-0000-0000-000000000001.jsonl"
    ),
    cwd,
    trigger: "auto",
    hook_event_name: "PreCompact",
  });

test("install registers all three hooks, preserving existing keys", () => {
  const s = join(tmp, "settings-merge.json");
  writeFileSync(s, JSON.stringify({ model: "opus" }, null, 2));
  const out = run(["install", "--settings", s]);
  assert.ok(out.includes("PreCompact"));
  assert.ok(out.includes("UserPromptSubmit"));
  const j = JSON.parse(readFileSync(s, "utf8"));
  assert.equal(j.model, "opus");
  assert.equal(j.hooks.PreCompact.length, 1);
  assert.equal(j.hooks.PostCompact.length, 1);
  assert.equal(j.hooks.UserPromptSubmit.length, 1);
  const pre = j.hooks.PreCompact[0].hooks[0];
  assert.equal(pre.args[1], "hook");
  assert.equal(pre.args[2], "precompact");
  assert.ok(pre.args[0].includes("amnesia"));
  const ups = j.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(ups.args[1], "hook");
  assert.equal(ups.args[2], "prompt");
  assert.ok(ups.args[0].includes("amnesia"));
});

test("install is idempotent", () => {
  const s = join(tmp, "settings-idem.json");
  run(["install", "--settings", s]);
  run(["install", "--settings", s]);
  const j = JSON.parse(readFileSync(s, "utf8"));
  assert.equal(j.hooks.PreCompact.length, 1);
  assert.equal(j.hooks.PostCompact.length, 1);
  assert.equal(j.hooks.UserPromptSubmit.length, 1);
});

test("install dry-run writes nothing", () => {
  const s = join(tmp, "settings-dry.json");
  run(["install", "--settings", s, "--dry-run"]);
  assert.equal(existsSync(s), false);
});

test("uninstall removes only amnesia hooks", () => {
  const s = join(tmp, "settings-uninstall.json");
  writeFileSync(
    s,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
        ],
      },
    })
  );
  run(["install", "--settings", s]);
  run(["uninstall", "--settings", s]);
  const j = JSON.parse(readFileSync(s, "utf8"));
  assert.ok(j.hooks.PreToolUse);
  assert.equal(j.hooks.PreCompact, undefined);
  assert.equal(j.hooks.PostCompact, undefined);
  assert.equal(j.hooks.UserPromptSubmit, undefined);
});

test("precompact hook archives snapshot + sidecar from stdin", () => {
  const cwd = join(tmp, "proj-hook");
  run(["hook", "precompact"], { input: fixtureInput(cwd, "PreCompact") });
  const dir = join(projStore(cwd), "snapshots");
  assert.ok(existsSync(dir));
  const files = readdirSync(dir);
  assert.equal(files.filter((f) => f.endsWith(".md")).length, 1);
  assert.equal(files.filter((f) => f.endsWith(".json")).length, 1);
  const md = readFileSync(
    join(dir, files.find((f) => f.endsWith(".md"))),
    "utf8"
  );
  assert.ok(md.includes("help me fix the auth bug in server.js"));
  assert.ok(md.includes("# Pre-compaction snapshot"));
});

test("postcompact hook queues the exact dropped messages", () => {
  const cwd = join(tmp, "proj-hook2");
  run(["hook", "precompact"], { input: fixtureInput(cwd, "PreCompact") });
  const input = JSON.stringify({
    session_id: "aaaaaaaa-0000-0000-0000-000000000001",
    transcript_path: join(
      ROOT,
      "projA",
      "aaaaaaaa-0000-0000-0000-000000000001.jsonl"
    ),
    cwd,
    trigger: "auto",
    hook_event_name: "PostCompact",
  });
  const out = run(["hook", "postcompact"], { input });
  assert.ok(out.includes("compaction just fired"));
  const marker = join(projStore(cwd), "inject", "aaaaaaaa.json");
  assert.ok(existsSync(marker));
  const m = JSON.parse(readFileSync(marker, "utf8"));
  assert.ok(m.snapshot);
  assert.equal(m.messages.length, 1);
  assert.ok(m.messages[0].text.includes("auth bug"));
  assert.ok(!JSON.stringify(m.messages).includes("JWT"));
});

test("prompt hook injects lost messages verbatim once, then clears", () => {
  const cwd = join(tmp, "proj-hook3");
  run(["hook", "precompact"], { input: constraintsInput(cwd) });
  run(["hook", "postcompact"], {
    input: JSON.stringify({
      session_id: "dddddddd-0000-0000-0000-000000000001",
      transcript_path: join(
        ROOT,
        "projC",
        "dddddddd-0000-0000-0000-000000000001.jsonl"
      ),
      cwd,
      trigger: "auto",
      hook_event_name: "PostCompact",
    }),
  });
  const promptInput = JSON.stringify({
    session_id: "dddddddd-0000-0000-0000-000000000001",
    cwd,
    prompt: "continue",
    hook_event_name: "UserPromptSubmit",
  });
  const out = run(["hook", "prompt"], { input: promptInput });
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = j.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("[amnesia]"));
  assert.ok(ctx.includes("Never import the lobby module"));
  assert.ok(ctx.includes("Build the sync daemon."));
  assert.ok(ctx.includes("newer instructions always win"));
  // re-injected prompts are reference, never a fresh order to repeat a one-off action
  assert.ok(ctx.includes("do not redo actions that were already completed"));
  assert.equal(ctx.includes("still applies"), false);
  assert.equal(
    existsSync(join(projStore(cwd), "inject", "dddddddd.json")),
    false
  );
  const second = run(["hook", "prompt"], { input: promptInput });
  assert.equal(second, "");
});

test("prompt hook is silent with no pending injection", () => {
  const cwd = join(tmp, "proj-hook4");
  const out = run(["hook", "prompt"], {
    input: JSON.stringify({
      session_id: "eeeeeeee-0000-0000-0000-000000000001",
      cwd,
      prompt: "hi",
      hook_event_name: "UserPromptSubmit",
    }),
  });
  assert.equal(out, "");
});

test("injection continues past an oversized newest message", () => {
  const cwd = join(tmp, "proj-hook5");
  const sid = "ffffffff-0000-0000-0000-000000000001";
  const tp = join(tmp, `${sid}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: "q1",
      message: { role: "user", content: "rule one: keep it read-only" },
    }),
    JSON.stringify({
      type: "user",
      uuid: "q2",
      message: { role: "user", content: "rule two: audit only" },
    }),
    JSON.stringify({
      type: "user",
      uuid: "q3",
      message: { role: "user", content: "B".repeat(9000) },
    }),
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: {
        trigger: "auto",
        preTokens: 1000,
        postTokens: 100,
        durationMs: 5,
        preservedMessages: { uuids: [] },
      },
      uuid: "q4",
    }),
    JSON.stringify({
      type: "user",
      isCompactSummary: true,
      uuid: "q5",
      message: { role: "user", content: "Summary: x" },
    }),
  ];
  writeFileSync(tp, lines.join("\n") + "\n");
  run(["hook", "postcompact"], {
    input: JSON.stringify({
      session_id: sid,
      transcript_path: tp,
      cwd,
      trigger: "auto",
      hook_event_name: "PostCompact",
    }),
  });
  const out = run(["hook", "prompt"], {
    input: JSON.stringify({
      session_id: sid,
      cwd,
      prompt: "go",
      hook_event_name: "UserPromptSubmit",
    }),
  });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("rule one: keep it read-only"));
  assert.ok(ctx.includes("rule two: audit only"));
  assert.ok(ctx.includes("long ones shortened"));
});

test("postcompact is silent without any session context", () => {
  const out = run(["hook", "postcompact"], { input: "{}" });
  assert.equal(out, "");
});

test("hooks never fail on garbage input", () => {
  const out = run(["hook", "precompact"], { input: "not json at all" });
  assert.equal(out, "");
  run(["hook", "postcompact"], { input: "" });
  const p = run(["hook", "prompt"], { input: "" });
  assert.equal(p, "");
});
