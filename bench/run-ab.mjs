// Behavioral A/B for the compaction plugin: does an agent recall exact
// details better after a compaction when plugin/ appended its block?
//
//   node bench/run-ab.mjs [--reps 5] [--model sonnet] [--out <dir>]
//
// Protocol (headless Claude Code, nothing installed, your settings untouched):
//   1. Build a scratch project: 10 large files (~70 KB each), each hiding one
//      fact; 10 more facts are stated by the "user" in the prompts.
//   2. Seed ONE session over 10 turns: each turn states facts and asks the
//      agent to look one up in a file (Read only). ~200k tokens of context.
//   3. Per arm and rep, fork the seeded session and run a plain `/compact`
//      (no instructions): arm A without the plugin, arm C with --plugin-dir.
//   4. Probe the fork once with tools disabled: 20 exact-detail questions,
//      answered as JSON, "unknown" allowed. Deterministic scoring.
// Confounds removed: auto-memory off, user settings/plugins and MCP servers
// not loaded, tools off at probe time (so nothing can be re-read from disk
// or from the transcript path the summary now mentions).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, "..", "plugin");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const REPS = Number(opt("reps", 5));
const MODEL = opt("model", "sonnet");
const OUT = resolve(opt("out", join(HERE, "results", `ab-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`)));
const PROJ = join(OUT, "proj");

// ---- scenario ---------------------------------------------------------------

const STATED = [
  { id: "F1", say: "Pin the release to commit 4e9b1c27d.", q: "Which commit is the release pinned to?", a: "4e9b1c27d" },
  { id: "F2", say: "The feature toggle env var is LEDGER_SYNC_MODE_V2.", q: "What is the feature toggle env var name?", a: "LEDGER_SYNC_MODE_V2" },
  { id: "F3", say: "Staging API listens on port 18443.", q: "Which port does the staging API listen on?", a: "18443" },
  { id: "F4", say: "Track all of this under ticket OPS-77412.", q: "Which ticket is this work tracked under?", a: "OPS-77412" },
  { id: "F5", say: "Our deploy region is ap-southeast-3b.", q: "What is the deploy region?", a: "ap-southeast-3b" },
  { id: "F6", say: "Pin pydantic to 2.7.4 everywhere.", q: "Which pydantic version is pinned?", a: "2.7.4" },
  { id: "F7", say: "Build artifacts go to s3://ledger-artifacts-eu-7731/builds.", q: "Where do build artifacts go (full URI)?", a: "s3://ledger-artifacts-eu-7731/builds" },
  { id: "F8", say: "The next migration is 0193_add_ledger_holds.", q: "What is the next migration's full name?", a: "0193_add_ledger_holds" },
  { id: "F9", say: "The incident status page is https://status.example-ledger.io/incidents/5519.", q: "What is the incident status page URL?", a: "https://status.example-ledger.io/incidents/5519" },
  { id: "F10", say: "On-call owner is @mkovacs-ledger.", q: "Who is the on-call owner (handle)?", a: "@mkovacs-ledger" },
];

