import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  collectHistory,
  droppedForBoundary,
  encodeProjectPath,
  eventKeyOf,
} from "./claude.mjs";
import {
  style,
  fmtTokens,
  fmtPct,
  localTime,
  truncate,
} from "./render.mjs";

async function droppedWithOrigin(file, files, history, index) {
  let boundary = history.boundaries[index];
  let dropped = droppedForBoundary(history, index);
  let origin = null;

  if (dropped.length < 2 && boundary.preTokens != null && boundary.postTokens != null) {
    const dir = dirname(file.path);
    const siblings = files
      .filter((f) => dirname(f.path) === dir && f.path !== file.path)
      .sort((a, c) => (c.size ?? 0) - (a.size ?? 0));
    if (siblings.length <= 60) {
      const key = eventKeyOf(boundary);
      for (const sib of siblings) {
        try {
          const h = await collectHistory(sib);
          const mi = h.boundaries.findIndex((x) => eventKeyOf(x) === key);
          if (mi === -1) continue;
          const d = droppedForBoundary(h, mi);
          if (d.length > dropped.length) {
            boundary = h.boundaries[mi];
            dropped = d;
            origin = sib;
            break;
          }
        } catch {}
      }
    }
  }
  return { boundary, dropped, origin };
}

export async function runRestore({ file, files, all, outPath }) {
  const history = await collectHistory(file);
  if (history.boundaries.length === 0) {
    console.log(
      style.green("  no compaction events found in this session \u2014 nothing to restore.")
    );
    return;
  }

  const indexes = all
    ? history.boundaries.map((_, i) => i)
    : [history.boundaries.length - 1];

  const meta = [];
  for (const i of indexes) {
    meta.push(await droppedWithOrigin(file, files, history, i));
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const out = outPath
    ? isAbsolute(outPath)
      ? outPath
      : join(process.cwd(), outPath)
    : join(".amnesia", `restored-${file.session.slice(0, 8)}-${stamp}.md`);

  const md = [];
  md.push("# Recovered context (amnesia restore)");
  md.push("");
  md.push(`- Session: \`${file.session}\` (project folder: \`${file.project}\`)`);
  md.push(`- Source: \`${file.path}\``);
  md.push("");

  let n = 0;
  let totalDropped = 0;
  meta.forEach(({ boundary: b, dropped, origin }, mi) => {
    totalDropped += dropped.length;
    const pct =
      b.preTokens != null && b.postTokens != null
        ? fmtPct(b.preTokens - b.postTokens, b.preTokens)
        : "?";
    md.push(
      `## Compaction ${mi + 1}/${meta.length} \u2014 ${localTime(b.timestamp)} (trigger ${b.trigger})`
    );
    md.push("");
    md.push(
      `Context went from ${fmtTokens(b.preTokens)} to ${fmtTokens(b.postTokens)} tokens (${pct} dropped).` +
        (origin ? ` Dropped history read from originating session \`${origin.session}\`.` : "")
    );
    md.push("");
    if (b.summary) {
      md.push("### What the agent believes now (post-compaction summary)");
      md.push("");
      md.push(
        b.summary
          .split(/\r?\n/)
          .map((l) => `> ${l}`)
          .join("\n")
      );
      md.push("");
    }
    md.push(`### Messages it no longer has (${dropped.length}, oldest first)`);
    md.push("");
    if (dropped.length === 0) {
      md.push(
        "_(no recoverable prompts \u2014 the replaced history may live in a deleted or rotated session file)_"
      );
      md.push("");
    }
    for (const p of dropped) {
      n++;
      const t = p.timestamp ? String(p.timestamp).replace("T", " ").slice(0, 19) : "";
      md.push(`#### ${n}. ${t}`);
      md.push("");
      md.push(p.text);
      md.push("");
    }
  });

  md.push("## How to use this file");
  md.push("");
  md.push("Paste this to your agent:");
  md.push("");
  md.push(
    `> Read \`${out}\` \u2014 this is context you lost to compaction. Acknowledge what changed and continue the task.`
  );
  md.push("");

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md.join("\n"), "utf8");

  console.log("");
  console.log(style.bold("  amnesia") + style.dim(" \u00b7 restore"));
  console.log(
    style.dim(
      `  ${truncate(file.project, 40)}/${file.session.slice(0, 8)} \u00b7 ${meta.length} compaction event(s) \u00b7 ${fmtTokens(totalDropped)} dropped prompt(s) recovered`
    )
  );
  console.log("");
  console.log(style.green(`  recovered context written to ${out}`));
  console.log("");
  console.log(style.dim("  paste this to your agent:"));
  console.log(
    `  Read \`${out}\` \u2014 this is context you lost to compaction. Acknowledge what changed and continue the task.`
  );
  console.log("");
}

