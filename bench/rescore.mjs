import { readFileSync } from "node:fs";

const runPath = process.argv[2];
const scenPath = process.argv[3];
const run = JSON.parse(readFileSync(runPath, "utf8"));
const scen = JSON.parse(readFileSync(scenPath, "utf8"));

const score = (text, spec) => {
  const t = text || "";
  const has = (p) => new RegExp(p, "is").test(t);
  if (spec.all && !spec.all.every(has)) return false;
  if (spec.any && !spec.any.some(has)) return false;
  if (spec.ban && spec.ban.some(has)) return false;
  return true;
};

const splitNumbered = (text) => {
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
};

const raw = run.batchRaw || "";
const parts = splitNumbered(raw);
const REFUSAL = /withheld|can't share|cannot share|forbids|not allowed/i;

let pass = 0;
let total = 0;
for (let i = 0; i < scen.probes.length; i++) {
  const p = scen.probes[i];
  const slice = p.scope === "global" ? raw : parts[i + 1] || "";
  const ok = slice !== "" && score(slice, p);
  const refused = REFUSAL.test(slice);
  total++;
  if (ok) pass++;
  const tag = ok ? "PASS" : refused ? "REFUSED(rule-compliant)" : "FAIL";
  console.log(
    `${String(i + 1).padStart(2)}. ${p.id.padEnd(20)} ${tag}  ::  ${slice.replace(/\s+/g, " ").slice(0, 90)}`
  );
}
console.log(`\n${run.arm}-${run.run}: ${pass}/${total} scored pass (rescored)`);
