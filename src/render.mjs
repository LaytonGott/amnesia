const useColor =
  Boolean(process.stdout.isTTY) &&
  !process.env.NO_COLOR &&
  process.env.TERM !== "dumb";

const wrap = (code) => (s) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s);

export const style = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

export function fmtTokens(n) {
  if (n == null) return "?";
  return Number(n).toLocaleString("en-US");
}

export function fmtDuration(ms) {
  if (ms == null) return "?";
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtPct(part, whole) {
  if (!whole || part == null) return "";
  return `${Math.round((part / whole) * 1000) / 10}%`;
}

export function localTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function truncate(s, n) {
  s = String(s ?? "");
  return s.length <= n ? s : s.slice(0, n - 1) + "\u2026";
}

export function renderScan(entries, { totalFiles, root, collapsedEvents = 0 }) {
  const rows = entries
    .map((e) => {
      const dropped = e.boundaries.reduce(
        (s, b) => s + Math.max(0, (b.preTokens ?? 0) - (b.postTokens ?? 0)),
        0
      );
      const dead = e.boundaries.reduce((s, b) => s + (b.durationMs ?? 0), 0);
      const last = e.boundaries
        .slice()
        .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))
        .at(-1);
      return { e, dropped, dead, when: last?.timestamp, events: e.boundaries.length };
    })
    .sort((a, b) => b.dropped - a.dropped);

  const out = [];
  const totalDropped = rows.reduce((s, x) => s + x.dropped, 0);
  out.push("");
  out.push(style.bold("  amnesia") + style.dim(` · scanning ${root}`));
  out.push(
    style.dim(
      `  ${totalFiles} sessions · ${rows.length} with compaction · ${fmtTokens(
        totalDropped
      )} tokens forgotten` +
        (collapsedEvents > 0
          ? ` · ${collapsedEvents} duplicate record(s) from resumed sessions collapsed`
          : "")
    )
  );
  out.push("");
  if (rows.length === 0) {
    if (totalFiles === 0) {
      out.push(style.green("  no Claude Code session files found."));
      out.push(style.dim(`  looked in ${root}`));
      out.push(style.dim("  is Claude Code installed and used on this machine?"));
    } else {
      out.push(style.green("  no compaction events found."));
      out.push(style.dim("  nothing has been forgotten (yet)."));
    }
    out.push("");
    return out.join("\n");
  }
  out.push(
    style.dim(
      `  ${"PROJECT".padEnd(34)} ${"SESSION".padEnd(9)} ${"WHEN".padEnd(17)} ${"EVENTS".padStart(6)} ${"DROPPED".padStart(12)} ${"DEAD".padStart(9)}`
    )
  );
  for (const x of rows) {
    const proj = truncate(x.e.file.project, 33).padEnd(34);
    const sess = x.e.file.session.slice(0, 8).padEnd(9);
    const when = (
      x.when ? String(x.when).slice(0, 16).replace("T", " ") : ""
    ).padEnd(17);
    out.push(
      `  ${proj} ${sess} ${when} ${String(x.events).padStart(6)} ${fmtTokens(
        x.dropped
      ).padStart(12)} ${fmtDuration(x.dead).padStart(9)}`
    );
  }
  out.push("");
  out.push(style.dim("  receipt: ") + "amnesia <session-id>");
  out.push("");
  return out.join("\n");
}

