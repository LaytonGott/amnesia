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
  exactStrings,
  pluginBlockOf,
  retentionOf,
  blockValues,
  blockUseOf,
  scanFileCached,
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

test("the receipt shows what the plugin's block kept at each compaction", async () => {
  const root = join(tmp, "root-pluginblock");
  const dir = join(root, "projP");
  mkdirSync(dir, { recursive: true });
  const sid = "abababab-0000-0000-0000-000000000001";
  writeFileSync(
    join(dir, `${sid}.jsonl`),
    jsonl([
      { type: "user", uuid: "q1", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "For acme-billing, the staging port is 29860." } },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "b1",
        timestamp: "2026-10-01T10:05:00.000Z",
        compactMetadata: { trigger: "auto", preTokens: 50000, postTokens: 6000 },
      },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { role: "user", content: "Summary: billing work." } },
      {
        type: "user",
        uuid: "k1",
        message: {
          role: "user",
          content:
            "[amnesia] Exact details the summary above dropped, verbatim from the replaced history.\n" +
            "- For acme-billing: the staging port is 29860; the tracking ticket is OPS-96797\n" +
            '- 4e9b1c27d — "Pin the release to commit 4e9b1c27d."',
        },
      },
    ])
  );
  const s = await scanFile({ path: join(dir, `${sid}.jsonl`), project: "projP", session: sid, size: 0, mtimeMs: 0 });
  assert.equal(s.boundaries[0].pluginBlock.details, 3);
  const out = run([sid, "--root", root]);
  assert.ok(out.includes("block kept 3 exact detail(s)"), out);
  assert.ok(out.includes("what amnesia kept"));
  const j = JSON.parse(run(["--json", sid, "--root", root]));
  assert.equal(j.boundaries[0].pluginBlock.details, 3);
});

test("the receipt says how many exact strings the summary kept and the block brought back", async () => {
  const root = join(tmp, "root-retention");
  const dir = join(root, "projR");
  mkdirSync(dir, { recursive: true });
  const sid = "cdcdcdcd-0000-0000-0000-000000000001";
  writeFileSync(
    join(dir, `${sid}.jsonl`),
    jsonl([
      { type: "user", uuid: "q1", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "Edit src/runtime/config.ts on feat/compact-plugin and track it as OPS-96797." } },
      { type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-10-01T10:05:00.000Z", compactMetadata: { trigger: "auto", preTokens: 50000, postTokens: 6000 } },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { role: "user", content: "Summary: edited src/runtime/config.ts." } },
      {
        type: "user",
        uuid: "k1",
        message: {
          role: "user",
          content:
            "[amnesia] Exact details the summary above dropped, verbatim from the replaced history.\n" +
            "- OPS-96797 — \"track it as OPS-96797\"\n" +
            "Also dropped (look up with recall before relying on them): acme-billing (staging port, tracking ticket) · release_gate_key · and 7 more.",
        },
      },
    ])
  );
  const s = await scanFile({ path: join(dir, `${sid}.jsonl`), project: "projR", session: sid, size: 0, mtimeMs: 0 });
  assert.deepEqual(s.boundaries[0].retention, { strings: 3, held: 1, block: 1 });
  assert.equal(s.boundaries[0].pluginBlock.indexed, 10);
  const out = run([sid, "--root", root]);
  assert.ok(out.includes("summary has 1 of 3 exact strings from your dropped prompts (33%)"), out);
  assert.ok(out.includes("amnesia's block brought back 1 more"), out);
  assert.ok(out.includes("named 10 more for recall"), out);
});

test("exact strings are compound tokens of 5+ characters, lowercased", () => {
  assert.deepEqual([...exactStrings("See src/A.ts, OPS-77412 and v1.2.3; not a-b or plain words")].sort(), ["ops-77412", "src/a.ts", "v1.2.3"]);
  assert.equal(retentionOf(["nothing exact here"], "s", null), null);
  assert.equal(retentionOf(["edit src/a.ts"], null, null), null);
  assert.equal(pluginBlockOf("[amnesia] Exact details x\n- a = 1").indexed, 0);
  // harness-injected rows and tags count for nothing; pasted contents still count
  const note = "<task-notification><task-id>b5f9e1z4z</task-id><output-file>C:\\x\\tasks\\b5f9e1z4z.output</output-file></task-notification>";
  assert.deepEqual([...exactStrings(note)], []);
  assert.deepEqual([...exactStrings('<pasted_content id="1b8f">deploy svc-3-api</pasted_content> toolu_01abc_def')], ["svc-3-api"]);
});

