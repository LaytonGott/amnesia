// Live check of the recall tool: the same seeded session (bench/run-ab.mjs
// --facts 100) is compacted with a summary told to keep almost nothing and a
// 1,000-char block, so recall has to do the work; arm R has recall, arm B has
// it turned off. Then 20 exact-detail questions, with recall as the only tool.
//
//   node bench/run-recall.mjs [--out bench/results/ab-100] [--max-spend 2]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = resolve(opt("out", join(HERE, "results", "ab-100")));
const MAX = Number(opt("max-spend", 2));
const PROJ = join(OUT, "proj");
const PLUGIN = resolve(HERE, "..", "plugin");
const seed = JSON.parse(readFileSync(join(OUT, "seed.json"), "utf8"));
const facts = JSON.parse(readFileSync(join(OUT, "facts.json"), "utf8"));
const PICK = ["F3", "F7", "F11", "F12", "F13", "F14", "F15", "F16", "F18", "F21", "F30", "F37", "F44", "F52", "F60", "F68", "F75", "F88", "F94", "F99"];
const asked = facts.filter((f) => PICK.includes(f.id));
const NO_BUILTINS = "Read,Bash,Grep,Glob,Edit,Write,WebFetch,WebSearch,Task,NotebookEdit,PowerShell";
const LOSSY ="Keep this summary to five sentences. Do not list identifiers, values, versions, ports, hashes, names or file contents.";