const HIDDEN = [
  { id: "F11", file: "services/billing/config.yaml", line: "settlement_retry_timeout_ms: 7350", ask: "the settlement_retry_timeout_ms value", q: "What is settlement_retry_timeout_ms in the billing config?", a: "7350" },
  { id: "F12", file: "services/cache/settings.toml", line: "hot_path_ttl_seconds = 5420", ask: "the hot_path_ttl_seconds value", q: "What is hot_path_ttl_seconds in the cache settings?", a: "5420" },
  { id: "F13", file: "logs/ledger-2026-10-01.log", line: "2026-10-01T04:12:09Z FATAL svc=ledger code=E-LEDGER-4471 msg=hold table locked", ask: "the error code of the only FATAL line", q: "What error code did the only FATAL log line carry?", a: "E-LEDGER-4471" },
  { id: "F14", file: "services/db/conn.env", line: "PRIMARY_REPLICA_HOST=pg-ledger-replica-09.internal", ask: "the PRIMARY_REPLICA_HOST value", q: "What is PRIMARY_REPLICA_HOST in the db env file?", a: "pg-ledger-replica-09.internal" },
  { id: "F15", file: "services/queue/topology.json", line: '  "dead_letter_queue": "ledger.events.v3.dlq",', ask: "the dead_letter_queue name", q: "What is the dead-letter queue name in the queue topology?", a: "ledger.events.v3.dlq" },
  { id: "F16", file: "services/gateway/limits.yaml", line: "partner_burst_max_rps: 2875", ask: "the partner_burst_max_rps value", q: "What is partner_burst_max_rps in the gateway limits?", a: "2875" },
  { id: "F17", file: "config/flags.json", line: '  "release_gate_key": "ff_ledger_hold_release_2026q4",', ask: "the release_gate_key", q: "What is the release_gate_key feature flag key?", a: "ff_ledger_hold_release_2026q4" },
  { id: "F18", file: "certs/inventory.txt", line: "edge-gateway cert_serial=6A:3F:91:0C:5D", ask: "the edge-gateway cert_serial", q: "What is the edge-gateway cert serial?", a: "6A:3F:91:0C:5D" },
  { id: "F19", file: "ci/build-history.txt", line: "LAST_GREEN_BUILD=88213", ask: "the LAST_GREEN_BUILD number", q: "What is the last green build number?", a: "88213" },
  { id: "F20", file: "jobs/reconcile.cron", line: "17 3 * * 2 /opt/ledger/bin/reconcile --holds   # weekly hold reconcile", ask: "the schedule (first five fields) of the weekly hold reconcile job", q: "What is the cron schedule (five fields) of the weekly hold reconcile job?", a: "17 3 * * 2" },
];

