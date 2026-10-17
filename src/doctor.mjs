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
import { HOOK_EVENTS, isOurs, isOurHookItem } from "./hooks.mjs";
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

function parseHookCommand(hook) {
  if (Array.isArray(hook.args)) {
    const i = hook.args.lastIndexOf("hook");
    if (i >= 1 && i + 1 < hook.args.length) {
      return {
        nodePath: hook.command,
        binPath: hook.args[i - 1],
        cmd: hook.args[i + 1],
        form: "exec",
      };
    }
    return null;
  }
  if (typeof hook.command !== "string") return null;
  const t = tokenize(hook.command);
  if (t.length !== 4 || t[2] !== "hook") return null;
  return { nodePath: t[0], binPath: t[1], cmd: t[3], form: "shell" };
}

export const PLUGIN_INSTALL = "/plugin install amnesia --marketplace LaytonGott/amnesia";

// Claude Code lists installed plugins in <config>/plugins/installed_plugins.json
// (keys "name@marketplace") and turns them on in settings.enabledPlugins
export function pluginState(settingsFile, settings) {
  let ids = [];
  try {
    const raw = readFileSync(join(dirname(settingsFile), "plugins", "installed_plugins.json"), "utf8");
    const j = JSON.parse(raw);
    ids = Object.keys(j.plugins ?? j).filter((k) => k.split("@")[0] === "amnesia");
  } catch {}
  const enabled = ids.filter((id) => settings?.enabledPlugins?.[id] === true);
  return { installed: ids, enabled, active: enabled.length > 0 };
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

  const plugin = pluginState(settingsFile, settings);
  if (plugin.active) {
    add("plugin", "ok", `${plugin.enabled.join(", ")} installed and enabled`);
  } else if (plugin.installed.length > 0) {
    add("plugin", "warn", `${plugin.installed.join(", ")} installed but not enabled — enable it in /plugin`);
  } else {
    add("plugin", "info", `not installed — recommended:  ${PLUGIN_INSTALL}`);
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
          if (isOurHookItem(h, cmd)) {
            commandsByEvent.push({ event, hook: h });
          }
        }
      } else {
        missing.push(event);
      }
    }
    const found = HOOK_EVENTS.length - missing.length;
    if (plugin.active && found === 0) {
      add("hooks", "info", "not installed (not needed: the plugin is active)");
    } else if (plugin.active) {
      add(
        "hooks",
        "warn",
        "command hooks are installed too: they re-inject recent prompts the plugin already covers \u2014 run  amnesia uninstall"
      );
    } else if (missing.length === 0) {
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
  for (const { event, hook } of commandsByEvent) {
    const parsed = parseHookCommand(hook);
    if (!parsed) {
      malformed.add(
        Array.isArray(hook.args)
          ? `${hook.command} ${hook.args.join(" ")}`
          : String(hook.command)
      );
      continue;
    }
    const key = `${parsed.nodePath}\u0000${parsed.binPath}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        nodePath: parsed.nodePath,
        binPath: parsed.binPath,
        events: [],
        forms: new Set(),
      });
    }
    pairs.get(key).events.push(event);
    pairs.get(key).forms.add(parsed.form);
  }
  for (const command of malformed) {
    add(
      "command",
      "fail",
      `unrecognized hook command: ${truncate(command, 70)}`
    );
  }
  for (const { nodePath, binPath, events, forms } of pairs.values()) {
    const label =
      pairs.size > 1
        ? ` (${events[0]}${events.length > 1 ? " \u2026" : ""})`
        : "";
    const shellOnly = forms.size === 1 && forms.has("shell");
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
    if (shellOnly) {
      add(
        `form${label}`,
        "warn",
        "shell-form hook \u2014 re-run `amnesia install` (exec form works under every shell; the shell form silently fails in PowerShell)"
      );
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
      style.red(`  ${fails} problem(s) found \u2014 amnesia is NOT active on this machine.`)
    );
    out.push(style.dim(`  fix: in Claude Code run  ${PLUGIN_INSTALL}`));
    out.push(style.dim("       (or, for older Claude Code:  amnesia install)"));
  } else if (plugin.active && warns === 0) {
    out.push(
      style.green("  plugin active \u2014 each compaction keeps the exact details its summary drops.")
    );
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
