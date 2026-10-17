import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// Claude Code installs the plugin by cloning this whole repository under
// <config>/plugins/marketplaces/<name>..clone/, and Windows refuses paths over
// 260 characters. Keeping every tracked path short leaves room for long config
// directories: a 70-character cap fits a clone prefix of up to 190.
const MAX = 70;

test(`every tracked path is at most ${MAX} characters`, (t) => {
  let files;
  try {
    files = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    t.skip("not a git checkout");
    return;
  }
  const long = files.filter((f) => f.length > MAX);
  assert.deepEqual(long, [], `paths over ${MAX} chars:\n${long.join("\n")}`);
});
