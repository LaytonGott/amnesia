import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectHistory,
  droppedForBoundary,
  isAmnesiaBlock,
  scanFile,
  encodeProjectPath,
  extractText,
  listSessionFiles,
} from "../src/claude.mjs";
import { isToolResultPath } from "../src/actions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "amnesia-regress-")));

after(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args, opts = {}) =>
  execFileSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts });

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

function compactedSession(prompt, { cwd } = {}) {
  return jsonl([
    {
      type: "user",
      uuid: "p1",
      timestamp: "2026-10-01T10:00:00.000Z",
      ...(cwd ? { cwd } : {}),
      message: { role: "user", content: prompt },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "b1",
      timestamp: "2026-10-01T10:05:00.000Z",
      compactMetadata: { trigger: "auto", preTokens: 50000, postTokens: 5000 },
    },
    {
      type: "user",
      uuid: "p2",
      timestamp: "2026-10-01T10:06:00.000Z",
      message: { role: "user", content: "continue" },
    },
  ]);
}

test("listSessionFiles records mtimeMs", () => {
  const root = join(tmp, "mtime-root");
  mkdirSync(join(root, "p"), { recursive: true });
  writeFileSync(join(root, "p", "s.jsonl"), compactedSession("hi"));
  const [f] = listSessionFiles(root);
  assert.ok(f.mtimeMs > 0);
});

test("restore with no id picks the newest compacted session, not the first by name", () => {
  const work = join(tmp, "work-latest");
  mkdirSync(work, { recursive: true });
  const root = join(tmp, "root-latest");
  const proj = join(root, encodeProjectPath(work));
  mkdirSync(proj, { recursive: true });

  const old = new Date("2026-01-01T00:00:00Z");
  const put = (sid, body, when) => {
    const p = join(proj, `${sid}.jsonl`);
    writeFileSync(p, body);
    utimesSync(p, when, when);
  };
  // Alphabetically first, oldest, compacted.
  put("0aaaaaaa-0000-0000-0000-000000000001", compactedSession("old work"), old);
  // Twelve clean sessions that sort ahead of the newest one.
  for (let i = 0; i < 12; i++) {
    const sid = `1${String(i).padStart(7, "0")}-0000-0000-0000-000000000001`;
    put(sid, jsonl([{ type: "user", uuid: `c${i}`, message: { content: "hi" } }]), old);
  }
  // Alphabetically last, newest, compacted.
  put("ffffffff-0000-0000-0000-000000000001", compactedSession("new work"), new Date());

  const store = join(tmp, "store-latest");
  const out = run(["restore", "--root", root], {
    cwd: work,
    env: { ...process.env, AMNESIA_HOME: store },
  });
  assert.ok(out.includes("/ffffffff"), out);
  const files = readdirSync(join(store, encodeProjectPath(work)));
  assert.ok(files.some((f) => f.startsWith("restored-ffffffff")));
});

test("protect <session> --write targets the session's own project, not the shell cwd", () => {
  const project = join(tmp, "proj-owner");
  const elsewhere = join(tmp, "unrelated-dir");
  mkdirSync(project, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  const root = join(tmp, "root-protect");
  const dir = join(root, encodeProjectPath(project));
  mkdirSync(dir, { recursive: true });
  const sid = "dddddddd-1111-0000-0000-000000000001";
  writeFileSync(
    join(dir, `${sid}.jsonl`),
    compactedSession("Never touch the billing tables in this repo.", { cwd: project })
  );

  run(["protect", sid, "--root", root, "--write"], { cwd: elsewhere });
  assert.ok(existsSync(join(project, "CLAUDE.md")));
  assert.equal(existsSync(join(elsewhere, "CLAUDE.md")), false);
  assert.ok(
    readFileSync(join(project, "CLAUDE.md"), "utf8").includes("billing tables")
  );
});

test("protect --write refuses when the session's project cannot be determined", () => {
  const elsewhere = join(tmp, "unrelated-dir-2");
  mkdirSync(elsewhere, { recursive: true });
  const root = join(tmp, "root-protect-nocwd");
  const dir = join(root, "some-project");
  mkdirSync(dir, { recursive: true });
  const sid = "dddddddd-2222-0000-0000-000000000001";
  writeFileSync(
    join(dir, `${sid}.jsonl`),
    compactedSession("Never touch the billing tables in this repo.")
  );

  assert.throws(() =>
    run(["protect", sid, "--root", root, "--write"], {
      cwd: elsewhere,
      stdio: "pipe",
    })
  );
  assert.equal(existsSync(join(elsewhere, "CLAUDE.md")), false);
});

test("recover only copies files inside the session's tool-results directory", () => {
  const root = join(tmp, "root-recover");
  const sid = "eeeeeeee-3333-0000-0000-000000000001";
  const proj = join(root, "projR");
  const tdir = join(proj, sid, "tool-results");
  mkdirSync(tdir, { recursive: true });
  const legit = join(tdir, "legit.txt");
  writeFileSync(legit, "LEGIT OUTPUT\n");
  const secret = join(tmp, "secret.txt");
  writeFileSync(secret, "TOP SECRET\n");
  const traversal = join(tdir, "..", "..", "..", "..", "secret.txt");

  const pointer = (id, path) => ({
    type: "user",
    uuid: id,
    timestamp: "2026-10-02T10:00:00.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: `<persisted-output>\nOutput too large (1.0KB). Full output saved to: ${path}\n`,
        },
      ],
    },
  });
  writeFileSync(
    join(proj, `${sid}.jsonl`),
    jsonl([
      pointer("toolu_legit", legit),
      pointer("toolu_secret", secret),
      pointer("toolu_traversal", traversal),
    ])
  );

  const out = join(tmp, "recover-out");
  const stdout = run(["recover", sid, "--root", root, "--out", out]);
  assert.ok(stdout.includes("recovered 1/3"), stdout);
  assert.ok(stdout.includes("rejected"));
  assert.ok(existsSync(join(out, "legit.txt")));
  assert.equal(existsSync(join(out, "secret.txt")), false);
  const man = readFileSync(join(out, "MANIFEST.md"), "utf8");
  assert.ok(man.includes("outside the session's tool-results directory"));
  assert.equal(man.includes("TOP SECRET"), false);
});

