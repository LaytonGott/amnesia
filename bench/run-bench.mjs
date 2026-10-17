import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { encodeProjectPath } from "../src/claude.mjs";
import { HOOK_EVENTS, makeHookEntry } from "../src/hooks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "bin", "amnesia.mjs");
const SCENARIO = JSON.parse(readFileSync(join(HERE, "scenario.json"), "utf8"));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RUNS = Number(arg("--runs", "3"));
const ARMS = arg("--arms", "a,b").split(",").map((s) => s.trim());
const SMOKE = argv.includes("--smoke");
const MODEL = arg("--model", null);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const RES = join(HERE, "results", stamp);
mkdirSync(RES, { recursive: true });

const probes = SMOKE
  ? SCENARIO.probes.filter((p) =>
      ["version_pin", "ticket_id_commit", "suffix_convention"].includes(p.id)
    )
  : SCENARIO.probes;

function writeArmSettings(dir) {
  const hooks = {};
  for (const { event, cmd } of HOOK_EVENTS) {
    hooks[event] = [makeHookEntry(cmd)];
  }
  const p = join(dir, "settings-b.json");
  writeFileSync(p, JSON.stringify({ hooks }, null, 2));
  return p;
}

function claude(args, { cwd, env }) {
  const started = Date.now();
  let raw = "";
  let failed = false;
  try {
    raw = execFileSync("claude", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 280000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    failed = true;
    raw = String(e.stdout || e.message || e);
  }
  const durationMs = Date.now() - started;
  let j = null;
  try {
    j = JSON.parse(raw);
  } catch {
    const m = raw.indexOf("{");
    if (m !== -1) {
      try {
        j = JSON.parse(raw.slice(m));
      } catch {}
    }
  }
  return {
    failed,
    durationMs,
    cost: j?.total_cost_usd ?? null,
    result: j?.result ?? null,
    sessionId: j?.session_id ?? null,
  };
}

function transcriptFor(projDir, sessionId) {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectPath(projDir),
    `${sessionId}.jsonl`
  );
}

function modelsInFile(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const set = new Set();
  for (const m of text.matchAll(/"model"\s*:\s*"(claude[^"]+)"/g)) {
    set.add(m[1]);
  }
  return [...set];
}

function countIn(file, needle) {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8");
  let n = 0;
  let i = 0;
  for (;;) {
    i = text.indexOf(needle, i);
    if (i === -1) break;
    n++;
    i += needle.length;
  }
  return n;
}

function score(text, spec) {
  const t = text || "";
  const has = (p) => new RegExp(p, "is").test(t);
  if (spec.all && !spec.all.every(has)) return false;
  if (spec.any && !spec.any.some(has)) return false;
  if (spec.ban && spec.ban.some(has)) return false;
  return true;
}

const allRuns = [];

