import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const FIX = join(HERE, "fx", "root");
const tmp = mkdtempSync(join(tmpdir(), "amnesia-recover-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts });

function buildSession() {
  const sid = "eeeeeeee-0000-0000-0000-000000000001";
  const proj = join(tmp, "root", "projR");
  const tdir = join(proj, sid, "tool-results");
  mkdirSync(tdir, { recursive: true });
  const bigFile = join(tdir, "out-big.txt");
  writeFileSync(bigFile, "FULL OUTPUT LINE 1\nFULL OUTPUT LINE 2\n");
  const missingFile = join(tdir, "gone.txt");
  const lines = [
    {
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-02T10:00:00.000Z",
      message: { role: "user", content: "run the tests" },
    },
    {
      type: "user",
      uuid: "u2",
      timestamp: "2026-10-02T10:00:05.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_big",
            content:
              `<persisted-output>\nOutput too large (46.8KB). Full output saved to: ${bigFile}\n\nPreview (first 2KB):\nFULL OUTPUT LINE 1\n`,
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "u3",
      timestamp: "2026-10-02T10:01:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_gone",
            content: `<persisted-output>\nOutput too large (10.0KB). Full output saved to: ${missingFile}\n`,
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "u4",
      timestamp: "2026-10-02T10:02:00.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_cleared",
            content: "[Old tool result content cleared]",
          },
        ],
      },
    },
  ];
  writeFileSync(
    join(proj, `${sid}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );
  return sid;
}

test("recover copies persisted outputs and writes a manifest", () => {
  const sid = buildSession();
  const out = join(tmp, "out");
  const stdout = run([
    "recover",
    sid,
    "--root",
    join(tmp, "root"),
    "--out",
    out,
  ]);
  assert.ok(stdout.includes("recovered 1/2"));
  assert.ok(existsSync(join(out, "out-big.txt")));
  assert.ok(
    readFileSync(join(out, "out-big.txt"), "utf8").includes("FULL OUTPUT LINE 2")
  );
  const man = readFileSync(join(out, "MANIFEST.md"), "utf8");
  assert.ok(man.includes("toolu_big"));
  assert.ok(man.includes("toolu_gone"));
  assert.ok(man.includes("toolu_cleared"));
  assert.ok(stdout.includes("missing"));
  assert.ok(stdout.includes("cleared placeholder"));
});

test("session without persisted refs reports nothing to recover", () => {
  const out = run([
    "recover",
    "aaaaaaaa-0000-0000-0000-000000000001",
    "--root",
    FIX,
  ]);
  assert.ok(out.includes("nothing to recover"));
});