// deterministic filler so every run sees the same files
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// --facts 100: many details competing for the summary, as in a long session.
// 70 more stated facts (35 services x 2 attributes) and a second hidden line
// per file. --facts 20 is the salient-facts smoke scenario above.
const FACTS = Number(opt("facts", 100));
const MORE_STATED = [];
const MORE_HIDDEN = [];
if (FACTS === 100) {
  const r = rng(77);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");
  const num = (lo, hi) => lo + Math.floor(r() * (hi - lo));
  const A = "acme brisk cobalt delta ember fjord granite harbor iris juniper kestrel lumen maple nimbus onyx".split(" ");
  const B = "billing payouts holds refunds ledger audit search notify export import intake router".split(" ");
  const services = [];
  for (const a of A) for (const b of B) if (services.length < 35 && r() < 0.3) services.push(`${a}-${b}`);
  while (services.length < 35) services.push(`${A[services.length % A.length]}-svc${services.length}`);
  const ATTRS = [
    ["staging port", () => String(num(10000, 65000))],
    ["pinned commit", () => hex(9)],
    ["owner handle", () => `@${A[num(0, A.length)]}-${hex(3)}`],
    ["tracking ticket", () => `OPS-${num(10000, 99999)}`],
    ["deploy region", () => `${["eu", "us", "ap", "sa"][num(0, 4)]}-${["west", "east", "north", "south"][num(0, 4)]}-${num(1, 9)}${"abc"[num(0, 3)]}`],
    ["pinned SDK version", () => `${num(1, 9)}.${num(0, 30)}.${num(0, 20)}`],
    ["artifact bucket", () => `s3://${hex(4)}-artifacts-${num(100, 999)}/drop`],
    ["feature env var", () => `${["LEDGER", "HOLDS", "PAYOUT", "AUDIT"][num(0, 4)]}_${["SYNC", "FAST", "SAFE", "BULK"][num(0, 4)]}_MODE_${num(10, 99)}`],
  ];
  let id = 21;
  services.forEach((svc, k) => {
    for (const [name, gen] of [ATTRS[k % 8], ATTRS[(k + 3) % 8]]) {
      const v = gen();
      MORE_STATED.push({ id: `F${id++}`, say: `For ${svc}, the ${name} is ${v}.`, q: `What is the ${name} for ${svc}?`, a: v, owner: svc });
    }
  });
  const extra = [
    ["chargeback_hold_days: 41", "chargeback_hold_days", "41"],
    ["cold_path_ttl_seconds = 980", "cold_path_ttl_seconds", "980"],
    ["2026-10-01T05:40:51Z ERROR svc=ledger code=E-LEDGER-5102 msg=hold release lagging", "the error code of the only ERROR line", "E-LEDGER-5102"],
    ["AUDIT_REPLICA_HOST=pg-audit-replica-03.internal", "AUDIT_REPLICA_HOST", "pg-audit-replica-03.internal"],
    ['  "retry_queue": "ledger.events.v3.retry-7",', "the retry_queue name", "ledger.events.v3.retry-7"],
    ["partner_sustained_max_rps: 1190", "partner_sustained_max_rps", "1190"],
    ['  "kill_switch_key": "ff_ledger_kill_holds_v2",', "the kill_switch_key", "ff_ledger_kill_holds_v2"],
    ["admin-portal cert_serial=4B:77:0E:A2:19", "the admin-portal cert_serial", "4B:77:0E:A2:19"],
    ["LAST_RED_BUILD=88197", "LAST_RED_BUILD", "88197"],
    ["41 22 * * 5 /opt/ledger/bin/export --payouts   # friday payout export", "the schedule (five fields) of the friday payout export job", "41 22 * * 5"],
  ];
  extra.forEach(([line, ask, a], k) => {
    MORE_HIDDEN.push({ id: `F${91 + k}`, file: HIDDEN[k].file, line, ask, q: `In ${HIDDEN[k].file}, what is ${ask.replace(/^the /, "")}?`, a });
  });
}
const WORDS = "ledger hold settle batch queue shard replica cache gateway partner tenant invoice refund payout audit retry window lease token cursor".split(" ");
function filler(file, r) {
  const ext = file.split(".").pop();
  const pick = (a) => a[Math.floor(r() * a.length)];
  const n = () => Math.floor(r() * 90000);
  const key = () => `${pick(WORDS)}_${pick(WORDS)}_${pick(["ms", "count", "max", "min", "ratio", "size"])}`;
  switch (ext) {
    case "log":
      return () => `2026-10-01T0${Math.floor(r() * 9)}:${String(Math.floor(r() * 60)).padStart(2, "0")}:${String(Math.floor(r() * 60)).padStart(2, "0")}Z ${pick(["INFO", "WARN", "DEBUG"])} svc=${pick(WORDS)} req=${n().toString(16)} ${pick(WORDS)}=${n()} code=W-${pick(WORDS).toUpperCase()}-${n() % 9000}`;
    case "env":
      return () => `${key().toUpperCase()}=${pick(WORDS)}-${n() % 97}.internal`;
    case "json":
      return () => `  "${key()}": "${pick(WORDS)}.${pick(WORDS)}.v${n() % 9}",`;
    case "toml":
      return () => `${key()} = ${n()}`;
    case "cron":
      return () => `${n() % 60} ${n() % 24} * * ${n() % 7} /opt/ledger/bin/${pick(WORDS)} --${pick(WORDS)}   # ${pick(WORDS)} ${pick(WORDS)}`;
    case "txt":
      return () => `${pick(WORDS)}-${pick(WORDS)} ${key()}=${n()} build=${n()} serial=${n().toString(16).toUpperCase()}`;
    default:
      return () => `${key()}: ${n()}`;
  }
}
function buildProject() {
  HIDDEN.forEach((f, k) => {
    const r = rng(1000 + k);
    const gen = filler(f.file, r);
    const lines = [];
    const at = 200 + Math.floor(r() * 800);
    const more = MORE_HIDDEN.find((m) => m.file === f.file);
    const at2 = more ? (at + 150 + Math.floor(r() * 200)) % 1200 : -1;
    for (let i = 0; i < 1200; i++) lines.push(i === at ? f.line : i === at2 ? more.line : gen());
    const p = join(PROJ, f.file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.join("\n") + "\n");
  });
}