const CONSTRAINT_RE =
  /\b(never|don'?t|do not|must not|must be|must remain|always|only|avoid|make sure|be sure|remember|important|critical|non-negotiable|ensure|required to|audit only|keep .{0,30} (?:separate|read-only|intact)|leave .{0,20} alone)\b/i;
const QUESTION_START =
  /^(how|what|why|when|where|who|can|could|should|would|is|are|does|do|did|will|shall)\b/i;

export function extractConstraints(prompts) {
  const out = [];
  const seen = new Set();
  for (const p of prompts) {
    const sentences = p.text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim().replace(/^[\s\-*\d.)]+/, ""))
      .filter(Boolean);
    for (const s of sentences) {
      if (s.length < 12 || s.length > 320) continue;
      if (s.endsWith("?")) continue;
      if (QUESTION_START.test(s)) continue;
      if (!CONSTRAINT_RE.test(s)) continue;
      const norm = s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ text: s, source: p });
    }
  }
  return out;
}

function updateClaudeMd(path, constraints) {
  const START = "<!-- amnesia:constraints:start -->";
  const END = "<!-- amnesia:constraints:end -->";
  const section = [
    START,
    "## Constraints recovered by amnesia",
    "",
    "_Rules dropped from the agent's context during compaction. These keep applying._",
    "",
    ...constraints.map((c) => `- ${c.text}`),
    END,
  ].join("\n");

  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  let next;
  if (s !== -1 && e !== -1 && e > s) {
    next = existing.slice(0, s) + section + existing.slice(e + END.length);
  } else {
    next = (existing.trimEnd() ? existing.trimEnd() + "\n\n" : "") + section + "\n";
  }
  writeFileSync(path, next, "utf8");
}

export async function runProtect({
  files,
  root,
  projectArg,
  sessionFile,
  write,
  outPath,
}) {
  let dirFiles;
  let targetDirForClaude = null;
  let resolvedDir = null;

  if (sessionFile) {
    const dir = dirname(sessionFile.path);
    dirFiles = files.filter((f) => dirname(f.path) === dir);
    resolvedDir = dir;
    targetDirForClaude = process.cwd();
  } else if (projectArg) {
    let dir = null;
    if (isAbsolute(projectArg)) {
      targetDirForClaude = projectArg;
      const enc = join(root, encodeProjectPath(projectArg));
      if (existsSync(enc)) dir = enc;
    }
    if (!dir) {
      const alt = join(root, projectArg);
      if (existsSync(alt)) dir = alt;
    }
    if (!dir) {
      console.error(style.red(`no sessions found for project "${projectArg}"`));
      console.error(style.dim(`searched ${root}`));
      process.exitCode = 1;
      return;
    }
    resolvedDir = dir;
    dirFiles = files.filter((f) => dirname(f.path) === dir);
  } else {
    const enc = join(root, encodeProjectPath(process.cwd()));
    if (!existsSync(enc)) {
      console.error(
        style.red("no Claude Code sessions found for this directory.")
      );
      console.error(
        style.dim("pass --project <dir> or a session id:  amnesia protect <session-id>")
      );
      process.exitCode = 1;
      return;
    }
    resolvedDir = enc;
    targetDirForClaude = process.cwd();
    dirFiles = files.filter((f) => dirname(f.path) === enc);
  }

  if (!dirFiles || dirFiles.length === 0) {
    console.log(style.green("  no session files found in that project."));
    return;
  }

  const candidates = [];
  let compactedSessions = 0;
  let events = 0;

  for (const f of dirFiles) {
    let h;
    try {
      h = await collectHistory(f);
    } catch {
      continue;
    }
    if (h.boundaries.length === 0) continue;
    compactedSessions++;
    events += h.boundaries.length;
    for (let i = 0; i < h.boundaries.length; i++) {
      const dropped = droppedForBoundary(h, i);
      for (const c of extractConstraints(dropped)) {
        candidates.push({
          ...c,
          session: f.session,
          boundaryTs: h.boundaries[i].timestamp,
        });
      }
    }
  }

  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const norm = c.text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (seen.has(norm)) continue;
    seen.add(norm);
    unique.push(c);
  }

  console.log("");
  console.log(style.bold("  amnesia") + style.dim(" \u00b7 protect"));
  console.log(
    style.dim(
      `  ${truncate(resolvedDir.split(/[\\/]/).pop() || resolvedDir, 40)} \u00b7 ${compactedSessions} compacted session(s) \u00b7 ${events} event(s)`
    )
  );
  console.log("");

  if (unique.length === 0) {
    console.log(
      style.green("  no constraint-like text was dropped to protect (yet).")
    );
    console.log("");
    return;
  }

  unique.slice(0, 40).forEach((c, i) => {
    console.log(`  ${String(i + 1).padStart(3)}. ${c.text}`);
    console.log(
      style.dim(`       from ${c.session.slice(0, 8)} \u00b7 ${localTime(c.boundaryTs)}`)
    );
  });
  console.log("");

  const target = outPath
    ? isAbsolute(outPath)
      ? outPath
      : join(process.cwd(), outPath)
    : join(targetDirForClaude || process.cwd(), "CLAUDE.md");

  if (!write) {
    console.log(style.dim("  dry run \u2014 nothing written."));
    console.log(style.dim(`  apply:  amnesia protect --write   (target: ${target})`));
    console.log("");
    return;
  }

  updateClaudeMd(target, unique.slice(0, 40));
  console.log(
    style.green(`  wrote ${Math.min(unique.length, 40)} constraint(s) to ${target}`)
  );
  console.log(
    style.dim("  section: amnesia:constraints (updates in place \u2014 safe to re-run)")
  );
  console.log("");
}
