import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  listSessionFiles,
  scanFile,
  scanPersisted,
  encodeProjectPath,
  DEFAULT_ROOT,
} from "./claude.mjs";
import { renderScan, renderReceipt, style } from "./render.mjs";
import { runRestore, runProtect, runRecover } from "./actions.mjs";
import {
  installHooks,
  uninstallHooks,
  hookPrecompact,
  hookPostcompact,
  defaultSettingsPath,
} from "./hooks.mjs";

function printHelp() {
  console.log(`
  amnesia — see what your AI coding agent forgot, and get it back

  usage:
    amnesia                     scan ~/.claude/projects for compacted sessions
    amnesia <session-id>        full compaction receipt for one session
    amnesia restore [<session>] [--all] [--out <file>]
                                recover dropped messages into a readable file
    amnesia protect [<session>] [--project <dir>] [--write] [--out <file>]
                                extract dropped constraints into CLAUDE.md
    amnesia recover [<session>] [--out <dir>]
                                recover tool outputs that were persisted to disk
    amnesia install [--settings <file>] [--dry-run]
                                wire Claude Code hooks: snapshot before every
                                compaction, announce it after
    amnesia uninstall [--settings <file>]
                                remove the amnesia hooks
    amnesia --json [<session>]  machine-readable output
    amnesia --root <dir>        use a different projects root
    amnesia --version | --help
`);
}

function eventKey(b) {
  return `${b.timestamp}|${b.preTokens}|${b.postTokens}`;
}

function toJson(env) {
  return {
    project: env.file.project,
    session: env.file.session,
    path: env.file.path,
    totals: {
      users: env.userSeen,
      assistants: env.assistantSeen,
      toolResults: env.toolResultsSeen,
    },
    boundaries: env.boundaries.map((b) => ({
      timestamp: b.timestamp,
      trigger: b.trigger,
      preTokens: b.preTokens,
      postTokens: b.postTokens,
      durationMs: b.durationMs,
      cumulativeDroppedTokens: b.cumulativeDroppedTokens,
      preservedCount: b.preservedCount,
      originSession: b.originSession ?? null,
      covered: {
        users: b.coveredUsers,
        assistants: b.coveredAssistants,
        toolResults: b.coveredToolResults,
      },
      summary: b.summary,
      previews: b.previews,
    })),
  };
}

function resolveFile(files, selector) {
  let file = files.find((f) => f.path === selector);
  if (!file && /^[0-9a-f-]{6,}$/i.test(selector)) {
    const matches = files.filter((f) =>
      f.session.startsWith(selector.toLowerCase())
    );
    if (matches.length === 1) {
      file = matches[0];
    } else if (matches.length > 1) {
      console.error(`session id "${selector}" is ambiguous (${matches.length} matches):`);
      for (const m of matches) console.error(`  ${m.session}  ${m.project}`);
      return { error: true };
    }
  }
  if (!file && existsSync(selector)) {
    file = {
      path: selector,
      project: basename(dirname(selector)),
      session: basename(selector).replace(/\.jsonl$/, ""),
      size: 0,
      mtimeMs: 0,
    };
  }
  return { file };
}

function recentIn(files, dir) {
  return files
    .filter((f) => dirname(f.path) === dir)
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    .slice(0, 12);
}

async function latestCompacted(files, dir) {
  for (const f of recentIn(files, dir)) {
    try {
      const r = await scanFile(f);
      if (r.boundaries.length > 0) return f;
    } catch {}
  }
  return null;
}

async function latestWithPersisted(files, dir) {
  for (const f of recentIn(files, dir)) {
    try {
      const r = await scanPersisted(f);
      if (r.refs.length > 0) return f;
    } catch {}
  }
  return null;
}

