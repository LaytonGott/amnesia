import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const tmp = mkdtempSync(join(tmpdir(), "amnesia-doctor-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const env = () => ({ ...process.env, AMNESIA_HOME: join(tmp, "store") });

const run = (args) =>
  execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: env(),
  });

const runFailing = (args) => {
  try {
    const out = run(args);
    return { failed: false, out };
  } catch (e) {
    return { failed: true, out: String(e.stdout || "") };
  }
};

test("doctor passes on a healthy install", () => {
  const s = join(tmp, "settings-ok.json");
  run(["install", "--settings", s]);
  const out = run(["doctor", "--settings", s]);
  assert.ok(out.includes("all checks passed"));
  assert.ok(out.includes("responds"));
});

test("doctor fails when hooks are missing", () => {
  const s = join(tmp, "settings-empty.json");
  writeFileSync(s, JSON.stringify({ model: "opus" }));
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("missing"));
  assert.ok(r.out.includes("amnesia install"));
});

test("doctor detects a dead node path", () => {
  const s = join(tmp, "settings-dead.json");
  const bin = join(HERE, "..", "bin", "amnesia.mjs");
  const cmd = (sub) => `"C:\\nope\\node.exe" "${bin}" hook ${sub}`;
  writeFileSync(
    s,
    JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: cmd("precompact") }] },
        ],
        PostCompact: [
          { matcher: "", hooks: [{ type: "command", command: cmd("postcompact") }] },
        ],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: cmd("prompt") }] },
        ],
      },
    })
  );
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("NOT FOUND"));
});

test("doctor validates every hook command, not just the first", () => {
  const s = join(tmp, "settings-mixed.json");
  const bin = join(HERE, "..", "bin", "amnesia.mjs");
  const good = (sub) => `"${process.execPath}" "${bin}" hook ${sub}`;
  writeFileSync(
    s,
    JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: good("precompact") }] },
        ],
        PostCompact: [
          { matcher: "", hooks: [{ type: "command", command: good("postcompact") }] },
        ],
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `"C:\\nope\\node.exe" "${bin}" hook prompt`,
              },
            ],
          },
        ],
      },
    })
  );
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("NOT FOUND"));
});

test("doctor survives unparseable settings", () => {
  const s = join(tmp, "settings-bad.json");
  writeFileSync(s, "{nope");
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("cannot parse"));
});
