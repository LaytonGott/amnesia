import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "amnesia.mjs");
const tmp = mkdtempSync(join(tmpdir(), "amnesia-doctor-"));

after(() => rmSync(tmp, { recursive: true, force: true }));

const env = () => ({ ...process.env, AMNESIA_HOME: join(tmp, "store") });

const run = (args) =>
  execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: env(),
  });

const runFailing = (args) => {
  try {
    const out = run(args);
    return { failed: false, out };
  } catch (e) {
    return { failed: true, out: String(e.stdout || "") };
  }
};

test("doctor passes on a healthy install", () => {
  const s = join(tmp, "settings-ok.json");
  run(["install", "--settings", s]);
  const out = run(["doctor", "--settings", s]);
  assert.ok(out.includes("all checks passed"));
  assert.ok(out.includes("responds"));
});

test("doctor fails when hooks are missing", () => {
  const s = join(tmp, "settings-empty.json");
  writeFileSync(s, JSON.stringify({ model: "opus" }));
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("missing"));
  assert.ok(r.out.includes("amnesia install"));
});

test("doctor detects a dead node path", () => {
  const s = join(tmp, "settings-dead.json");
  const bin = join(HERE, "..", "bin", "amnesia.mjs");
  const cmd = (sub) => `"C:\\nope\\node.exe" "${bin}" hook ${sub}`;
  writeFileSync(
    s,
    JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: cmd("precompact") }] },
        ],
        PostCompact: [
          { matcher: "", hooks: [{ type: "command", command: cmd("postcompact") }] },
        ],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: cmd("prompt") }] },
        ],
      },
    })
  );
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("NOT FOUND"));
});

test("doctor validates every hook command, not just the first", () => {
  const s = join(tmp, "settings-mixed.json");
  const bin = join(HERE, "..", "bin", "amnesia.mjs");
  const good = (sub) => `"${process.execPath}" "${bin}" hook ${sub}`;
  writeFileSync(
    s,
    JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: good("precompact") }] },
        ],
        PostCompact: [
          { matcher: "", hooks: [{ type: "command", command: good("postcompact") }] },
        ],
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `"C:\\nope\\node.exe" "${bin}" hook prompt`,
              },
            ],
          },
        ],
      },
    })
  );
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("NOT FOUND"));
});

test("doctor warns on shell-form hooks", () => {
  const s = join(tmp, "settings-shellform.json");
  const bin = join(HERE, "..", "bin", "amnesia.mjs");
  const cmd = (sub) => `"${process.execPath}" "${bin}" hook ${sub}`;
  writeFileSync(
    s,
    JSON.stringify({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: cmd("precompact") }] },
        ],
        PostCompact: [
          { matcher: "", hooks: [{ type: "command", command: cmd("postcompact") }] },
        ],
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: cmd("prompt") }] },
        ],
      },
    })
  );
  const out = run(["doctor", "--settings", s]);
  assert.ok(out.includes("shell-form"));
  assert.ok(out.includes("warning"));
});

test("doctor survives unparseable settings", () => {
  const s = join(tmp, "settings-bad.json");
  writeFileSync(s, "{nope");
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.failed);
  assert.ok(r.out.includes("cannot parse"));
});

function withPlugin(name, { enabled, hooks = false }) {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(
    join(dir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "amnesia@amnesia": [{ scope: "user", version: "0.5.0" }] } })
  );
  const s = join(dir, "settings.json");
  writeFileSync(s, JSON.stringify({ enabledPlugins: { "amnesia@amnesia": enabled } }));
  if (hooks) run(["install", "--settings", s, "--hooks"]);
  return s;
}

test("doctor passes with the plugin active and no command hooks", () => {
  const s = withPlugin("plugin-only", { enabled: true });
  const out = run(["doctor", "--settings", s]);
  assert.ok(out.includes("amnesia@amnesia installed and enabled"));
  assert.ok(out.includes("not needed: the plugin is active"));
  assert.ok(out.includes("plugin active"));
});

test("doctor warns when the plugin and the command hooks are both active", () => {
  const s = withPlugin("plugin-and-hooks", { enabled: true, hooks: true });
  const out = run(["doctor", "--settings", s]);
  assert.ok(out.includes("command hooks are installed too"));
  assert.ok(out.includes("amnesia uninstall"));
});

test("doctor warns when the plugin is installed but disabled, and still checks hooks", () => {
  const s = withPlugin("plugin-disabled", { enabled: false });
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.out.includes("installed but not enabled"));
  assert.ok(r.failed);
});

test("doctor recommends the plugin when nothing is installed", () => {
  const s = join(tmp, "settings-none.json");
  writeFileSync(s, "{}");
  const r = runFailing(["doctor", "--settings", s]);
  assert.ok(r.out.includes("/plugin install amnesia --marketplace LaytonGott/amnesia"));
});

test("install skips the hooks when the plugin is active, unless --hooks", () => {
  const s = withPlugin("install-plugin-active", { enabled: true });
  const out = run(["install", "--settings", s]);
  assert.ok(out.includes("command hooks are not needed"));
  assert.ok(!readFileSync(s, "utf8").includes("PreCompact"));
  run(["install", "--settings", s, "--hooks"]);
  assert.ok(readFileSync(s, "utf8").includes("PreCompact"));
});

test("install without the plugin installs hooks and recommends the plugin", () => {
  const s = join(tmp, "settings-install-rec.json");
  const out = run(["install", "--settings", s]);
  assert.ok(out.includes("installed"));
  assert.ok(out.includes("/plugin install amnesia --marketplace LaytonGott/amnesia"));
});