export function renderReceipt(env) {
  const { file, boundaries } = env;
  const out = [];
  out.push("");
  out.push(style.bold("  amnesia") + style.dim(" · compaction receipt for claude-code"));
  out.push(style.dim(`  ${truncate(file.project, 46)}/${file.session.slice(0, 8)}`));

  if (boundaries.length === 0) {
    out.push("");
    out.push(style.green("  no compaction events found in this session."));
    out.push(style.dim("  nothing has been forgotten (yet)."));
    out.push("");
    return out.join("\n");
  }

  boundaries.forEach((b, i) => {
    out.push(style.dim("  " + "\u2500".repeat(64)));
    out.push(
      `  ${style.bold(`event ${i + 1}/${boundaries.length}`)} ${style.dim(
        `${localTime(b.timestamp)} UTC · trigger ${b.trigger}`
      )}`
    );
    out.push("");
    const dropped =
      b.preTokens != null && b.postTokens != null ? b.preTokens - b.postTokens : null;
    out.push(
      `   context     ${style.bold(fmtTokens(b.preTokens))} \u2192 ${style.bold(
        fmtTokens(b.postTokens)
      )} tokens` +
        (dropped != null && b.preTokens > 0
          ? style.red(`   (${fmtPct(dropped, b.preTokens)} dropped)`)
          : "")
    );
    out.push(
      `   dead time   ${fmtDuration(b.durationMs)}${
        b.precomputed ? style.dim(" (precomputed)") : ""
      }`
    );
    const pl = (n, one, many) => `${fmtTokens(n)} ${n === 1 ? one : many}`;
    out.push(
      `   replaced    ~${pl(
        b.coveredUsers + b.coveredAssistants,
        "message",
        "messages"
      )} (${pl(b.coveredUsers, "prompt", "prompts")}, ${pl(
        b.coveredAssistants,
        "reply",
        "replies"
      )}, ${pl(b.coveredToolResults, "tool result", "tool results")})`
    );
    if (b.originSession) {
      out.push(
        `   origin      replaced history lives in session ${b.originSession.slice(0, 8)} (this file starts post-compaction)`
      );
    }
    if (b.preservedCount != null) {
      out.push(`   preserved   ${fmtTokens(b.preservedCount)} message(s) kept verbatim`);
    }
    if (b.pluginBlock) {
      out.push(
        `   amnesia     ${style.green(
          `block kept ${fmtTokens(b.pluginBlock.details)} exact detail(s) the summary dropped`
        )}${style.dim(` (${fmtTokens(b.pluginBlock.chars)} chars)`)}`
      );
    }
    if (b.cumulativeDroppedTokens != null) {
      out.push(
        `   cumulative  ${style.red(
          fmtTokens(b.cumulativeDroppedTokens) + " tokens forgotten this session"
        )}`
      );
    }
    if (b.summary) {
      out.push("");
      out.push(style.dim("   what your agent now believes:"));
      const all = b.summary.split(/\r?\n/).filter((x) => x.trim());
      for (const l of all.slice(0, 7)) {
        out.push(style.gray("   \u2502 " + truncate(l.trim(), 82)));
      }
      if (all.length > 7) out.push(style.gray("   \u2502 \u2026"));
    }
    if (b.previews.length) {
      out.push("");
      out.push(style.dim("   what it dropped (oldest first):"));
      for (const p of b.previews) {
        const t = p.timestamp ? String(p.timestamp).slice(11, 16) : "--:--";
        out.push(
          `   ${style.dim(t)}  ${style.cyan("user")}  ${truncate(
            p.text.replace(/\s+/g, " "),
            72
          )}`
        );
      }
      const more = b.coveredUsers - b.previews.length;
      if (more > 0) {
        out.push(
          style.dim(
            `   \u2026 ${fmtTokens(more)} more prompt${more === 1 ? "" : "s"} not shown`
          )
        );
      }
    }
    if (b.pluginBlock?.items.length) {
      out.push("");
      out.push(style.dim("   what amnesia kept (first 5):"));
      for (const it of b.pluginBlock.items.slice(0, 5)) {
        out.push(`   ${style.green("+")} ${truncate(it.replace(/\s+/g, " "), 82)}`);
      }
      const rest = b.pluginBlock.items.length - 5;
      if (rest > 0) out.push(style.dim(`   \u2026 ${fmtTokens(rest)} more line${rest === 1 ? "" : "s"}`));
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
