import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fmtTokens, fmtPct, fmtDuration } from "./render.mjs";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );

export function cardOutputPath(outPath, session) {
  if (outPath) {
    return isAbsolute(outPath) ? outPath : join(process.cwd(), outPath);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return join(
    process.cwd(),
    `amnesia-card-${session.slice(0, 8)}-${stamp}.html`
  );
}

export function renderCardHtml(env) {
  const { file, boundaries } = env;
  const b = boundaries.at(-1);
  if (!b) return null;

  const dropped =
    b.preTokens != null && b.postTokens != null ? b.preTokens - b.postTokens : null;
  const pct = dropped != null && b.preTokens ? fmtPct(dropped, b.preTokens) : "";
  const date = b.timestamp ? String(b.timestamp).slice(0, 10) : "";
  const previews = (b.previews || []).slice(0, 3);

  const previewHtml = previews
    .map((p) => {
      const t = p.timestamp ? String(p.timestamp).slice(11, 16) : "--:--";
      return `<div class="drop"><span class="t">${esc(t)}</span><span class="u">user</span><span class="x">${esc(
        p.text.replace(/\s+/g, " ").slice(0, 110)
      )}</span></div>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>amnesia card - ${esc(file.session.slice(0, 8))}</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    background: #14171f; min-height: 100vh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; padding: 40px;
  }
  .card {
    width: 1024px; padding: 60px 68px 48px; border-radius: 28px;
    background: linear-gradient(150deg, #0d1017 0%, #171c28 100%);
    color: #e8ecf4; border: 1px solid #2a3142;
    box-shadow: 0 30px 80px rgba(0, 0, 0, .55);
  }
  .brand { font-size: 20px; letter-spacing: 3px; color: #8fa3c8; text-transform: uppercase; font-weight: 600; }
  .brand b { color: #fff; }
  .sub { margin-top: 10px; color: #7d8aa5; font-size: 17px; font-family: ui-monospace, Consolas, monospace; }
  .big { margin-top: 46px; font-size: 74px; font-weight: 800; letter-spacing: -2px; line-height: 1; font-family: ui-monospace, Consolas, monospace; }
  .big .arrow { color: #55627e; margin: 0 8px; }
  .big .post { color: #9fb4dd; }
  .tags { margin-top: 26px; display: flex; gap: 14px; flex-wrap: wrap; }
  .pill { padding: 10px 18px; border-radius: 999px; font-size: 19px; font-weight: 700; }
  .pill.red { background: #3a1620; color: #ff6b7d; border: 1px solid #632734; }
  .pill.gray { background: #1b2130; color: #93a2c0; border: 1px solid #2c3549; }
  .drops { margin-top: 42px; border-top: 1px solid #232c3e; padding-top: 26px; }
  .drops .h { color: #7d8aa5; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 18px; }
  .drop { display: flex; gap: 14px; align-items: baseline; margin: 12px 0; font-size: 18px; }
  .drop .t { color: #5e6c8a; font-family: ui-monospace, Consolas, monospace; font-size: 15px; }
  .drop .u { color: #6fd3ea; font-weight: 700; font-size: 15px; }
  .drop .x { color: #c7d2e6; }
  .foot { margin-top: 48px; color: #5e6c8a; font-size: 15px; display: flex; justify-content: space-between; }
  .foot b { color: #9fb4dd; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand"><b>amnesia</b> - compaction receipt</div>
    <div class="sub">claude-code &middot; session ${esc(file.session.slice(0, 8))} &middot; ${esc(date)}</div>
    <div class="big">${esc(fmtTokens(b.preTokens))}<span class="arrow">&rarr;</span><span class="post">${esc(fmtTokens(b.postTokens))}</span> tokens</div>
    <div class="tags">
      ${pct ? `<span class="pill red">${esc(pct)} of context dropped</span>` : ""}
      <span class="pill gray">frozen ${esc(fmtDuration(b.durationMs))}</span>
      ${
        b.cumulativeDroppedTokens != null
          ? `<span class="pill gray">${esc(fmtTokens(b.cumulativeDroppedTokens))} forgotten this session</span>`
          : ""
      }
    </div>
    ${
      previews.length
        ? `<div class="drops"><div class="h">what it dropped</div>${previewHtml}</div>`
        : ""
    }
    <div class="foot"><span>see what your agent forgot</span><span><b>npx amnesia-cli</b> &middot; github.com/LaytonGott/amnesia</span></div>
  </div>
</body>
</html>
`;
}

export function writeCard(outPath, env) {
  const html = renderCardHtml(env);
  if (!html) return null;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");
  return outPath;
}
