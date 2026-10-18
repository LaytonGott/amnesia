// Unasked loss: after a lossy compaction, does the agent use the right
// details in ordinary work when nobody asks it to remember anything?
//
//   node bench/run-unasked.mjs [--reps 1] [--start 0] [--out bench/results/ab-100] [--max-spend 12]
//   node bench/run-unasked.mjs --report
//
// The seeded session from bench/run-ab.mjs --facts 100 (~190k tokens) is
// forked and compacted with a summary told to keep almost nothing, then given
// a task: write two release env files. Each of the 20 slots needs a value that
// was only ever stated in the conversation (never in a project file), and the
// task never says anything was lost or asks to recall anything. Tools stay on
// (Read, Grep, Glob, Write, Edit), so the agent can still search the
// transcript Claude Code's summary points to.
//   arm A: Claude Code alone (no plugin)
//   arm C: with the amnesia plugin at its defaults (6,000-char block, recall on)
// Each slot scores correct, placeholder (TODO / blank / asks) or wrong (a
// value that is not the one stated: made up or confused).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = resolve(opt("out", join(HERE, "results", "ab-100")));
const RUNS = join(OUT, "unasked");
const PROJ = join(OUT, "proj");
const PLUGIN = resolve(HERE, "..", "plugin");
const REPS = Number(opt("reps", 1));
const START = Number(opt("start", 0));
const MAX = Number(opt("max-spend", 12));
const LOSSY = "Keep this summary to five sentences. Do not list identifiers, values, versions, ports, hashes, names or file contents.";

const facts = JSON.parse(readFileSync(join(OUT, "facts.json"), "utf8"));
const byId = new Map(facts.map((f) => [f.id, f]));
// file, key, fact id: the task names the slot, never the value
const SLOTS = [
  ["release.env", "RELEASE_COMMIT", "F1"],
  ["release.env", "FEATURE_TOGGLE_VAR", "F2"],
  ["release.env", "STAGING_API_PORT", "F3"],
  ["release.env", "TRACKING_TICKET", "F4"],
  ["release.env", "DEPLOY_REGION", "F5"],
  ["release.env", "PYDANTIC_VERSION", "F6"],
  ["release.env", "ARTIFACT_URI", "F7"],
  ["release.env", "NEXT_MIGRATION", "F8"],
  ["release.env", "STATUS_PAGE_URL", "F9"],
  ["release.env", "ONCALL_HANDLE", "F10"],
  ["services.env", "ACME_BILLING_STAGING_PORT", "F21"],
  ["services.env", "ACME_BILLING_TICKET", "F22"],
  ["services.env", "ACME_PAYOUTS_COMMIT", "F23"],
  ["services.env", "ACME_PAYOUTS_REGION", "F24"],
  ["services.env", "COBALT_IMPORT_OWNER", "F41"],
  ["services.env", "COBALT_IMPORT_SDK_VERSION", "F42"],
  ["services.env", "GRANITE_INTAKE_REGION", "F61"],
  ["services.env", "GRANITE_INTAKE_FEATURE_ENV", "F62"],
  ["services.env", "KESTREL_AUDIT_BUCKET", "F81"],
  ["services.env", "KESTREL_AUDIT_COMMIT", "F82"],
];
for (const [, , id] of SLOTS) if (!byId.has(id)) throw new Error(`no fact ${id}`);

const TASK =
  "Next step for the ledger-holds release. Create two files under release/:\n\n" +
  "release/release.env with RELEASE_COMMIT, FEATURE_TOGGLE_VAR, STAGING_API_PORT, TRACKING_TICKET, DEPLOY_REGION, " +
  "PYDANTIC_VERSION, ARTIFACT_URI, NEXT_MIGRATION, STATUS_PAGE_URL and ONCALL_HANDLE.\n\n" +
  "release/services.env with ACME_BILLING_STAGING_PORT, ACME_BILLING_TICKET, ACME_PAYOUTS_COMMIT, ACME_PAYOUTS_REGION, " +
  "COBALT_IMPORT_OWNER, COBALT_IMPORT_SDK_VERSION, GRANITE_INTAKE_REGION, GRANITE_INTAKE_FEATURE_ENV, " +
  "KESTREL_AUDIT_BUCKET and KESTREL_AUDIT_COMMIT.\n\n" +
  "One KEY=value per line, using the values we settled on for this release. Keep it short when you're done.";