test("isToolResultPath accepts only <root>/<project>/<session>/tool-results/<file>", () => {
  const file = { path: join(tmp, "r", "proj", "sid.jsonl") };
  const root = join(tmp, "r");
  assert.equal(isToolResultPath(join(root, "proj", "sid", "tool-results", "a.txt"), file), true);
  assert.equal(isToolResultPath(join(root, "other", "sid2", "tool-results", "a.txt"), file), true);
  assert.equal(isToolResultPath(join(root, "proj", "sid", "a.txt"), file), false);
  assert.equal(isToolResultPath(join(root, "proj", "sid", "tool-results", "x", "a.txt"), file), false);
  assert.equal(isToolResultPath(join(tmp, "elsewhere", "tool-results", "a.txt"), file), false);
  assert.equal(
    isToolResultPath(join(root, "proj", "sid", "tool-results", "..", "..", "..", "..", "x.txt"), file),
    false
  );
  assert.equal(isToolResultPath(null, file), false);
});

test("extractText keeps every text block and skips reminder-only blocks", () => {
  const reminder = "<system-reminder>\nharness note\n</system-reminder>";
  assert.equal(
    extractText([
      { type: "text", text: reminder },
      { type: "text", text: "the user's real request" },
    ]),
    "the user's real request"
  );
  assert.equal(
    extractText([
      { type: "text", text: "part one" },
      { type: "image", source: {} },
      { type: "text", text: "part two" },
    ]),
    "part one\n\npart two"
  );
  assert.equal(extractText([{ type: "text", text: reminder }]), reminder);
  assert.equal(extractText("plain"), "plain");
  assert.equal(extractText([{ type: "image" }]), null);
});

test("dropped prompts with a leading reminder block keep the user's words", async () => {
  const p = join(tmp, "multi.jsonl");
  writeFileSync(
    p,
    jsonl([
      {
        type: "user",
        uuid: "m1",
        timestamp: "2026-10-01T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>\nnote\n</system-reminder>" },
            { type: "text", text: "Keep the migration reversible." },
          ],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        timestamp: "2026-10-01T10:05:00.000Z",
        compactMetadata: { trigger: "auto", preTokens: 1000, postTokens: 100 },
      },
    ])
  );
  const h = await collectHistory({ path: p });
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].text, "Keep the migration reversible.");
});

test("rows the plugin appends after a summary are not counted as prompts", async () => {
  const p = join(tmp, "plugin-block.jsonl");
  writeFileSync(
    p,
    jsonl([
      { type: "user", uuid: "q1", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "pin commit 7f3c2a91e" } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        timestamp: "2026-10-01T10:05:00.000Z",
        compactMetadata: { trigger: "manual", preTokens: 50000, postTokens: 8000 },
      },
      { type: "user", uuid: "s1", isCompactSummary: true, parentUuid: "b1", message: { role: "user", content: "Summary: worked on a build." } },
      {
        type: "user",
        uuid: "k1",
        parentUuid: "s1",
        message: { role: "user", content: "[amnesia] Exact details the summary above dropped, verbatim from the replaced history.\n- 7f3c2a91e" },
      },
      { type: "user", uuid: "q2", timestamp: "2026-10-01T10:06:00.000Z", message: { role: "user", content: "continue" } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b2",
        timestamp: "2026-10-01T10:09:00.000Z",
        compactMetadata: { trigger: "auto", preTokens: 60000, postTokens: 9000 },
      },
    ])
  );
  const file = { path: p, project: "x", session: "plugin-block", size: 0, mtimeMs: 0 };
  const h = await collectHistory(file);
  assert.deepEqual(h.prompts.map((x) => x.text), ["pin commit 7f3c2a91e", "continue"]);
  assert.equal(h.boundaries[0].summary, "Summary: worked on a build.");
  const second = droppedForBoundary(h, 1);
  assert.deepEqual(second.map((x) => x.text), ["continue"]);
  const s = await scanFile(file);
  assert.equal(s.userSeen, 2);
  assert.equal(s.boundaries[1].coveredUsers, 1);
  assert.equal(isAmnesiaBlock("  [amnesia] x"), true);
  assert.equal(isAmnesiaBlock("about [amnesia]"), false);
});