for (const arm of ARMS) {
  for (let run = 1; run <= RUNS; run++) {
    const label = `${arm}-${run}`;
    const runDir = join(RES, label);
    const projDir = join(runDir, "proj");
    const storeDir = join(runDir, "store");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(storeDir, { recursive: true });

    const env = { ...process.env, AMNESIA_HOME: storeDir };
    const armFlags = [];
    if (arm === "b") {
      armFlags.push("--settings", writeArmSettings(runDir));
    }
    if (MODEL) armFlags.push("--model", MODEL);

    const sessionId = randomUUID();
    const record = {
      arm,
      run,
      sessionId,
      projDir,
      storeDir,
      calls: [],
      probes: [],
      checks: {},
    };

    console.log(`\n=== ${label} (session ${sessionId.slice(0, 8)}) ===`);

    const seed = claude(
      ["-p", SCENARIO.seed[0], "--session-id", sessionId, "--output-format", "json", ...armFlags],
      { cwd: projDir, env }
    );
    record.calls.push({ step: "seed", ...seed });
    console.log(`seed: ${seed.failed ? "FAILED" : "ok"} (${seed.durationMs}ms)`);

    const filler = claude(
      ["-p", SCENARIO.filler[0], "--resume", sessionId, "--output-format", "json", ...armFlags],
      { cwd: projDir, env }
    );
    record.calls.push({ step: "filler", ...filler });
    console.log(`filler: ${filler.failed ? "FAILED" : "ok"}`);

    const compact = claude(
      ["-p", "/compact", "--resume", sessionId, "--output-format", "json", ...armFlags],
      { cwd: projDir, env }
    );
    record.calls.push({ step: "compact", ...compact });
    const tp = transcriptFor(projDir, sessionId);
    const boundaries = countIn(tp, "compact_boundary");
    record.checks.boundaries = boundaries;
    record.checks.models = modelsInFile(tp);
    console.log(
      `compact: boundaries=${boundaries} models=${record.checks.models.join(",")}`
    );

    for (const p of probes) {
      const r = claude(
        ["-p", p.question, "--resume", sessionId, "--output-format", "json", ...armFlags],
        { cwd: projDir, env }
      );
      const text = r.result || "";
      record.probes.push({
        id: p.id,
        kind: p.kind,
        question: p.question,
        answer: text.slice(0, 4000),
        passed: score(text, p),
        failed: r.failed,
      });
      record.calls.push({ step: `probe:${p.id}`, ...r });
    }

    const injections = countIn(tp, "[amnesia]");
    record.checks.injections = injections;
    let snapshotFiles = 0;
    try {
      snapshotFiles = readdirSync(join(storeDir, encodeProjectPath(projDir), "snapshots")).filter((f) =>
        f.endsWith(".md")
      ).length;
    } catch {}
    record.checks.snapshots = snapshotFiles;
    record.cost = record.calls.reduce((s, c) => s + (c.cost || 0), 0);
    record.passed = record.probes.filter((p) => p.passed).length;
    record.total = record.probes.length;
    console.log(`result: ${record.passed}/${record.total} · injections=${injections} · snapshots=${snapshotFiles} · $${record.cost.toFixed(2)}`);

    allRuns.push(record);
    writeFileSync(
      join(runDir, "run.json"),
      JSON.stringify(record, null, 2)
    );
  }
}

const byArm = {};
for (const arm of ARMS) {
  const runs = allRuns.filter((r) => r.arm === arm);
  byArm[arm] = {
    runs: runs.length,
    pass: runs.reduce((s, r) => s + r.passed, 0),
    total: runs.reduce((s, r) => s + r.total, 0),
    cost: runs.reduce((s, r) => s + r.cost, 0),
    valid: runs.filter((r) => r.checks.boundaries > 0 && (arm === "a" || r.checks.injections > 0)).length,
  };
}

const lines = [];
lines.push("# Bench results — compaction retention");
lines.push("");
lines.push(`Run: ${stamp} · scenario: ${SCENARIO.name}${SMOKE ? " (smoke)" : ""}`);
lines.push("");
lines.push("| arm | runs | valid | probes passed | total | cost |");
lines.push("|-----|------|-------|---------------|-------|------|");
for (const arm of ARMS) {
  const a = byArm[arm];
  lines.push(`| ${arm} | ${a.runs} | ${a.valid} | ${a.pass} | ${a.total} | $${a.cost.toFixed(2)} |`);
}
lines.push("");
lines.push("## Per probe");
lines.push("");
lines.push(`| probe | ${ARMS.map((a) => `arm ${a}`).join(" | ")} |`);
lines.push(`|-------|${ARMS.map(() => "------").join("|")}|`);
for (const p of probes) {
  const cells = ARMS.map((arm) => {
    const runs = allRuns.filter((r) => r.arm === arm);
    const pass = runs.filter(
      (r) => r.probes.find((x) => x.id === p.id)?.passed
    ).length;
    return `${pass}/${runs.length}`;
  });
  lines.push(`| ${p.id} | ${cells.join(" | ")} |`);
}
lines.push("");
lines.push("## Validity checks (per run)");
lines.push("");
for (const r of allRuns) {
  lines.push(
    `- ${r.arm}-${r.run}: boundaries=${r.checks.boundaries} injections=${r.checks.injections} snapshots=${r.checks.snapshots} models=${(r.checks.models || []).join(",")}`
  );
}
writeFileSync(join(RES, "summary.md"), lines.join("\n"));
writeFileSync(join(RES, "summary.json"), JSON.stringify({ byArm, runs: allRuns }, null, 2));
console.log(`\n${lines.join("\n")}`);
console.log(`\nresults: ${RES}`);