export async function main(argv) {
  const args = [...argv];
  let json = false;
  let root = DEFAULT_ROOT;
  let all = false;
  let write = false;
  let dryRun = false;
  let outPath = null;
  let projectArg = null;
  let settingsPath = null;
  const pos = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--all") all = true;
    else if (a === "--write") write = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--out") outPath = args[++i];
    else if (a === "--project") projectArg = args[++i];
    else if (a === "--settings") settingsPath = args[++i];
    else if (a === "--root") {
      const v = args[++i];
      if (!v) {
        console.error("--root requires a directory path");
        process.exitCode = 1;
        return;
      }
      root = v;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      return;
    } else if (a === "--version" || a === "-v") {
      console.log("amnesia 0.4.0");
      return;
    } else pos.push(a);
  }

  const files = listSessionFiles(root);
  const cmd = pos[0];

  if (cmd === "install") {
    let r;
    try {
      r = installHooks({
        settingsPath: settingsPath || defaultSettingsPath(),
        dryRun,
      });
    } catch (e) {
      console.error(style.red(`install failed: ${e.message}`));
      process.exitCode = 1;
      return;
    }
    console.log("");
    console.log(style.bold("  amnesia") + style.dim(" \u00b7 install"));
    console.log(style.dim(`  settings: ${r.path}${r.dryRun ? " (dry run)" : ""}`));
    for (const x of r.results) {
      console.log(
        `  + ${x.event.padEnd(11)} \u2192 ${x.command}` +
          (x.replaced > 0 ? style.dim(` (replaced ${x.replaced})`) : "")
      );
    }
    if (r.backupPath) console.log(style.dim(`  backup: ${r.backupPath}`));
    console.log(
      r.dryRun
        ? style.dim("  nothing written (dry run)")
        : style.green(
            "  installed \u2014 every compaction will now be snapshotted and announced."
          )
    );
    console.log("");
    return;
  }

  if (cmd === "uninstall") {
    let r;
    try {
      r = uninstallHooks({
        settingsPath: settingsPath || defaultSettingsPath(),
        dryRun,
      });
    } catch (e) {
      console.error(style.red(`uninstall failed: ${e.message}`));
      process.exitCode = 1;
      return;
    }
    console.log("");
    console.log(style.bold("  amnesia") + style.dim(" \u00b7 uninstall"));
    console.log(style.dim(`  settings: ${r.path}${r.dryRun ? " (dry run)" : ""}`));
    if (r.removed.length === 0) {
      console.log(style.dim("  no amnesia hooks found."));
    } else {
      for (const x of r.removed) {
        console.log(`  - ${x.event} (${x.count} entr${x.count === 1 ? "y" : "ies"})`);
      }
      if (r.backupPath) console.log(style.dim(`  backup: ${r.backupPath}`));
      console.log(style.green("  removed."));
    }
    console.log("");
    return;
  }

  if (cmd === "hook") {
    const which = (pos[1] || "").toLowerCase();
    if (which === "precompact") {
      await hookPrecompact();
      return;
    }
    if (which === "postcompact") {
      await hookPostcompact();
      return;
    }
    console.error("usage: amnesia hook precompact|postcompact");
    process.exitCode = 1;
    return;
  }

  if (cmd === "restore") {
    const selector = pos[1] || null;
    let file = null;
    if (selector) {
      const r = resolveFile(files, selector);
      if (r.error) {
        process.exitCode = 1;
        return;
      }
      file = r.file;
      if (!file) {
        console.error(style.red(`no session matching "${selector}"`));
        process.exitCode = 1;
        return;
      }
    } else {
      const dir = join(root, encodeProjectPath(process.cwd()));
      if (!existsSync(dir)) {
        console.error(style.red("no Claude Code sessions found for this directory."));
        console.error(style.dim("pass a session id:  amnesia restore <session-id>"));
        process.exitCode = 1;
        return;
      }
      file = await latestCompacted(files, dir);
      if (!file) {
        console.error(
          style.red("no compaction events in this project's recent sessions.")
        );
        process.exitCode = 1;
        return;
      }
    }
    await runRestore({ file, files, all, outPath });
    return;
  }

  if (cmd === "protect") {
    const selector = pos[1] || null;
    let sessionFile = null;
    if (selector) {
      const r = resolveFile(files, selector);
      if (r.error) {
        process.exitCode = 1;
        return;
      }
      sessionFile = r.file;
      if (!sessionFile) {
        console.error(style.red(`no session matching "${selector}"`));
        process.exitCode = 1;
        return;
      }
    }
    await runProtect({ files, root, projectArg, sessionFile, write, outPath });
    return;
  }

  if (cmd === "recover") {
    const selector = pos[1] || null;
    let file = null;
    if (selector) {
      const r = resolveFile(files, selector);
      if (r.error) {
        process.exitCode = 1;
        return;
      }
      file = r.file;
      if (!file) {
        console.error(style.red(`no session matching "${selector}"`));
        process.exitCode = 1;
        return;
      }
    } else {
      const dir = join(root, encodeProjectPath(process.cwd()));
      if (!existsSync(dir)) {
        console.error(style.red("no Claude Code sessions found for this directory."));
        console.error(style.dim("pass a session id:  amnesia recover <session-id>"));
        process.exitCode = 1;
        return;
      }
      file = await latestWithPersisted(files, dir);
      if (!file) {
        console.log(
          style.green("  nothing to recover \u2014 no persisted tool outputs in this project's recent sessions.")
        );
        return;
      }
    }
    await runRecover({ file, outDir: outPath });
    return;
  }

  if (pos.length === 0) {
    const results = [];
    let totalBoundaries = 0;
    for (const f of files) {
      try {
        const r = await scanFile(f);
        if (r.boundaries.length > 0) {
          results.push(r);
          totalBoundaries += r.boundaries.length;
        }
      } catch {}
    }

    const best = new Map();
    for (const r of results) {
      for (const b of r.boundaries) {
        const key = eventKey(b);
        const cov = b.coveredUsers + b.coveredAssistants;
        const cur = best.get(key);
        if (!cur || cov > cur.cov) best.set(key, { cov, r, b });
      }
    }
    const byHome = new Map();
    for (const { r, b } of best.values()) {
      if (!byHome.has(r.file.path)) {
        byHome.set(r.file.path, { file: r.file, boundaries: [] });
      }
      byHome.get(r.file.path).boundaries.push(b);
    }
    const entries = [...byHome.values()];
    const collapsedEvents = totalBoundaries - best.size;

    if (json) {
      console.log(
        JSON.stringify(
          entries.map((e) =>
            toJson({
              file: e.file,
              boundaries: e.boundaries,
              userSeen: 0,
              assistantSeen: 0,
              toolResultsSeen: 0,
            })
          ),
          null,
          2
        )
      );
      return;
    }
    process.stdout.write(
      renderScan(entries, { totalFiles: files.length, root, collapsedEvents })
    );
    return;
  }

  const r = resolveFile(files, pos[0]);
  if (r.error) {
    process.exitCode = 1;
    return;
  }
  let file = r.file;
  if (!file) {
    console.error(style.red(`no session matching "${pos[0]}"`));
    console.error(style.dim(`searched ${root}`));
    process.exitCode = 1;
    return;
  }

  const env = await scanFile(file, { withPreviews: true });

  const dir = dirname(file.path);
  const siblings = files
    .filter((f) => dirname(f.path) === dir && f.path !== file.path)
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  if (siblings.length <= 60) {
    for (const b of env.boundaries) {
      if (b.coveredUsers + b.coveredAssistants >= 5) continue;
      if (b.preTokens == null || b.postTokens == null) continue;
      for (const sib of siblings) {
        try {
          const s = await scanFile(sib, { withPreviews: true });
          const m = s.boundaries.find(
            (x) =>
              eventKey(x) === eventKey(b) &&
              x.coveredUsers + x.coveredAssistants >
                b.coveredUsers + b.coveredAssistants
          );
          if (m) {
            b.coveredUsers = m.coveredUsers;
            b.coveredAssistants = m.coveredAssistants;
            b.coveredToolResults = m.coveredToolResults;
            b.previews = m.previews;
            b.originSession = sib.session;
            break;
          }
        } catch {}
      }
    }
  }

  if (json) {
    console.log(JSON.stringify(toJson(env), null, 2));
    return;
  }
  process.stdout.write(renderReceipt(env));
}
