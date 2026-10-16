import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listSessionFiles,
  scanFile,
  collectHistory,
  droppedForBoundary,
  encodeProjectPath,
} from "../src/claude.mjs";
import { extractConstraints } from "../src/actions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "root");

const mk = (rel) => {
  const path = join(ROOT, rel);
  return {
    path,
    project: rel.split(/[\\/]/)[0],
    session: path.split(/[\\/]/).pop().replace(/\.jsonl$/, ""),
    size: 0,
    mtimeMs: 0,
  };
};

const A1 = "projA/aaaaaaaa-0000-0000-0000-000000000001.jsonl";
const B1 = "projA/bbbbbbbb-0000-0000-0000-000000000001.jsonl";
const C1 = "projB/cccccccc-0000-0000-0000-000000000001.jsonl";
const D1 = "projC/dddddddd-0000-0000-0000-000000000001.jsonl";
const E1 = "projE/eeeeeeee-0000-0000-0000-000000000001.jsonl";

test("encodeProjectPath matches Claude Code folder encoding", () => {
  assert.equal(
    encodeProjectPath("C:\\Users\\x\\My Project"),
    "C--Users-x-My-Project"
  );
});

test("listSessionFiles finds all fixture sessions", () => {
  const files = listSessionFiles(ROOT);
  assert.equal(files.length, 6);
});

test("scanFile parses a compact boundary with full metadata", async () => {
  const r = await scanFile(mk(A1), { withPreviews: true });
  assert.equal(r.boundaries.length, 1);
  const b = r.boundaries[0];
  assert.equal(b.trigger, "auto");
  assert.equal(b.preTokens, 120000);
  assert.equal(b.postTokens, 8000);
  assert.equal(b.durationMs, 95000);
  assert.equal(b.preservedCount, 2);
  assert.equal(b.cumulativeDroppedTokens, 112000);
  assert.equal(b.coveredUsers, 1);
  assert.equal(b.coveredAssistants, 1);
  assert.equal(b.coveredToolResults, 1);
  assert.ok(b.summary.includes("Primary Request and Intent"));
});

test("preserved messages are excluded from dropped previews", async () => {
  const r = await scanFile(mk(A1), { withPreviews: true });
  const b = r.boundaries[0];
  assert.equal(b.previews.length, 1);
  assert.ok(b.previews[0].text.includes("auth bug"));
});

test("malformed lines are tolerated and manual trigger parses", async () => {
  const r = await scanFile(mk(C1));
  assert.equal(r.boundaries.length, 1);
  assert.equal(r.boundaries[0].trigger, "manual");
  assert.equal(r.boundaries[0].summary, null);
});

test("session without compaction yields no boundaries", async () => {
  const r = await scanFile(mk(B1));
  assert.equal(r.boundaries.length, 0);
});

test("collectHistory and droppedForBoundary", async () => {
  const h = await collectHistory(mk(A1));
  assert.equal(h.prompts.length, 3);
  const dropped = droppedForBoundary(h, 0);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].text.includes("auth bug"));

  const hc = await collectHistory(mk(D1));
  assert.equal(droppedForBoundary(hc, 0).length, 3);
});

test("extractConstraints finds constraint sentences", async () => {
  const h = await collectHistory(mk(D1));
  const cs = extractConstraints(droppedForBoundary(h, 0));
  const texts = cs.map((c) => c.text);
  assert.equal(cs.length, 3);
  assert.ok(texts.some((t) => t.includes("Never import the lobby module")));
  assert.ok(texts.some((t) => t.includes("audit only")));
});

test("missing root yields an empty listing", () => {
  assert.equal(listSessionFiles(join(ROOT, "..", "does-not-exist")).length, 0);
});

test("multi-boundary sessions count only the context each compaction replaced", async () => {
  const r = await scanFile(mk(E1), { withPreviews: true });
  assert.equal(r.boundaries.length, 2);
  const [b1, b2] = r.boundaries;
  assert.equal(b1.coveredUsers, 1);
  assert.equal(b1.coveredAssistants, 0);
  assert.equal(b1.previews.length, 1);
  assert.ok(b1.previews[0].text.includes("first prompt"));
  assert.equal(b1.precomputed, false);
  assert.equal(b2.coveredUsers, 1);
  assert.equal(b2.coveredAssistants, 2);
  assert.equal(b2.previews.length, 1);
  assert.ok(b2.previews[0].text.includes("second prompt"));
  assert.equal(b2.precomputed, true);
});

test("restore drops only per-boundary context", async () => {
  const h = await collectHistory(mk(E1));
  assert.equal(h.prompts.length, 3);
  assert.equal(droppedForBoundary(h, 0).length, 1);
  const d2 = droppedForBoundary(h, 1);
  assert.equal(d2.length, 1);
  assert.ok(d2[0].text.includes("second prompt"));
});
