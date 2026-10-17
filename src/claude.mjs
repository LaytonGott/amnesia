import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import readline from "node:readline";

export const DEFAULT_ROOT = join(homedir(), ".claude", "projects");

export function listSessionFiles(root = DEFAULT_ROOT) {
  const out = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = join(root, p.name);
    let files;
    try {
      files = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const path = join(dir, f.name);
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {}
      out.push({
        path,
        project: p.name,
        session: f.name.slice(0, -".jsonl".length),
        size,
      });
    }
  }
  return out;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const t = content.find(
      (b) => b && b.type === "text" && typeof b.text === "string"
    );
    if (t) return t.text;
  }
  return null;
}

export async function scanFile(file, { withPreviews = false, maxPreviews = 6 } = {}) {
  const boundaries = [];
  const users = [];
  const assistants = [];
  const toolBatches = [];
  let current = null;
  let lines = 0;

  const rl = readline.createInterface({
    input: createReadStream(file.path, "utf8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines++;
    if (!line) continue;

    if (line.includes("compact_boundary")) {
      try {
        const o = JSON.parse(line);
        if (o && o.type === "system" && o.subtype === "compact_boundary") {
          const md = o.compactMetadata || o.compact_metadata || {};
          const uuids = Array.isArray(md.preservedMessages?.uuids)
            ? md.preservedMessages.uuids
            : [];
          current = {
            lineNo: lines,
            timestamp: o.timestamp || null,
            trigger: md.trigger || "unknown",
            preTokens: md.preTokens ?? null,
            postTokens: md.postTokens ?? null,
            durationMs: md.durationMs ?? null,
            cumulativeDroppedTokens: md.cumulativeDroppedTokens ?? null,
            precomputed: md.precomputed === true,
            preservedCount: uuids.length || null,
            preservedUuids: new Set(uuids),
            coveredUsers: 0,
            coveredAssistants: 0,
            coveredToolResults: 0,
            summary: null,
            previews: [],
          };
          boundaries.push(current);
        }
      } catch {}
      continue;
    }

    const maybeUser =
      line.includes('"type":"user"') || line.includes('"type": "user"');
    if (maybeUser) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || o.type !== "user") continue;
      const content = o.message?.content;
      const isToolResult =
        Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
      if (isToolResult) {
        toolBatches.push({ lineNo: lines, uuid: o.uuid || null });
        continue;
      }
      if (o.isMeta === true) continue;
      if (o.isCompactSummary === true) {
        if (current && current.summary == null) {
          current.summary = extractText(content) || "";
        }
        continue;
      }
      const text = extractText(content);
      users.push({
        lineNo: lines,
        timestamp: o.timestamp || null,
        uuid: o.uuid || null,
        text: (text || "").trim(),
      });
      continue;
    }

    if (line.includes('"type":"assistant"') || line.includes('"type": "assistant"')) {
      let uuid = null;
      try {
        uuid = JSON.parse(line)?.uuid || null;
      } catch {}
      assistants.push({ lineNo: lines, uuid });
      continue;
    }
  }

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const prev = i > 0 ? boundaries[i - 1] : null;
    const prevPres = prev ? prev.preservedUuids : null;
    const curPres = b.preservedUuids;
    const dropped = (arr) =>
      arr
        .filter(
          (m) =>
            ((!prev || m.lineNo > prev.lineNo) && m.lineNo < b.lineNo) ||
            (prevPres && m.uuid && prevPres.has(m.uuid))
        )
        .filter((m) => !(m.uuid && curPres.has(m.uuid)));
    const droppedUsers = dropped(users);
    b.coveredUsers = droppedUsers.length;
    b.coveredAssistants = dropped(assistants).length;
    b.coveredToolResults = dropped(toolBatches).length;
    if (withPreviews) {
      b.previews = droppedUsers
        .slice()
        .sort((a, z) => a.lineNo - z.lineNo)
        .slice(0, maxPreviews)
        .map((u) => ({ timestamp: u.timestamp, uuid: u.uuid, text: u.text }));
    }
  }
  for (const b of boundaries) b.preservedUuids = undefined;

  return {
    file,
    lines,
    boundaries,
    userSeen: users.length,
    assistantSeen: assistants.length,
    toolResultsSeen: toolBatches.length,
  };
}

