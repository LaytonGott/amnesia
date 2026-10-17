import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listSessionFiles,
  collectHistory,
  droppedForBoundary,
  DEFAULT_ROOT,
} from "../src/claude.mjs";
import { extractConstraints } from "../src/actions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] || DEFAULT_ROOT;

const STOP = new Set(
  ("this that with from your have will what when then they them there their about would could should " +
    "because into over under more most some such only also than once here where which while during " +
    "before after above below between both each few other same very just like need make sure want know " +
    "dont wont cant isnt arent doesnt didnt without should before being been").split(/\s+/)
);

const COMPOUND_RE = /\b[A-Za-z][A-Za-z0-9]*(?:[._/\\-][A-Za-z0-9]+)+\b/g;
const NUMBER_RE = /\b\d[\d.]{2,}\b/g;

function atomsOf(text) {
  const ids = new Set();
  for (const m of text.matchAll(COMPOUND_RE)) {
    const v = m[0].toLowerCase();
    if (v.length >= 5) ids.add(v);
  }
  const nums = new Set();
  for (const m of text.matchAll(NUMBER_RE)) nums.add(m[0]);
  return { ids, nums };
}

function contentWords(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOP.has(w));
}

const sessions = [];
const lostExamples = [];
let totals = {
  sessions: 0,
  boundaries: 0,
  droppedPrompts: 0,
  droppedChars: 0,
  idsTotal: 0,
  idsHeld: 0,
  numsTotal: 0,
  numsHeld: 0,
  constraintsTotal: 0,
  constraintsHeld: 0,
};

const files = listSessionFiles(root);
for (const f of files) {
  let history;
  try {
    history = await collectHistory(f);
  } catch {
    continue;
  }
  const rows = [];
  for (let i = 0; i < history.boundaries.length; i++) {
    const b = history.boundaries[i];
    if (!b.summary) continue;
    const dropped = droppedForBoundary(history, i);
    if (dropped.length === 0) continue;
    const summary = b.summary.toLowerCase();
    const row = {
      boundary: i + 1,
      ts: b.timestamp,
      dropped: dropped.length,
      idsTotal: 0,
      idsHeld: 0,
      constraintsTotal: 0,
      constraintsHeld: 0,
    };
    for (const p of dropped) {
      totals.droppedChars += p.text.length;
      const { ids } = atomsOf(p.text);
      for (const id of ids) {
        row.idsTotal++;
        totals.idsTotal++;
        if (summary.includes(id)) {
          row.idsHeld++;
          totals.idsHeld++;
        }
      }
      for (const c of extractConstraints([p])) {
        row.constraintsTotal++;
        totals.constraintsTotal++;
        const words = contentWords(c.text);
        const missing = words.filter((w) => !summary.includes(w));
        const held = words.length > 0 && 1 - missing.length / words.length >= 0.5;
        if (held) {
          row.constraintsHeld++;
          totals.constraintsHeld++;
        } else if (lostExamples.length < 40) {
          lostExamples.push({
            session: f.session.slice(0, 8),
            ts: b.timestamp,
            text: c.text.replace(/\s+/g, " ").slice(0, 170),
            missing: missing.slice(0, 7),
          });
        }
      }
    }
    totals.boundaries++;
    totals.droppedPrompts += dropped.length;
    if (row.idsTotal > 0) rows.push(row);
  }
  if (rows.length > 0) {
    totals.sessions++;
    sessions.push({
      session: f.session.slice(0, 8),
      project: f.project.slice(0, 40),
      rows,
    });
  }
}

const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(1) + "%" : "n/a");

const out = [];
out.push("# Real-data retention audit");
out.push("");
out.push(`Scanned: ${files.length} sessions · ${totals.sessions} with analyzable compactions · ${totals.boundaries} boundaries`);
out.push(`Dropped content: ${totals.droppedPrompts} user prompts (${(totals.droppedChars / 1e6).toFixed(1)} MB of prompt text)`);
out.push("");
out.push("## Survival of dropped content in the replacement summaries");
out.push("");
out.push("| class | examined | found in summary | rate |");
out.push("|-------|----------|------------------|------|");
out.push(`| exact technical strings (paths, IDs, versions) | ${totals.idsTotal} | ${totals.idsHeld} | ${pct(totals.idsHeld, totals.idsTotal)} |`);
out.push(`| explicit constraints (>=50% of content words present) | ${totals.constraintsTotal} | ${totals.constraintsHeld} | ${pct(totals.constraintsHeld, totals.constraintsTotal)} |`);
out.push("");
out.push("## Per session");
out.push("");
out.push("| session | boundary | when | dropped | strings held | constraints held |");
out.push("|---------|----------|------|---------|--------------|------------------|");
for (const s of sessions.slice(0, 25)) {
  for (const r of s.rows) {
    out.push(
      `| ${s.session} | ${r.boundary} | ${String(r.ts || "").slice(0, 16).replace("T", " ")} | ${r.dropped} | ${r.idsHeld}/${r.idsTotal} (${pct(r.idsHeld, r.idsTotal)}) | ${r.constraintsHeld}/${r.constraintsTotal} |`
    );
  }
}
out.push("");
out.push("## Example lost constraints (not materially present in the replacement summary)");
out.push("");
for (const e of lostExamples.slice(0, 15)) {
  out.push(`- [${e.session} · ${String(e.ts || "").slice(0, 10)}] "${e.text}"`);
  out.push(`  missing tokens: ${e.missing.join(", ")}`);
}
out.push("");
out.push("## Method notes");
out.push("");
out.push("- Dropped set = exact context reconstruction (verified against live transcripts).");
out.push('- "Exact technical strings" = compound tokens (paths, dotted names, IDs, versions), case-insensitive substring check.');
out.push("- Constraint survival is a floor, not a measurement: summaries can paraphrase; text absence does not prove");
out.push("  behavioral loss, and text presence does not prove the detail survived at full fidelity.");
out.push("- This audit measures the pre-compaction text vs the replacement summary. It does not test agent behavior.");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const resDir = join(HERE, "results", `real-audit-${stamp}`);
mkdirSync(resDir, { recursive: true });
writeFileSync(join(resDir, "audit.md"), out.join("\n"));
writeFileSync(join(resDir, "audit.json"), JSON.stringify({ totals, sessions, lostExamples }, null, 2));
console.log(out.join("\n"));
console.log(`\nresults: ${resDir}`);
