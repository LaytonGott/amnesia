import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { amnesiaHome, projectStore } from "./claude.mjs";
import { HOOK_EVENTS, isOurs } from "./hooks.mjs";
import { style, truncate } from "./render.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function ownVersion() {
  try {
    return JSON.parse(
      readFileSync(join(MODULE_DIR, "..", "package.json"), "utf8")
    ).version;
  } catch {
    return "unknown";
  }
}

function tokenize(command) {
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return tokens;
}

function parseHookCommand(command) {
  const t = tokenize(command);
  if (t.length !== 4 || t[2] !== "hook") return null;
  return { nodePath: t[0], binPath: t[1], cmd: t[3] };
}

export function runDoctor({ settingsPath } = {}) {
  const settingsFile = settingsPath;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  let settings = null;
  if (!existsSync(settingsFile)) {
    add("settings", "fail", `not found: ${settingsFile}`);
  } else {
    try {
      let raw = readFileSync(settingsFile, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      settings = raw.trim() ? JSON.parse(raw) : {};
      add("settings", "ok", `${settingsFile} parses`);
    } catch (e) {
      add("settings", "fail", `cannot parse ${settingsFile}: ${e.message}`);
    }
  }

  const commandsByEvent = [];
  if (settings) {
    const hooks =
      settings.hooks && typeof settings.hooks === "object"
        ? settings.hooks
        : {};
    const missing = [];
    for (const { event, cmd } of HOOK_EVENTS) {
      const list = Array.isArray(hooks[event]) ? hooks[event] : [];
      const entry = list.find((e) => isOurs(e, cmd));
      if (entry) {
        for (const h of entry.hooks) {
          if (h.command && h.command.includes("amnesia")) {
            commandsByEvent.push({ event, command: h.command });
          }
        }
      } else {
        missing.push(event);
      }
    }
    if (missing.length === 0) {
      add(
        "hooks",
        "ok",
        HOOK_EVENTS.map((h) => h.event).join(" \u00b7 ")
      );
    } else {
      add("hooks", "fail", `missing: ${missing.join(", ")}`);
    }
  }

  const pairs = new Map();
  const malformed = new Set();
  for (const { event, command } of commandsByEvent) {
    const parsed = parseHookCommand(command);
    if (!parsed) {
      malformed.add(command);
      continue;
    }
    const key = `${parsed.nodePath}\u0000${parsed.binPath}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        nodePath: parsed.nodePath,
        binPath: parsed.binPath,
        events: [],
      });
    }
    pairs.get(key).events.push(event);
  }
  for (const command of malformed) {
    add(
      "command",
      "fail",
      `unrecognized hook command: ${truncate(command, 70)}`
    );
  }
  for (const { nodePath, binPath, events } of pairs.values()) {
    const label =
      pairs.size > 1
        ? ` (${events[0]}${events.length > 1 ? " \u2026" : ""})`
        : "";
    const nodeOk = existsSync(nodePath);
    add(
      `node${label}`,
      nodeOk ? "ok" : "fail",
      nodeOk ? nodePath : `${nodePath} \u2014 NOT FOUND`
    );
    const binOk = existsSync(binPath);
    if (!binOk) {
      add(
        `bin${label}`,
        "fail",
        `${binPath} \u2014 NOT FOUND (amnesia moved?)`
      );
    } else if (!nodeOk) {
      add(`bin${label}`, "warn", `${binPath} exists, but its node is missing`);
    } else {
      try {
        const out = execFileSync(nodePath, [binPath, "--version"], {
          encoding: "utf8",
          timeout: 5000,
        }).trim();
        const expected = ownVersion();
        if (out.includes(expected)) {
          add(`bin${label}`, "ok", `${binPath} responds (${out})`);
        } else {
          add(
            `bin${label}`,
            "warn",
            `responds (${out}) but this copy is ${expected} \u2014 version mismatch`
          );
        }
      } catch (e) {
        add(
          `bin${label}`,
          "fail",
          `does not respond: ${truncate(String(e.message || e), 70)}`
        );
      }
    }
  }

  const store = amnesiaHome();
  try {
    mkdirSync(store, { recursive: true });
    const probe = join(store, ".doctor-probe");
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    add("store", "ok", `${store} writable`);
  } catch (e) {
    add("store", "fail", `${store} not writable: ${e.message}`);
  }

  const proj = projectStore(process.cwd());
  let snapCount = 0;
  let pending = 0;
  try {
    snapCount = readdirSync(join(proj, "snapshots")).filter((f) =>
      f.endsWith(".md")
    ).length;
  } catch {}
  try {
    pending = readdirSync(join(proj, "inject")).filter((f) =>
      f.endsWith(".json")
    ).length;
  } catch {}
  const info = [];
  if (snapCount > 0) info.push(`${snapCount} snapshot(s)`);
  if (pending > 0) info.push(`${pending} pending injection(s)`);
  add("project", "info", `${proj}${info.length ? " (" + info.join(", ") + ")" : ""}`);

  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const out = [];
  out.push("");
  out.push(style.bold("  amnesia") + style.dim(" \u00b7 doctor"));
  out.push("");
  const mark = (s) =>
    s === "ok"
      ? style.green("\u2713")
      : s === "warn"
        ? style.yellow("!")
        : s === "fail"
          ? style.red("\u2717")
          : style.dim("\u00b7");
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    out.push(`  ${c.name.padEnd(width)}  ${mark(c.status)} ${style.dim(c.detail)}`);
  }
  out.push("");
  if (fails > 0) {
    out.push(
      style.red(`  ${fails} problem(s) found \u2014 hooks are NOT fully active.`)
    );
    out.push(style.dim("  fix: run  amnesia install"));
  } else if (warns > 0) {
    out.push(
      style.yellow(`  ${warns} warning(s) \u2014 hooks are active; check the notes above.`)
    );
  } else {
    out.push(
      style.green("  all checks passed \u2014 forgetting heals itself on this machine.")
    );
  }
  out.push("");
  console.log(out.join("\n"));
  return { checks, exitCode: fails > 0 ? 1 : 0 };
}