export function encodeProjectPath(absPath) {
  return String(absPath).replace(/[^A-Za-z0-9]/g, "-");
}

export function amnesiaHome() {
  if (process.env.AMNESIA_HOME) return process.env.AMNESIA_HOME;
  const conf = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(conf, "amnesia");
}

export function projectStore(cwd) {
  return join(amnesiaHome(), encodeProjectPath(cwd || process.cwd()));
}

export async function collectHistory(file) {
  const prompts = [];
  const boundaries = [];
  let lines = 0;

  const rl = readline.createInterface({
    input: createReadStream(file.path, "utf8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lines++;
    if (!line) continue;

    if (line.includes("compact_boundary")) {
      try {
        const o = JSON.parse(line);
        if (o && o.type === "system" && o.subtype === "compact_boundary") {
          const md = o.compactMetadata || o.compact_metadata || {};
          const uuids = Array.isArray(md.preservedMessages?.uuids)
            ? md.preservedMessages.uuids
            : [];
          boundaries.push({
            lineNo: lines,
            timestamp: o.timestamp || null,
            trigger: md.trigger || "unknown",
            preTokens: md.preTokens ?? null,
            postTokens: md.postTokens ?? null,
            durationMs: md.durationMs ?? null,
            cumulativeDroppedTokens: md.cumulativeDroppedTokens ?? null,
            preservedUuids: new Set(uuids),
            summary: null,
          });
        }
      } catch {}
      continue;
    }

    const maybeUser =
      line.includes('"type":"user"') || line.includes('"type": "user"');
    if (!maybeUser) continue;

    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.type !== "user") continue;
    const content = o.message?.content;
    if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
      continue;
    }
    if (o.isMeta === true) continue;
    if (o.isCompactSummary === true) {
      const last = boundaries.at(-1);
      if (last && last.summary == null) last.summary = extractText(content) || "";
      continue;
    }
    const text = extractText(content);
    if (text && text.trim()) {
      prompts.push({
        lineNo: lines,
        timestamp: o.timestamp || null,
        uuid: o.uuid || null,
        text: text.trim(),
      });
    }
  }

  return { file, lines, prompts, boundaries };
}

export function droppedForBoundary(history, index) {
  const b = history.boundaries[index];
  const prev = index > 0 ? history.boundaries[index - 1] : null;
  const prevPres = prev ? prev.preservedUuids : null;
  return history.prompts.filter(
    (p) =>
      (((!prev || p.lineNo > prev.lineNo) && p.lineNo < b.lineNo) ||
        (prevPres && p.uuid && prevPres.has(p.uuid))) &&
      !(p.uuid && b.preservedUuids.has(p.uuid))
  );
}

export function eventKeyOf(b) {
  return `${b.timestamp}|${b.preTokens}|${b.postTokens}`;
}

export const CLEARED_PLACEHOLDER = "[Old tool result content cleared]";

export async function scanPersisted(file) {
  const refs = [];
  const cleared = [];

  const rl = readline.createInterface({
    input: createReadStream(file.path, "utf8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.includes("tool_result")) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || o.type !== "user") continue;
    const content = o.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== "tool_result") continue;
      let s = null;
      if (typeof b.content === "string") {
        s = b.content;
      } else if (Array.isArray(b.content)) {
        s = b.content
          .filter((x) => x && x.type === "text" && typeof x.text === "string")
          .map((x) => x.text)
          .join("\n");
      }
      if (!s) continue;
      if (s.includes("<persisted-output>")) {
        const m =
          s.match(/Full output saved to:\s*([^\r\n]+)/) ||
          s.match(/Tool result saved to:\s*([^\r\n]+)/);
        const sizeM = s.match(/\(([\d.]+\s*[KMG]B)\)/);
        const prevM = s.match(/Preview \(first [^)]*\):\s*\r?\n([\s\S]*)$/);
        refs.push({
          toolUseId: b.tool_use_id || null,
          timestamp: o.timestamp || null,
          path: m ? m[1].trim() : null,
          sizeLabel: sizeM ? sizeM[1] : null,
          preview: prevM ? prevM[1].trim().slice(0, 600) : null,
        });
      } else if (s.trim() === CLEARED_PLACEHOLDER) {
        cleared.push({
          toolUseId: b.tool_use_id || null,
          timestamp: o.timestamp || null,
        });
      }
    }
  }

  return { refs, cleared };
}