test("a prompt or summary that mentions compact_boundary is still read", async () => {
  const p = join(tmp, "mentions-boundary.jsonl");
  writeFileSync(
    p,
    jsonl([
      { type: "user", uuid: "q1", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "why does the compact_boundary row skip src/claude.mjs?" } },
      { type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-10-01T10:05:00.000Z", compactMetadata: { trigger: "auto", preTokens: 50000, postTokens: 6000 } },
      { type: "user", uuid: "s1", isCompactSummary: true, message: { role: "user", content: "Summary: debugged the compact_boundary parser in src/claude.mjs." } },
    ])
  );
  const file = { path: p, project: "x", session: "mentions-boundary", size: 0, mtimeMs: 0 };
  const h = await collectHistory(file);
  assert.deepEqual(h.prompts.map((x) => x.text), ["why does the compact_boundary row skip src/claude.mjs?"]);
  const s = await scanFile(file);
  assert.equal(s.boundaries.length, 1);
  assert.equal(s.boundaries[0].summary, "Summary: debugged the compact_boundary parser in src/claude.mjs.");
  assert.deepEqual(s.boundaries[0].retention, { strings: 2, held: 2, block: 0 });
});

test("an unchanged transcript's scan is reused; a changed one is read again", async () => {
  const home = join(tmp, "cache-home");
  const prev = process.env.AMNESIA_HOME;
  process.env.AMNESIA_HOME = home;
  try {
    const p = join(tmp, "cached.jsonl");
    const rows = [
      { type: "user", uuid: "q1", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "pin src/a.ts" } },
      { type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-10-01T10:05:00.000Z", compactMetadata: { trigger: "auto", preTokens: 50000, postTokens: 6000 } },
    ];
    writeFileSync(p, jsonl(rows));
    const file = () => ({ path: p, project: "x", session: "cached", size: readFileSync(p).length, mtimeMs: 1 });
    const first = await scanFileCached(file());
    assert.equal(first.boundaries.length, 1);
    // same size and mtime: the stored scan is returned even though the file now says otherwise
    writeFileSync(p, jsonl(rows).replace("pin src/a.ts", "pin src/b.ts"));
    const reused = await scanFileCached(file());
    assert.equal(reused.boundaries.length, 1);
    assert.equal(reused.userSeen, first.userSeen);
    // a real change (size differs): read again
    writeFileSync(p, jsonl([...rows, { type: "system", subtype: "compact_boundary", uuid: "b2", timestamp: "2026-10-01T11:00:00.000Z", compactMetadata: { trigger: "auto", preTokens: 60000, postTokens: 6000 } }]));
    const fresh = await scanFileCached(file());
    assert.equal(fresh.boundaries.length, 2);
    process.env.AMNESIA_NO_CACHE = "1";
    assert.equal((await scanFileCached(file())).boundaries.length, 2);
  } finally {
    delete process.env.AMNESIA_NO_CACHE;
    if (prev === undefined) delete process.env.AMNESIA_HOME;
    else process.env.AMNESIA_HOME = prev;
  }
});

test("block use counts lines whose values come back before the next compaction", () => {
  assert.deepEqual(blockValues('f38021b — "git cherry-pick f38021b"'), ["f38021b"]);
  assert.deepEqual(blockValues("For acme-billing: the staging port is 29860; the tracking ticket is OPS-96797"), ["29860", "OPS-96797"]);
  const items = ['f38021b — "pick it"', "For acme-billing: the staging port is 29860; the tracking ticket is OPS-96797", "--json"];
  assert.deepEqual(blockUseOf(items, "deploy acme on 29860, then git show f38021b"), { lines: 3, used: 2 });
  assert.equal(blockUseOf(items, ""), null);
});
