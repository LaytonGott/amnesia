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

const HOOK_EVENTS = [
  { event: "PreCompact", cmd: "precompact" },
  { event: "PostCompact", cmd: "postcompact" },
  { event: "UserPromptSubmit", cmd: "prompt" },
];

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

function hookCommand(cmd) {
  return `${q(process.execPath)} ${q(amnesiaBinPath())} hook ${cmd}`;
}

function isOurs(entry, cmd) {
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) =>
        h &&
        h.type === "command" &&
        typeof h.command === "string" &&
        h.command.includes("amnesia") &&
        h.command.includes(`hook ${cmd}`)
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
  for (const { event, cmd } of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[event])
      ? settings.hooks[event]
      : [];
    const kept = list.filter((e) => !isOurs(e, cmd));
    const command = hookCommand(cmd);
    settings.hooks[event] = [
      ...kept,
      { matcher: "", hooks: [{ type: "command", command, timeout: 60 }] },
    ];
    results.push({ event, command, replaced: list.length - kept.length });
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
  const cmdForEvent = (ev) =>
    HOOK_EVENTS.find((h) => h.event === ev)?.cmd ?? ev.toLowerCase();
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const cmd = cmdForEvent(ev);
    const kept = hooks[ev].filter((e) => !isOurs(e, cmd));
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

    const sidecar = out.replace(/\.md$/, ".json");
    writeFileSync(
      sidecar,
      JSON.stringify(
        {
          session,
          cwd,
          trigger: input.trigger || "unknown",
          ts: new Date().toISOString(),
          snapshot: out,
          promptCount: history.prompts.length,
          constraints: constraints.slice(0, 40).map((c) => c.text),
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    pruneSnapshots(dir, session.slice(0, 8), 10);
  } catch {}
}

export async function hookPostcompact() {
  try {
    const input = await readStdinJson();
    const cwd = input.cwd || process.cwd();
    const session = input.session_id || "";
    const prefix = session.slice(0, 8);
    const dir = join(cwd, ".amnesia", "snapshots");

    let snapshot = null;
    let constraints = [];
    let promptCount = null;
    if (prefix && existsSync(dir)) {
      const files = readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
      const latestJson = files.filter((f) => f.endsWith(".json")).pop();
      if (latestJson) {
        try {
          const side = JSON.parse(readFileSync(join(dir, latestJson), "utf8"));
          snapshot = side.snapshot || null;
          constraints = Array.isArray(side.constraints) ? side.constraints : [];
          promptCount = side.promptCount ?? null;
        } catch {}
      }
      if (!snapshot) {
        const latestMd = files.filter((f) => f.endsWith(".md")).pop();
        if (latestMd) snapshot = join(dir, latestMd);
      }
    }

    if (prefix) {
      const idir = join(cwd, ".amnesia", "inject");
      mkdirSync(idir, { recursive: true });
      writeFileSync(
        join(idir, `${prefix}.json`),
        JSON.stringify(
          {
            session,
            snapshot,
            constraints,
            promptCount,
            trigger: input.trigger || "unknown",
            ts: new Date().toISOString(),
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
    }

    const trigger = input.trigger || "unknown";
    const parts = [`amnesia: compaction just fired (${trigger}).`];
    if (snapshot) {
      parts.push(
        `Pre-compaction snapshot: ${snapshot} \u2014 recoverable context will be injected automatically on the next prompt.`
      );
    } else {
      parts.push(
        "Run `amnesia restore` for the loss report; recoverable context will be injected automatically on the next prompt."
      );
    }
    console.log(parts.join(" "));
  } catch {}
}

export async function hookPrompt() {
  try {
    const input = await readStdinJson();
    const cwd = input.cwd || process.cwd();
    const session = input.session_id || "";
    if (!session) return;
    const marker = join(
      cwd,
      ".amnesia",
      "inject",
      `${session.slice(0, 8)}.json`
    );
    if (!existsSync(marker)) return;

    let m = {};
    try {
      m = JSON.parse(readFileSync(marker, "utf8"));
    } catch {}
    rmSync(marker, { force: true });

    const lines = [];
    lines.push(
      "[amnesia] Your context was just compacted \u2014 earlier messages were replaced by a summary."
    );
    if (Array.isArray(m.constraints) && m.constraints.length > 0) {
      lines.push(
        "Rules from before the compaction that must keep applying:"
      );
      for (const c of m.constraints.slice(0, 20)) lines.push(`- ${c}`);
    }
    if (m.snapshot) {
      lines.push(`Full pre-compaction snapshot: ${m.snapshot}`);
    }
    const additionalContext = lines.join("\n");

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        },
      })
    );
  } catch {}
}