// ---- headless calls ---------------------------------------------------------

const BASE = [
  "--output-format", "json",
  "--model", MODEL,
  "--setting-sources", "project,local",
  "--strict-mcp-config",
  "--settings", JSON.stringify({ autoMemoryEnabled: false }),
];
// total_cost_usd is cumulative per session lineage (a resume or fork carries
// its parent's spend), so the cost of one call is the delta from its parent
let spent = 0;
const costOf = new Map();
function claude(extra, label) {
  let raw = "";
  try {
    raw = execFileSync("claude", ["-p", ...extra, ...BASE], {
      cwd: PROJ,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15 * 60 * 1000,
    });
  } catch (e) {
    raw = String(e.stdout || "");
    if (!raw) throw new Error(`${label}: ${e.message}`);
  }
  const j = JSON.parse(raw.slice(raw.indexOf("{")));
  const parent = extra.includes("--resume") ? extra[extra.indexOf("--resume") + 1] : null;
  const total = j.total_cost_usd || 0;
  const cost = Math.max(0, total - (parent ? (costOf.get(parent) ?? 0) : 0));
  costOf.set(j.session_id, total);
  spent += cost;
  console.log(`  ${label}: ${j.is_error ? "ERROR " : ""}$${cost.toFixed(3)} (total $${spent.toFixed(2)})`);
  if (j.is_error) throw new Error(`${label}: ${j.result}`);
  return j;
}

