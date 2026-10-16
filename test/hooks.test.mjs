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

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const ROOT = join(HERE, "fixtures", "root");
const tmp = mkdtempSync(join(tmpdir(), "amnesia-hooks-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts });

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

test("install merges hooks into settings, preserving existing keys", () => {
  const s = join(tmp, "settings-merge.json");
  writeFileSync(s, JSON.stringify({ model: "opus" }, null, 2));
  const out = run(["install", "--settings", s]);
  assert.ok(out.includes("PreCompact"));
  const j = JSON.parse(readFileSync(s, "utf8"));
  assert.equal(j.model, "opus");
  assert.equal(j.hooks.PreCompact.length, 1);
  assert.equal(j.hooks.PostCompact.length, 1);
  assert.ok(
    j.hooks.PreCompact[0].hooks[0].command.includes("hook precompact")
  );
});

test("install is idempotent", () => {
  const s = join(tmp, "settings-idem.json");
  run(["install", "--settings", s]);
  run(["install", "--settings", s]);
  const j = JSON.parse(readFileSync(s, "utf8"));
  assert.equal(j.hooks.PreCompact.length, 1);
  assert.equal(j.hooks.PostCompact.length, 1);
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
});

test("precompact hook archives a snapshot from stdin", () => {
  const cwd = join(tmp, "proj-hook");
  run(["hook", "precompact"], { input: fixtureInput(cwd, "PreCompact") });
  const dir = join(cwd, ".amnesia", "snapshots");
  assert.ok(existsSync(dir));
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const md = readFileSync(join(dir, files[0]), "utf8");
  assert.ok(md.includes("help me fix the auth bug in server.js"));
  assert.ok(md.includes("# Pre-compaction snapshot"));
});

test("postcompact hook prints a breadcrumb with the snapshot path", () => {
  const cwd = join(tmp, "proj-hook2");
  run(["hook", "precompact"], { input: fixtureInput(cwd, "PreCompact") });
  const input = JSON.stringify({
    session_id: "aaaaaaaa-0000-0000-0000-000000000001",
    cwd,
    trigger: "auto",
    hook_event_name: "PostCompact",
  });
  const out = run(["hook", "postcompact"], { input });
  assert.ok(out.includes("compaction just fired"));
  assert.ok(out.includes("snapshot"));
});

test("hooks never fail on garbage input", () => {
  const out = run(["hook", "precompact"], { input: "not json at all" });
  assert.equal(out, "");
  run(["hook", "postcompact"], { input: "" });
});