let spent = 0;
const costOf = new Map([[seed.sessionId, seed.cost ?? 0]]);
function claude(extra, settings, label) {
  if (spent >= MAX) throw new Error(`spend cap $${MAX} reached`);
  let raw = "";
  try {
    raw = execFileSync("claude", ["-p", ...extra, "--output-format", "json", "--model", "sonnet",
      "--setting-sources", "project,local", "--strict-mcp-config", "--plugin-dir", PLUGIN,
      "--settings", JSON.stringify(settings)], { cwd: PROJ, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], timeout: 900000 });
  } catch (e) {
    raw = String(e.stdout || "");
    if (!raw) throw e;
  }
  const j = JSON.parse(raw.slice(raw.indexOf("{")));
  const parent = extra.includes("--resume") ? extra[extra.indexOf("--resume") + 1] : null;
  const cost = Math.max(0, (j.total_cost_usd || 0) - (parent ? costOf.get(parent) ?? 0 : 0));
  costOf.set(j.session_id, j.total_cost_usd || 0);
  spent += cost;
  console.log(`  ${label}: $${cost.toFixed(3)} (total $${spent.toFixed(2)})${j.is_error ? " ERROR " + j.result : ""}`);
  return j;
}
const transcript = (id) => {
  const root = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(root)) if (existsSync(join(root, d, `${id}.jsonl`))) return join(root, d, `${id}.jsonl`);
  return null;
};
const norm = (s) => String(s ?? "").toLowerCase().replace(/[`"'\s]+/g, " ").trim();

const probe =
  "Answer each question with the exact value, or \"unknown\". If a detail is not in front of you, " +
  "look it up with the amnesia recall tool before answering; do not guess. Reply with one JSON object keyed by id.\n" +
  asked.map((f) => `${f.id}: ${f.q}`).join("\n");

const results = {};
const answersOf = (p) => { try { return JSON.parse((p.result || "").match(/\{[\s\S]*\}/)?.[0] ?? "{}"); } catch { return {}; } };
const toolUsesAfterBoundary = (id) => {
  const rows = readFileSync(transcript(id), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const b = rows.map((o, i) => (o.subtype === "compact_boundary" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  return rows.slice(b + 1).flatMap((o) => (o.type === "assistant" && Array.isArray(o.message?.content) ? o.message.content : [])).filter((x) => x?.type === "tool_use").map((x) => String(x.name));
};

// --unprompted: the agent is never told recall exists or that it should look
// anything up; normal read tools stay available (no shell). One compaction,
// two probes from it: UB forks it with recall off, UR resumes it with recall on.
if (args.includes("--unprompted")) {
  const natural =
    "We're about to cut the ledger-holds release. Before I sign off, remind me of these exact values " +
    "(reply with one JSON object keyed by id; say \"unknown\" if you're not sure):\n" +
    asked.map((f) => `${f.id}: ${f.q}`).join("\n");
  const on = { autoMemoryEnabled: false, pluginConfigs: { "amnesia@inline": { options: { budgetChars: 1000, recall: true } } } };
  const off = { autoMemoryEnabled: false, pluginConfigs: { "amnesia@inline": { options: { budgetChars: 1000, recall: false } } } };
  const READ_ONLY = ["--disallowedTools", "Bash,PowerShell,WebFetch,WebSearch,Task,Edit,Write,NotebookEdit", "--allowedTools", "Read,Grep,Glob,mcp__amnesia__recall"];
  const c = claude([`/compact ${LOSSY}`, "--resume", seed.sessionId, "--fork-session"], on, "compact");
  for (const [arm, extra, settings] of [["UB", ["--resume", c.session_id, "--fork-session"], off], ["UR", ["--resume", c.session_id], on]]) {
    const p = claude([natural, ...extra, ...READ_ONLY], settings, `probe ${arm}`);
    const uses = toolUsesAfterBoundary(p.session_id);
    const ans = answersOf(p);
    const correct = asked.filter((f) => norm(ans[f.id]).includes(norm(f.a)));
    const tally = uses.reduce((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {});
    results[arm] = { session: p.session_id, correct: correct.length, of: asked.length, toolUses: tally, unknown: asked.filter((f) => norm(ans[f.id]) === "unknown").length };
    console.log(`  ${arm}: correct ${correct.length}/${asked.length}, unknown ${results[arm].unknown}, tools ${JSON.stringify(tally)}`);
  }
  writeFileSync(join(OUT, "recall-unprompted.json"), JSON.stringify({ spent, results }, null, 2));
  console.log(JSON.stringify({ spent: Number(spent.toFixed(2)), results }));
  process.exit(0);
}

for (const arm of ["R", "B"]) {
  console.log(`arm ${arm} (${arm === "R" ? "recall on" : "recall off"})`);
  const settings = { autoMemoryEnabled: false, pluginConfigs: { "amnesia@inline": { options: { budgetChars: 1000, recall: arm === "R" } } } };
  const c = claude([`/compact ${LOSSY}`, "--resume", seed.sessionId, "--fork-session"], settings, `compact ${arm}`);
  // built-in tools blocked one by one: `--tools ""` would remove the plugin's recall tool too.
  // Resumed without forking, so the session id (and its archive) stays the one compacted.
  const p = claude([probe, "--resume", c.session_id, "--disallowedTools", NO_BUILTINS, "--allowedTools", "mcp__amnesia__recall"], settings, `probe ${arm}`);
  const rows = readFileSync(transcript(c.session_id), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const calls = rows.flatMap((o) => (Array.isArray(o.message?.content) ? o.message.content : [])).filter((b) => b?.type === "tool_use" && String(b.name).includes("recall"));
  const summary = rows.find((o) => o.isCompactSummary);
  const sumText = typeof summary?.message?.content === "string" ? summary.message.content : (summary?.message?.content ?? []).map((b) => b.text ?? "").join("");
  let ans = {};
  try { ans = JSON.parse((p.result || "").match(/\{[\s\S]*\}/)?.[0] ?? "{}"); } catch {}
  const correct = asked.filter((f) => norm(ans[f.id]).includes(norm(f.a)));
  results[arm] = { fork: c.session_id, recallCalls: calls.length, inSummary: asked.filter((f) => sumText.includes(f.a)).length, correct: correct.length, of: asked.length };
  console.log(`  summary held ${results[arm].inSummary}/${asked.length}; recall calls ${calls.length}; correct ${correct.length}/${asked.length}`);
}
writeFileSync(join(OUT, "recall-check.json"), JSON.stringify({ spent, results }, null, 2));
console.log(JSON.stringify({ spent: Number(spent.toFixed(2)), results }));
