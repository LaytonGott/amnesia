import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { encodeProjectPath } from "../src/claude.mjs";
import { HOOK_EVENTS, makeHookEntry } from "../src/hooks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const RUNS = Number(arg("--runs", "3"));
const ARMS = arg("--arms", "a,b").split(",").map((s) => s.trim());
const SMOKE = argv.includes("--smoke");
const MODEL = arg("--model", null);
const KEEP_MCP = argv.includes("--keep-mcp");
const SCENARIO_PATH = resolve(arg("--scenario", join(HERE, "scenario.json")));
const SCENARIO = JSON.parse(readFileSync(SCENARIO_PATH, "utf8"));

const steps =
  SCENARIO.steps ||
  [
    ...(SCENARIO.seed || []).map((text) => ({ kind: "say", text })),
    ...(SCENARIO.filler || []).map((text) => ({ kind: "say", text })),
    { kind: "compact" },
  ];
const probeMode = SCENARIO.probe_mode || "inline";

let probes = SCENARIO.probes;
if (SMOKE) {
  probes = probes.slice(0, 3);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const RES = join(HERE, "results", `${stamp}-${SCENARIO.name}`);
mkdirSync(RES, { recursive: true });

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

function modelsInFile(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const set = new Set();
  for (const m of text.matchAll(/"model"\s*:\s*"(claude[^"]+)"/g)) {
    set.add(m[1]);
  }
  return [...set];
}

function score(text, spec) {
  const t = text || "";
  const has = (p) => new RegExp(p, "is").test(t);
  if (spec.all && !spec.all.every(has)) return false;
  if (spec.any && !spec.any.some(has)) return false;
  if (spec.ban && spec.ban.some(has)) return false;
  return true;
}

function splitNumbered(text) {
  const parts = {};
  const re = /^\s*(\d{1,2})[.)]\s/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text || "")) !== null) {
    marks.push({ start: m.index, end: m.index + m[0].length, num: Number(m[1]) });
  }
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const to = i + 1 < marks.length ? marks[i + 1].start : (text || "").length;
    parts[marks[i].num] = text.slice(from, to).trim();
  }
  return parts;
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
    if (!KEEP_MCP) {
      const mcpEmpty = join(runDir, "mcp-empty.json");
      writeFileSync(mcpEmpty, JSON.stringify({ mcpServers: {} }));
      armFlags.push("--strict-mcp-config", "--mcp-config", mcpEmpty);
    }

    const sessionId = randomUUID();
    const record = {
      arm,
      run,
      scenario: SCENARIO.name,
      sessionId,
      projDir,
      storeDir,
      calls: [],
      probes: [],
      checks: {},
    };

    console.log(`\n=== ${label} (session ${sessionId.slice(0, 8)}) ===`);

    let first = true;
    for (const step of steps) {
      if (step.kind === "say") {
        const args = ["-p", step.text, "--output-format", "json", ...armFlags];
        if (first) {
          args.push("--session-id", sessionId);
          first = false;
        } else {
          args.push("--resume", sessionId);
        }
        const r = claude(args, { cwd: projDir, env });
        record.calls.push({ step: "say", ...r });
        console.log(`say: ${r.failed ? "FAILED" : "ok"} ($${(r.cost || 0).toFixed(2)})`);
        if (first === false && r.failed) break;
      } else if (step.kind === "compact") {
        const r = claude(
          ["-p", "/compact", "--resume", sessionId, "--output-format", "json", ...armFlags],
          { cwd: projDir, env }
        );
        record.calls.push({ step: "compact", ...r });
        console.log(`compact: ${r.failed ? "FAILED" : "ok"} ($${(r.cost || 0).toFixed(2)})`);
      }
    }

    const tp = transcriptFor(projDir, sessionId);
    record.checks.boundaries = countIn(tp, "compact_boundary");
    record.checks.models = modelsInFile(tp);
    record.checks.injections = countIn(tp, "[amnesia]");
    let snapshotFiles = 0;
    try {
      snapshotFiles = readdirSync(
        join(storeDir, encodeProjectPath(projDir), "snapshots")
      ).filter((f) => f.endsWith(".md")).length;
    } catch {}
    record.checks.snapshots = snapshotFiles;

    if (probeMode === "batch") {
      let seq = 0;
      const qlines = [];
      for (const p of probes) {
        if (p.scope === "global") continue;
        seq++;
        p._n = seq;
        qlines.push(`${seq}. ${p.question}`);
      }
      const q =
        `Answer every question below, in order. Format each answer as "N. <answer>" ` +
        `on its own line, nothing else. Keep each answer under 25 words.\n\n${qlines.join("\n")}`;
      const r = claude(
        ["-p", q, "--resume", sessionId, "--output-format", "json", ...armFlags],
        { cwd: projDir, env }
      );
      record.calls.push({ step: "probe_batch", ...r });
      const raw = r.result || "";
      record.batchRaw = raw.slice(0, 12000);
      const parts = splitNumbered(raw);
      for (const p of probes) {
        const slice = p.scope === "global" ? raw : parts[p._n] || "";
        record.probes.push({
          id: p.id,
          question: p.question,
          answer: slice.slice(0, 2000),
          passed: !r.failed && slice !== "" && score(slice, p),
          failed: r.failed,
        });
      }
      console.log(`probe_batch: ${r.failed ? "FAILED" : "ok"} ($${(r.cost || 0).toFixed(2)})`);
    } else {
      for (const p of probes) {
        const r = claude(
          ["-p", p.question, "--resume", sessionId, "--output-format", "json", ...armFlags],
          { cwd: projDir, env }
        );
        const text = r.result || "";
        record.probes.push({
          id: p.id,
          question: p.question,
          answer: text.slice(0, 4000),
          passed: !r.failed && score(text, p),
          failed: r.failed,
        });
        record.calls.push({ step: `probe:${p.id}`, ...r });
      }
    }

    record.cost = record.calls.reduce((s, c) => s + (c.cost || 0), 0);
    record.passed = record.probes.filter((p) => p.passed).length;
    record.total = record.probes.length;
    console.log(
      `result: ${record.passed}/${record.total} · boundaries=${record.checks.boundaries} · injections=${record.checks.injections} · snapshots=${record.checks.snapshots} · models=${record.checks.models.join(",")} · $${record.cost.toFixed(2)}`
    );

    allRuns.push(record);
    writeFileSync(join(runDir, "run.json"), JSON.stringify(record, null, 2));
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
    valid: runs.filter(
      (r) =>
        r.checks.boundaries > 0 &&
        (arm === "a" || (r.checks.injections > 0 && r.checks.snapshots > 0))
    ).length,
  };
}

