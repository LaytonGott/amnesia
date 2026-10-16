import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectHistory } from "./claude.mjs";
import { extractConstraints } from "./actions.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function defaultSettingsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(base, "settings.json");
}

function amnesiaBinPath() {
  const fromArgv = process.argv[1] ? resolve(process.argv[1]) : null;
  if (fromArgv && existsSync(fromArgv) && fromArgv.endsWith(".mjs")) {
    return fromArgv;
  }
  return resolve(MODULE_DIR, "..", "bin", "amnesia.mjs");
}

const q = (s) => (/\s/.test(s) ? `"${s}"` : s);

function hookCommand(which) {
  return `${q(process.execPath)} ${q(amnesiaBinPath())} hook ${which}`;
}

function isOurs(entry, which) {
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) =>
        h &&
        h.type === "command" &&
        typeof h.command === "string" &&
        h.command.includes("amnesia") &&
        h.command.includes(`hook ${which}`)
    )
  );
}

function loadSettings(path) {
  if (!existsSync(path)) return {};
  let raw = readFileSync(path, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function backup(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.amnesia-backup-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}

export function installHooks({ settingsPath, dryRun = false } = {}) {
  const path = settingsPath || defaultSettingsPath();
  const settings = loadSettings(path);
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const results = [];
  for (const ev of ["PreCompact", "PostCompact"]) {
    const which = ev.toLowerCase();
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = list.filter((e) => !isOurs(e, which));
    const command = hookCommand(which);
    settings.hooks[ev] = [
      ...kept,
      { matcher: "", hooks: [{ type: "command", command, timeout: 60 }] },
    ];
    results.push({ event: ev, command, replaced: list.length - kept.length });
  }
  let backupPath = null;
  if (!dryRun) {
    backupPath = backup(path);
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  return { path, results, dryRun, backupPath };
}

export function uninstallHooks({ settingsPath, dryRun = false } = {}) {
  const path = settingsPath || defaultSettingsPath();
  const settings = loadSettings(path);
  const removed = [];
  const hooks =
    settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const kept = hooks[ev].filter((e) => !isOurs(e, ev.toLowerCase()));
    const n = hooks[ev].length - kept.length;
    if (n > 0) removed.push({ event: ev, count: n });
    if (kept.length > 0) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  let backupPath = null;
  if (!dryRun && removed.length > 0) {
    backupPath = backup(path);
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  return { path, removed, dryRun, backupPath };
}

function readStdinJson() {
  if (process.stdin.isTTY) return Promise.resolve({});
  return new Promise((res) => {
    let d = "";
    const done = () => {
      try {
        res(JSON.parse(d));
      } catch {
        res({});
      }
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function pruneSnapshots(dir, prefix, keep) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort();
    while (files.length > keep) {
      const f = files.shift();
      try {
        rmSync(join(dir, f));
      } catch {}
    }
  } catch {}
}

export async function hookPrecompact() {
  try {
    const input = await readStdinJson();
    const transcript = input.transcript_path;
    if (!transcript || !existsSync(transcript)) return;
    const cwd = input.cwd || process.cwd();
    const session =
      input.session_id || basename(transcript).replace(/\.jsonl$/, "");
    const history = await collectHistory({ path: transcript });
    const constraints = extractConstraints(history.prompts);
    const stamp = new Date()
      .toISOString()
      .slice(0, 16)
      .replace(/[:T]/g, "-");
    const dir = join(cwd, ".amnesia", "snapshots");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${session.slice(0, 8)}-${stamp}-precompact.md`);

    const md = [];
    md.push("# Pre-compaction snapshot (amnesia)");
    md.push("");
    md.push(`- Session: \`${session}\``);
    md.push(`- Project: \`${cwd}\``);
    md.push(`- Captured: ${stamp} \u00b7 trigger \`${input.trigger || "unknown"}\``);
    md.push(
      `- ${history.prompts.length} user prompt(s) \u00b7 ${history.boundaries.length} previous compaction(s)`
    );
    md.push("");
    if (constraints.length > 0) {
      md.push("## Constraints in this session");
      md.push("");
      for (const c of constraints.slice(0, 40)) md.push(`- ${c.text}`);
      md.push("");
    }
    md.push("## User prompts (oldest first)");
    md.push("");
    let n = 0;
    for (const p of history.prompts) {
      n++;
      const t = p.timestamp
        ? String(p.timestamp).replace("T", " ").slice(0, 19)
        : "";
      md.push(`### ${n}. ${t}`);
      md.push("");
      md.push(p.text);
      md.push("");
    }
    writeFileSync(out, md.join("\n"), "utf8");
    pruneSnapshots(dir, session.slice(0, 8), 10);
  } catch {}
}

export async function hookPostcompact() {
  try {
    const input = await readStdinJson();
    const cwd = input.cwd || process.cwd();
    const session = input.session_id || "";
    const dir = join(cwd, ".amnesia", "snapshots");
    let latest = null;
    if (session && existsSync(dir)) {
      const files = readdirSync(dir)
        .filter((f) => f.startsWith(session.slice(0, 8)))
        .sort();
      if (files.length > 0) latest = join(dir, files[files.length - 1]);
    }
    const trigger = input.trigger || "unknown";
    const parts = [`amnesia: compaction just fired (${trigger}).`];
    if (latest) {
      parts.push(
        `Pre-compaction snapshot: ${latest} \u2014 if you need details from before the compaction, read that file.`
      );
    } else {
      parts.push(
        "Run `amnesia restore` for the loss report; if you need earlier details, ask for them explicitly."
      );
    }
    console.log(parts.join(" "));
  } catch {}
}