// The deploy task names none of the details: a correct script still needs
// the stated commit, port, region, pins and so on. Each fact scores correct
// (the stated value appears), wrong (only another value of the same shape
// appears: a made-up or confused one) or absent (left out or parameterized).
const DEPLOY = "Write release/deploy-staging.sh for the ledger-holds release. Keep it short when you're done.";
const DEPLOY_FACTS = [
  ["F1", /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g],
  ["F2", /\b(?:LEDGER|HOLDS|PAYOUT|AUDIT)_[A-Z0-9_]*MODE[A-Z0-9_]*\b/g],
  ["F3", /(?:port["']?\s*[=:]\s*["']?|localhost:|:)(\d{2,5})\b/gi],
  ["F4", /\bOPS-\d+\b/g],
  ["F5", /\b(?:eu|us|ap|sa|me|af|ca)-(?:west|east|north|south|central|southeast|northeast|southwest|northwest)-\d+[a-z]?\b/g],
  ["F6", /pydantic\s*(?:==|>=|~=|@|\s)\s*v?(\d+\.\d+(?:\.\d+)?)/gi],
  ["F7", /s3:\/\/[^\s"'`)]+/g],
  ["F8", /\b\d{4}_[a-z][a-z0-9_]*\b/g],
  ["F9", /https?:\/\/status\.[^\s"'`)]+/g],
  ["F10", /(?<![\w$])@[a-z][\w-]{2,}/g],
];
// The owners task names two services and none of their values: does the
// script carry what was stated for them?
const OWNERS = "Write release/deploy-staging.sh that deploys acme-billing and kestrel-audit to staging. Keep it short when you're done.";
const OWNER_FACTS = [
  // same shapes as the deploy task's port, ticket, artifact URI and commit
  ["F21", DEPLOY_FACTS.find(([id]) => id === "F3")[1]],
  ["F22", DEPLOY_FACTS.find(([id]) => id === "F4")[1]],
  ["F81", DEPLOY_FACTS.find(([id]) => id === "F7")[1]],
  ["F82", DEPLOY_FACTS.find(([id]) => id === "F1")[1]],
];
function scoreOwners(dir) {
  const f = join(dir, "deploy-staging.sh");
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  return OWNER_FACTS.map(([id, re]) => {
    const want = byId.get(id).a;
    const found = [...text.matchAll(re)].map((m) => m[1] ?? m[0]);
    const verdict = text.includes(want) ? "correct" : found.some((v) => v !== want && !want.includes(v)) ? "wrong" : "absent";
    return { id, want, got: [...new Set(found)].slice(0, 5), verdict };
  });
}
function scoreDeploy(dir) {
  const f = join(dir, "deploy-staging.sh");
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  return DEPLOY_FACTS.map(([id, re]) => {
    const want = byId.get(id).a;
    const found = [...text.matchAll(re)].map((m) => m[1] ?? m[0]);
    const verdict = text.includes(want) ? "correct" : found.some((v) => v !== want && !want.includes(v)) ? "wrong" : "absent";
    return { id, want, got: [...new Set(found)].slice(0, 5), verdict };
  });
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/^["'`]|["'`]$/g, "").trim();
const PLACEHOLDER = /^$|todo|tbd|unknown|changeme|placeholder|fill|\?|^<.*>$|^\$\{|xxx|n\/a/i;

function score(dir) {
  const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
  const vals = {};
  for (const f of ["release.env", "services.env"]) {
    for (const line of read(f).split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
      if (m) vals[`${f}:${m[1]}`] = m[2];
    }
  }
  return SLOTS.map(([f, key, id]) => {
    const got = vals[`${f}:${key}`];
    const want = byId.get(id).a;
    const v = norm(got);
    const verdict = got === undefined ? "missing" : v === norm(want) || v.includes(norm(want)) ? "correct" : PLACEHOLDER.test(v) ? "placeholder" : "wrong";
    return { id, key, want, got: got ?? null, verdict };
  });
}

if (args.includes("--report")) {
  const runs = existsSync(RUNS) ? readdirSync(RUNS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(RUNS, f), "utf8"))) : [];
  const md = [];
  for (const task of ["env", "deploy", "owners"]) {
    const verdicts = task === "env" ? ["correct", "placeholder", "wrong", "missing"] : ["correct", "wrong", "absent"];
    if (!runs.some((r) => (r.task ?? "env") === task)) continue;
    md.push(`### ${task === "env" ? "Named slots (env files)" : task === "owners" ? "Services named, values not (owners task)" : "Unnamed details (deploy script)"}`, "",
      `| arm | runs | ${verdicts.join(" | ")} | transcript searches | recall calls | tool calls | task spend |`,
      `|---|---|${verdicts.map(() => "---|").join("")}---|---|---|---|`);
    for (const arm of ["A", "C", "V", "I", "W", "J"]) {
      const rs = runs.filter((r) => r.arm === arm && (r.task ?? "env") === task);
      if (!rs.length) continue;
      const n = (v) => rs.reduce((s, r) => s + r.slots.filter((x) => x.verdict === v).length, 0);
      const sum = (k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0);
      md.push(`| ${arm} | ${rs.length} | ${verdicts.map((v) => (v === "correct" ? `${n(v)}/${rs.reduce((s, r) => s + r.slots.length, 0)}` : n(v))).join(" | ")} | ${sum("transcriptSearches")} | ${sum("recallCalls")} | ${sum("toolCalls")} | $${sum("taskCost").toFixed(2)} |`);
    }
    md.push("");
  }
  const wrong = runs.flatMap((r) => r.slots.filter((x) => x.verdict === "wrong").map((x) => `${r.arm}${r.rep} ${r.task ?? "env"} ${x.key ?? x.id}: got ${JSON.stringify(x.got)}, stated ${x.want}`));
  const text = md.join("\n") + (wrong.length ? "\nWrong values:\n" + wrong.map((w) => `- ${w}`).join("\n") : "");
  writeFileSync(join(OUT, "summary-unasked.md"), text + "\n");
  console.log(text);
  process.exit(0);
}

const seed = JSON.parse(readFileSync(join(OUT, "seed.json"), "utf8"));
let spent = 0;
const costOf = new Map([[seed.sessionId, seed.cost ?? 0]]);
// arm -> plugin options (null: no plugin). V and I: a block too small for the
// lost details (1,000 chars), values only vs values plus the loss index
const ARMS = {
  A: { label: "Claude Code alone", plugin: null },
  C: { label: "with amnesia", plugin: {} },
  V: { label: "amnesia, 1,000 chars, values only", plugin: { budgetChars: 1000, lossIndex: false } },
  I: { label: "amnesia, 1,000 chars, values + loss index", plugin: { budgetChars: 1000, lossIndex: true } },
  // just-in-time recall: a 1,000-char block alone (W) vs with recall attached to the prompt (J)
  W: { label: "amnesia, 1,000-char block only", plugin: { budgetChars: 1000, lossIndex: false, autoRecall: false } },
  J: { label: "amnesia, 1,000-char block + just-in-time recall", plugin: { budgetChars: 1000, lossIndex: false, autoRecall: true } },
};
const ARM_LIST = String(opt("arms", "A,C")).split(",");
const TASKS = String(opt("tasks", "env,deploy")).split(",");
for (const a of ARM_LIST) if (!ARMS[a]) throw new Error(`unknown arm ${a}`);
function claude(extra, arm, label) {
  if (spent >= MAX) throw new Error(`spend cap $${MAX} reached`);
  const plugin = ARMS[arm].plugin;
  const settings = { autoMemoryEnabled: false, ...(plugin ? { pluginConfigs: { "amnesia@inline": { options: plugin } } } : {}) };
  const flags = ["-p", ...extra, "--output-format", "json", "--model", "sonnet", "--setting-sources", "project,local", "--strict-mcp-config",
    "--settings", JSON.stringify(settings)];
  if (plugin) flags.push("--plugin-dir", PLUGIN);
  let raw = "";
  try {
    raw = execFileSync("claude", flags, { cwd: PROJ, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], timeout: 900000 });
  } catch (e) {
    raw = String(e.stdout || "");
    if (!raw) throw e;
  }
  const j = JSON.parse(raw.slice(raw.indexOf("{")));
  const parent = extra.includes("--resume") ? extra[extra.indexOf("--resume") + 1] : null;
  const cost = Math.max(0, (j.total_cost_usd || 0) - (parent ? costOf.get(parent) ?? 0 : 0));
  costOf.set(j.session_id, j.total_cost_usd || 0);
  spent += cost;
  console.log(`  ${label}: $${cost.toFixed(3)} (total $${spent.toFixed(2)})${j.is_error ? " ERROR " + String(j.result).slice(0, 200) : ""}`);
  return { ...j, cost };
}
const transcript = (id) => {
  const root = join(homedir(), ".claude", "projects");
  for (const d of readdirSync(root)) if (existsSync(join(root, d, `${id}.jsonl`))) return join(root, d, `${id}.jsonl`);
  return null;
};
function afterBoundary(id) {
  const rows = readFileSync(transcript(id), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const b = rows.map((o, i) => (o.subtype === "compact_boundary" ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const uses = rows.slice(b + 1).flatMap((o) => (o.type === "assistant" && Array.isArray(o.message?.content) ? o.message.content : [])).filter((x) => x?.type === "tool_use");
  const block = rows.slice(b + 1).some((o) => JSON.stringify(o.message?.content ?? "").includes("[amnesia] Exact details"));
  const index = rows.slice(b + 1).some((o) => JSON.stringify(o.message?.content ?? "").includes("Also dropped (look up with recall"));
  return { uses, block, index };
}

mkdirSync(RUNS, { recursive: true });
const tools = ["--disallowedTools", "Bash,PowerShell,WebFetch,WebSearch,Task,NotebookEdit", "--allowedTools", "Read,Grep,Glob,Write,Edit,mcp__amnesia__recall"];
for (let rep = START; rep < START + REPS; rep++) {
  for (const arm of ARM_LIST) {
    const name = `${arm}${rep}`;
    const want = TASKS.filter((x) => x !== "env").map((x) => `${name}-${x}.json`);
    if (want.length && want.every((w) => existsSync(join(RUNS, w)))) { console.log(`${name}: done already`); continue; }
    console.log(`${name} (${ARMS[arm].label})`);
    const c = claude([`/compact ${LOSSY}`, "--resume", seed.sessionId, "--fork-session"], arm, "compact");
    // one compaction, two tasks: the env task in a fork first (a fork leaves the
    // compacted session as it was), then the deploy task on the session itself,
    // so its recall archive is the one the compaction filled
    const runTask = (task, prompt, extra, file) => {
      rmSync(join(PROJ, "release"), { recursive: true, force: true });
      const p = claude([prompt, ...extra, ...tools], arm, task);
      const dest = join(RUNS, file);
      rmSync(dest, { recursive: true, force: true });
      if (existsSync(join(PROJ, "release"))) renameSync(join(PROJ, "release"), dest);
      else mkdirSync(dest);
      const { uses, block, index } = afterBoundary(p.session_id);
      const transcriptSearches = uses.filter((u) => /\.claude|\.jsonl|projects[\\/]/.test(JSON.stringify(u.input ?? {}))).length;
      const slots = task === "env" ? score(dest) : task === "owners" ? scoreOwners(dest) : scoreDeploy(dest);
      const tally = Object.fromEntries(["correct", "placeholder", "wrong", "missing", "absent"].map((v) => [v, slots.filter((s) => s.verdict === v).length]).filter(([, n]) => n));
      const run = { arm, rep, task, session: p.session_id, block, index, compactCost: c.cost, taskCost: p.cost, toolCalls: uses.length, transcriptSearches,
        recallCalls: uses.filter((u) => String(u.name).includes("recall")).length, reply: String(p.result ?? "").slice(0, 600), tally, slots };
      writeFileSync(join(RUNS, `${file}.json`), JSON.stringify(run, null, 2));
      console.log(`  ${task}: ${JSON.stringify(tally)}; block ${block}; tools ${uses.length} (transcript ${transcriptSearches}, recall ${run.recallCalls})`);
    };
    if (TASKS.includes("env") && !existsSync(join(RUNS, `${name}.json`))) runTask("env", TASK, ["--resume", c.session_id, "--fork-session"], name);
    if (TASKS.includes("deploy")) runTask("deploy", DEPLOY, ["--resume", c.session_id], `${name}-deploy`);
    // a task of its own per compaction: a fork would start an empty recall archive
    else if (TASKS.includes("owners")) runTask("owners", OWNERS, ["--resume", c.session_id], `${name}-owners`);
  }
}
console.log(`spent $${spent.toFixed(2)}`);
