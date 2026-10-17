// Runs the CLI's tests only. A bare `node --test` on Node 23+ also discovers
// plugin/tests/*.test.ts, which need `claude plugin test` (npm run test:plugin).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => join(dir, f));
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