const out = [];
out.push(`# Bench results — ${SCENARIO.name}`);
out.push("");
out.push(`Run: ${stamp}${SMOKE ? " (smoke)" : ""} · probes: ${probes.length} (${probeMode})`);
out.push("");
out.push("| arm | runs | valid | probes passed | total | cost |");
out.push("|-----|------|-------|---------------|-------|------|");
for (const arm of ARMS) {
  const a = byArm[arm];
  out.push(`| ${arm} | ${a.runs} | ${a.valid} | ${a.pass} | ${a.total} | $${a.cost.toFixed(2)} |`);
}
out.push("");
out.push("## Per probe");
out.push("");
out.push(`| probe | ${ARMS.map((a) => `arm ${a}`).join(" | ")} |`);
out.push(`|-------|${ARMS.map(() => "------").join("|")}|`);
for (const p of probes) {
  const cells = ARMS.map((arm) => {
    const runs = allRuns.filter((r) => r.arm === arm);
    const pass = runs.filter(
      (r) => r.probes.find((x) => x.id === p.id)?.passed
    ).length;
    return `${pass}/${runs.length}`;
  });
  out.push(`| ${p.id} | ${cells.join(" | ")} |`);
}
out.push("");
out.push("## Validity checks (per run)");
out.push("");
for (const r of allRuns) {
  out.push(
    `- ${r.arm}-${r.run}: boundaries=${r.checks.boundaries} injections=${r.checks.injections} snapshots=${r.checks.snapshots} models=${(r.checks.models || []).join(",")}`
  );
}
writeFileSync(join(RES, "summary.md"), out.join("\n"));
writeFileSync(
  join(RES, "summary.json"),
  JSON.stringify({ byArm, runs: allRuns }, null, 2)
);
console.log(`\n${out.join("\n")}`);
console.log(`\nresults: ${RES}`);
