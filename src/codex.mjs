import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import readline from "node:readline";
import {
  style,
  fmtTokens,
  fmtDuration,
  fmtPct,
  localTime,
  truncate,
} from "./render.mjs";

export const CODEX_ROOT = join(
  process.env.CODEX_HOME || join(homedir(), ".codex"),
  "sessions"
);

export function listCodexSessions(root = CODEX_ROOT) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = statSync(p);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch {}
        const m = e.name.match(
          /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
        );
        out.push({
          path: p,
          session: m ? m[1] : basename(e.name, ".jsonl"),
          size,
          mtimeMs,
          agent: "codex",
        });
      }
    }
  };
  walk(root);
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((b) => b && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

const SYNTHETIC_RE =
  /^(#\s*AGENTS\.md|<external_|<user_instructions|<environment_context)/i;

export async function scanCodexSession(file) {
  const messages = [];
  const compacteds = [];
  const tokenCounts = [];
  let cwd = null;
  let contextWindow = null;
  let lines = 0;

  const rl = readline.createInterface({
    input: createReadStream(file.path, "utf8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines++;
    if (!line || line[0] !== "{") continue;
    if (
      !(
        line.includes('"response_item"') ||
        line.includes('"compacted"') ||
        line.includes('"token_count"') ||
        line.includes('"session_meta"') ||
        line.includes('"turn_context"') ||
        line.includes('"item_completed"')
      )
    ) {
      continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.type === "session_meta" || o.type === "turn_context") {
      if (!cwd && o.payload && o.payload.cwd) cwd = o.payload.cwd;
      continue;
    }

    if (o.type === "response_item") {
      const p = o.payload;
      if (!p) continue;
      if (p.type === "message") {
        messages.push({
          lineNo: lines,
          id: p.id || null,
          role: p.role || "?",
          ts: o.timestamp || null,
          text: textOf(p.content) || "",
        });
      } else if (
        p.type === "custom_tool_call_output" ||
        p.type === "function_call_output"
      ) {
        messages.push({
          lineNo: lines,
          id: p.id || null,
          role: "_output",
          ts: o.timestamp || null,
          text: "",
        });
      }
      continue;
    }

    if (o.type === "compacted") {
      const p = o.payload || {};
      const rh = Array.isArray(p.replacement_history)
        ? p.replacement_history
        : [];
      const usage = p.latest_token_usage_record?.usage || {};
      compacteds.push({
        lineNo: lines,
        timestamp: o.timestamp || null,
        windowNumber: p.window_number ?? null,
        preTokens:
          usage.input_tokens != null ? parseInt(usage.input_tokens, 10) : null,
        preCached:
          usage.cached_input_tokens != null
            ? parseInt(usage.cached_input_tokens, 10)
            : null,
        retained: rh.map((m) => ({
          id: m?.id || null,
          role: m?.role || "?",
          text: textOf(m?.content) || "",
        })),
        durationMs: null,
        postTokens: null,
        beforeCount: 0,
        keptCount: 0,
        droppedCount: 0,
        droppedUsers: [],
      });
      continue;
    }

    if (o.type === "event_msg") {
      const p = o.payload || {};
      if (p.type === "item_completed" && p.item?.type === "ContextCompaction") {
        const last = compacteds.at(-1);
        if (
          last &&
          last.durationMs == null &&
          p.started_at_ms != null &&
          p.completed_at_ms != null
        ) {
          last.durationMs = p.completed_at_ms - p.started_at_ms;
        }
        continue;
      }
      if (p.type === "token_count") {
        const info = p.info || {};
        if (info.model_context_window) {
          contextWindow = info.model_context_window;
        }
        const input =
          info.last_token_usage?.input_tokens ??
          info.total_token_usage?.input_tokens ??
          null;
        if (input != null) {
          const n = parseInt(input, 10);
          if (n > 0) tokenCounts.push({ lineNo: lines, input: n });
        }
      }
    }
  }

  for (const c of compacteds) {
    const next = tokenCounts.find((t) => t.lineNo > c.lineNo);
    c.postTokens = next ? next.input : null;

    const retainedIds = new Set(c.retained.map((r) => r.id).filter(Boolean));
    const before = messages.filter((m) => m.lineNo < c.lineNo);
    const keptById = before.filter((m) => m.id && retainedIds.has(m.id)).length;
    const keptAssumed =
      keptById > 0 ? keptById : Math.min(c.retained.length, before.length);
    c.beforeCount = before.length;
    c.keptCount = c.retained.length;
    c.droppedCount = Math.max(0, c.beforeCount - keptAssumed);
    c.droppedUsers = before.filter(
      (m) =>
        m.role === "user" &&
        !(m.id && retainedIds.has(m.id)) &&
        !SYNTHETIC_RE.test(m.text)
    );
  }

  return { file, lines, cwd, contextWindow, compacteds, messages, tokenCounts };
}

export function codexToJson(env) {
  return {
    agent: "codex",
    session: env.file.session,
    path: env.file.path,
    cwd: env.cwd,
    contextWindow: env.contextWindow,
    compacteds: env.compacteds.map((c) => ({
      timestamp: c.timestamp,
      windowNumber: c.windowNumber,
      preTokens: c.preTokens,
      postTokens: c.postTokens,
      durationMs: c.durationMs,
      beforeCount: c.beforeCount,
      keptCount: c.keptCount,
      droppedCount: c.droppedCount,
      droppedUsers: c.droppedUsers.map((m) => ({
        id: m.id,
        ts: m.ts,
        text: m.text.slice(0, 500),
      })),
      retainedPreview: c.retained.find((r) => r.role === "user")?.text?.slice(0, 300) || null,
    })),
  };
}

export function renderCodexScan(entries, { root, totalFiles }) {
  const rows = entries
    .map((e) => {
      const dropped = e.compacteds.reduce(
        (s, c) => s + (c.droppedUsers?.length ?? 0),
        0
      );
      const dead = e.compacteds.reduce((s, c) => s + (c.durationMs ?? 0), 0);
      const last = e.compacteds.at(-1);
      return { e, dropped, dead, when: last?.timestamp, events: e.compacteds.length };
    })
    .sort((a, b) => b.dropped - a.dropped);

  const out = [];
  const totalDropped = rows.reduce((s, x) => s + x.dropped, 0);
  out.push("");
  out.push(style.bold("  amnesia codex") + style.dim(` \u00b7 scanning ${root}`));
  out.push(
    style.dim(
      `  ${totalFiles} rollout session(s) \u00b7 ${rows.length} with compaction \u00b7 ${fmtTokens(
        totalDropped
      )} dropped prompt(s) in total`
    )
  );
  out.push("");
  if (rows.length === 0) {
    out.push(style.green("  no compaction events found."));
    out.push("");
    return out.join("\n");
  }
  out.push(
    style.dim(
      `  ${"PROJECT".padEnd(34)} ${"SESSION".padEnd(9)} ${"WHEN".padEnd(17)} ${"EVENTS".padStart(6)} ${"DROPPED".padStart(8)} ${"DEAD".padStart(9)}`
    )
  );
  for (const x of rows) {
    const proj = truncate(
      (x.e.cwd || x.e.file.session).split(/[\\/]/).filter(Boolean).pop() || "?",
      33
    ).padEnd(34);
    const sess = x.e.file.session.slice(0, 8).padEnd(9);
    const when = (
      x.when ? String(x.when).slice(0, 16).replace("T", " ") : ""
    ).padEnd(17);
    out.push(
      `  ${proj} ${sess} ${when} ${String(x.events).padStart(6)} ${String(
        x.dropped
      ).padStart(8)} ${fmtDuration(x.dead).padStart(9)}`
    );
  }
  out.push("");
  out.push(style.dim("  receipt: ") + "amnesia codex <session-id>");
  out.push("");
  return out.join("\n");
}

export function renderCodexReceipt(env) {
  const { file, compacteds, contextWindow, cwd } = env;
  const out = [];
  out.push("");
  out.push(style.bold("  amnesia") + style.dim(" \u00b7 compaction receipt for codex"));
  out.push(style.dim(`  ${truncate(cwd || file.session, 60)}/${file.session.slice(0, 8)}`));
  out.push("");

  compacteds.forEach((c, i) => {
    out.push(style.dim("  " + "\u2500".repeat(64)));
    out.push(
      `  ${style.bold(`event ${i + 1}/${compacteds.length}`)} ${style.dim(
        `${localTime(c.timestamp)} \u00b7 window ${c.windowNumber ?? "?"}`
      )}`
    );
    out.push("");
    const drops =
      c.preTokens != null && c.postTokens != null ? c.preTokens - c.postTokens : null;
    out.push(
      `   context     ${style.bold(fmtTokens(c.preTokens))} \u2192 ${style.bold(
        fmtTokens(c.postTokens)
      )} tokens` +
        (contextWindow ? style.dim(` (window ${fmtTokens(contextWindow)})`) : "") +
        (drops != null && c.preTokens > 0
          ? style.red(`   (${fmtPct(drops, c.preTokens)} dropped)`)
          : "")
    );
    out.push(`   dead time   ${fmtDuration(c.durationMs)}`);
    out.push(
      `   replaced    ${fmtTokens(c.beforeCount)} messages \u2192 ${fmtTokens(
        c.keptCount
      )} retained (${fmtTokens(c.droppedUsers.length)} prompt${
        c.droppedUsers.length === 1 ? "" : "s"
      } dropped)`
    );
    const preview = c.retained.find((r) => r.role === "user")?.text;
    if (preview) {
      out.push("");
      out.push(style.dim("   what it kept (first retained prompt):"));
      out.push(
        style.gray(
          "   \u2502 " + truncate(preview.replace(/\s+/g, " "), 82)
        )
      );
    }
    if (c.droppedUsers.length > 0) {
      out.push("");
      out.push(style.dim("   what it dropped (oldest first):"));
      for (const m of c.droppedUsers.slice(0, 6)) {
        const t = m.ts ? String(m.ts).slice(11, 16) : "--:--";
        out.push(
          `   ${style.dim(t)}  ${style.cyan("user")}  ${truncate(
            m.text.replace(/\s+/g, " "),
            72
          )}`
        );
      }
      const more = c.droppedUsers.length - Math.min(6, c.droppedUsers.length);
      if (more > 0) {
        out.push(style.dim(`   \u2026 ${fmtTokens(more)} more`));
      }
    }
  });

  out.push(style.dim("  " + "\u2500".repeat(64)));
  out.push(
    style.dim("  made with ") +
      style.bold("amnesia") +
      style.dim(" \u00b7 see what your agent forgot \u00b7 npx amnesia-cli")
  );
  out.push("");
  return out.join("\n");
}