function transcriptOf(sessionId) {
  const root = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(root)) {
    const p = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- scoring ----------------------------------------------------------------

const ALL = [...STATED, ...HIDDEN, ...MORE_STATED, ...MORE_HIDDEN].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
// what a value belongs to, for checking a block line binds the two (bench/replay-ab.mts)
const BASE_OWNER = { F1: "commit", F2: "env var", F3: "port", F4: "ticket", F5: "region", F6: "pydantic", F7: "artifacts", F8: "migration", F9: "status", F10: "on-call" };
for (const f of ALL) {
  if (f.owner) continue;
  if (BASE_OWNER[f.id]) f.owner = BASE_OWNER[f.id];
  else if (f.line) f.owner = (f.line.match(/^([\w-]+) cert_serial/) ?? f.line.match(/^\s*"?([A-Za-z_][\w-]*)"?\s*[:=]/) ?? f.line.match(/\b(FATAL|ERROR|cert_serial|reconcile|export)\b/) ?? [])[1] ?? null;
}
const STATED_IDS = new Set([...STATED, ...MORE_STATED].map((f) => f.id));
const N = ALL.length;
const norm = (s) => String(s ?? "").toLowerCase().replace(/[`"'\s]+/g, " ").trim();
function score(answerText) {
  let obj = {};
  const m = answerText.match(/\{[\s\S]*\}/);
  try {
    obj = m ? JSON.parse(m[0]) : {};
  } catch {}
  return ALL.map((f) => ({ id: f.id, expected: f.a, got: obj[f.id] ?? null, ok: norm(obj[f.id]).includes(norm(f.a)) }));
}

// ---- run ----------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "facts.json"), JSON.stringify(ALL.map(({ id, q, a, owner }) => ({ id, q, a, owner })), null, 2));

if (args.includes("--dry")) {
  const dup = ALL.map((f) => f.a).filter((a, i, xs) => xs.indexOf(a) !== i);
  console.log(`${N} facts, ${STATED_IDS.size} stated; duplicate answers: ${dup.length ? dup.join(", ") : "none"}`);
  for (let t = 0; t < 10; t++) {
    const said = [STATED[t], ...MORE_STATED.slice(t * 7, t * 7 + 7)].map((s) => s.say).join(" ");
    const h2 = MORE_HIDDEN[t];
    console.log(`turn ${t + 1}: ${said} Now read ${HIDDEN[t].file} and tell me ${HIDDEN[t].ask}${h2 ? ` and ${h2.ask}` : ""}.`);
  }
  console.log(ALL.slice(-12).map((f) => `${f.id}: ${f.q} -> ${f.a}`).join("\n"));
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
buildProject();
console.log(`out ${OUT}\nmodel ${MODEL}, reps ${REPS} per arm`);

const seedPath = join(OUT, "seed.json");
let seedId;
if (existsSync(seedPath)) {
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  seedId = seed.sessionId;
  costOf.set(seedId, seed.cost ?? 0);
  console.log(`reusing seeded session ${seedId}`);
} else {
  console.log("seeding");
  let sid = null;
  for (let t = 0; t < 10; t++) {
    const said = [STATED[t], ...MORE_STATED.slice(t * 7, t * 7 + 7)].map((s) => s.say).join(" ");
    const h = HIDDEN[t];
    const h2 = MORE_HIDDEN[t];
    const prompt =
      (t === 0 ? "We're preparing the ledger-holds release; I'll give you details as we go. " : "") +
      `${said} Now read ${h.file} and tell me ${h.ask}${h2 ? ` and ${h2.ask}` : ""}. Answer in one short line.`;
    const j = claude(
      [prompt, "--tools", "Read", "--allowedTools", "Read", ...(sid ? ["--resume", sid] : [])],
      `seed ${t + 1}/10`
    );
    sid = j.session_id;
  }
  seedId = sid;
  writeFileSync(seedPath, JSON.stringify({ sessionId: seedId, cost: costOf.get(seedId), transcript: transcriptOf(seedId) }, null, 2));
}

const probe =
  "Answer from memory only; you have no tools. For each question give the exact value, " +
  'or "unknown" if you do not know it. Do not guess. Reply with one JSON object keyed by id.\n' +
  ALL.map((f) => `${f.id}: ${f.q}`).join("\n");

// --tag names a fresh batch over the same seeded session (runs-<tag>.json)
const TAG = opt("tag", "");
// --compact-instructions forces a lossy summary in every run (a stress condition:
// it tests what the block carries and binds when the summary loses, both arms alike)
const COMPACT_INSTR = opt("compact-instructions", "");
const MAX_SPEND = Number(opt("max-spend", Infinity));
const runsPath = join(OUT, TAG ? `runs-${TAG}.json` : "runs.json");
const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, "utf8")) : [];
for (let rep = 1; rep <= REPS; rep++) {
  for (const arm of ["A", "C"]) {
    if (runs.some((r) => r.arm === arm && r.rep === rep)) continue;
    if (spent >= MAX_SPEND) {
      console.log(`stopping: spent $${spent.toFixed(2)} of the $${MAX_SPEND} cap`);
      break;
    }
    console.log(`arm ${arm} rep ${rep}`);
    const plug = arm === "C" ? ["--plugin-dir", PLUGIN] : [];
    const c = claude([COMPACT_INSTR ? `/compact ${COMPACT_INSTR}` : "/compact", "--resume", seedId, "--fork-session", ...plug], `compact ${arm}${rep}`);
    const forkId = c.session_id;
    const p = claude([probe, "--resume", forkId, "--tools", "", ...plug], `probe ${arm}${rep}`);
    const tp = transcriptOf(forkId);
    const text = tp ? readFileSync(tp, "utf8") : "";
    const rows = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const bIdx = rows.findIndex((o) => o.subtype === "compact_boundary");
    const after = bIdx >= 0 ? rows.slice(bIdx) : [];
    const summary = after.find((o) => o.isCompactSummary);
    const block = after.find((o) => o.type === "user" && JSON.stringify(o.message?.content ?? "").includes("[amnesia]"));
    const content = (o) => (typeof o?.message?.content === "string" ? o.message.content : (o?.message?.content ?? []).map((b) => b.text ?? "").join(""));
    const results = score(p.result || "");
    const sumText = content(summary);
    const blockText = content(block);
    runs.push({
      arm,
      rep,
      forkId,
      valid: bIdx >= 0 && (arm === "A" ? !block : !!block),
      boundary: bIdx >= 0 ? rows[bIdx].compactMetadata : null,
      inSummary: ALL.filter((f) => sumText.includes(f.a)).map((f) => f.id),
      inBlock: ALL.filter((f) => blockText.includes(f.a)).map((f) => f.id),
      correct: results.filter((r) => r.ok).map((r) => r.id),
      results,
      answer: p.result,
    });
    writeFileSync(runsPath, JSON.stringify(runs, null, 2));
    const last = runs.at(-1);
    console.log(`  valid=${last.valid} inSummary=${last.inSummary.length}/${N} inBlock=${last.inBlock.length}/${N} correct=${last.correct.length}/${N}`);
  }
}

// ---- summary ------------------------------------------------------------------

const valid = runs.filter((r) => r.valid);
const md = [`# Compaction plugin A/B (${new Date().toISOString().slice(0, 10)})`, "", `model ${MODEL}; ${valid.length}/${runs.length} valid runs; spent this invocation $${spent.toFixed(2)}`, ""];
md.push(`| arm | runs | correct (mean of ${N}) | stated (${STATED_IDS.size}) | looked up (${N - STATED_IDS.size}) | in summary | in block | correct, not in summary |`, "|---|---|---|---|---|---|---|---|");
for (const arm of ["A", "C"]) {
  const rs = valid.filter((r) => r.arm === arm);
  if (!rs.length) continue;
  const mean = (f) => (rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(1);
  md.push(`| ${arm} | ${rs.length} | ${mean((r) => r.correct.length)} | ${mean((r) => r.correct.filter((id) => STATED_IDS.has(id)).length)} | ${mean((r) => r.correct.filter((id) => !STATED_IDS.has(id)).length)} | ${mean((r) => r.inSummary.length)} | ${mean((r) => r.inBlock.length)} | ${mean((r) => r.correct.filter((id) => !r.inSummary.includes(id)).length)} |`);
}
// the comparison that matters: recall on the facts each run's summary dropped
md.push("", "Recall on facts the summary dropped (the only facts the block can affect):", "");
md.push("| arm | lossy runs | facts dropped | carried by block | recalled | recalled of carried | recalled of not carried |", "|---|---|---|---|---|---|---|");
for (const arm of ["A", "C"]) {
  const rs = valid.filter((r) => r.arm === arm);
  let lossy = 0, dropped = 0, carried = 0, recalled = 0, recCarried = 0, recNot = 0;
  for (const r of rs) {
    const lost = ALL.map((f) => f.id).filter((id) => !r.inSummary.includes(id));
    if (lost.length) lossy++;
    for (const id of lost) {
      dropped++;
      const inB = r.inBlock.includes(id);
      const ok = r.correct.includes(id);
      if (inB) carried++;
      if (ok) recalled++;
      if (ok && inB) recCarried++;
      if (ok && !inB) recNot++;
    }
  }
  md.push(`| ${arm} | ${lossy}/${rs.length} | ${dropped} | ${carried} | ${recalled} | ${recCarried}/${carried} | ${recNot}/${dropped - carried} |`);
}
md.push("", "Per fact (correct runs / valid runs):", "", "| fact | A | C |", "|---|---|---|");
for (const f of ALL) {
  const c = (arm) => `${valid.filter((r) => r.arm === arm && r.correct.includes(f.id)).length}/${valid.filter((r) => r.arm === arm).length}`;
  md.push(`| ${f.id} ${f.a} | ${c("A")} | ${c("C")} |`);
}
writeFileSync(join(OUT, TAG ? `summary-${TAG}.md` : "summary.md"), md.join("\n") + "\n");
console.log("\n" + md.join("\n"));
