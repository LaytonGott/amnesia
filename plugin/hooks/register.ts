import type { EngineInterface, Register } from 'claude-code';
import { specificsBlock, type Msg } from './specifics.ts';
import { RECALL_DESCRIPTION, archivable, droppedFiles, search, toolRecord, type Rec } from './recall.ts';

// userConfig budgetChars (plugin.json declares the default and range)
const budgetOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(40000, Math.max(1000, v)) : 6000);

const keyOf = (m: Msg) => m.handle ?? `${m.role}\u0000${m.text}`;

const RECALL = 'recall';
// the newest archive files a search reads; older ones stay on disk
const SEARCH_FILES = 3000;

// <AMNESIA_HOME or <config>/amnesia>/archive/<session id>
async function archiveDir($: EngineInterface): Promise<string> {
  const id = await $.session.id();
  const own = await $.env.get('AMNESIA_HOME');
  if (own) return `${own}/archive/${id}`;
  const config = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.';
  return `${config ?? `${home}/.claude`}/amnesia/archive/${id}`;
}

const stamp = (at: number) => `${at}-${Math.random().toString(36).slice(2, 8)}`;

async function loadArchive($: EngineInterface, dir: string): Promise<Rec[]> {
  if (!(await $.fs.exists(dir))) return [];
  const files = (await $.fs.list(dir))
    .filter((f) => f.kind === 'file' && /^[tc]-.*\.json$/.test(f.name))
    .sort((a, b) => (b.name < a.name ? -1 : 1))
    .slice(0, SEARCH_FILES);
  const recs: Rec[] = [];
  for (const f of files) {
    try {
      const v = JSON.parse(String(await $.fs.read(`${dir}/${f.name}`)));
      for (const r of Array.isArray(v) ? v : [v]) {
        if (r && typeof r.text === 'string') recs.push(r as Rec);
      }
    } catch {}
  }
  return recs;
}

export const register: Register = (on, options) => {
  const budget = budgetOf(options?.budgetChars);
  const archive = options?.recall !== false;

  on('session.start', async ($, e, next) => {
    const r = await next(e);
    if (archive) {
      try {
        await $.tool.register({ name: RECALL, description: RECALL_DESCRIPTION, isDeferred: false, inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Distinctive words or strings to look for.' },
            limit: { type: 'number', description: 'Most snippets to return (default 6).' },
          },
          required: ['query'],
        } });
      } catch {}
    }
    return r;
  });

  on('tool.call', async ($, e, next) => {
    // the recall tool itself: answered here, never by core
    if (e.tool.startsWith('mcp__amnesia') && e.tool.endsWith(`__${RECALL}`)) {
      const input = e as unknown as { query?: unknown; limit?: unknown };
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? Math.min(20, Math.max(1, Math.floor(input.limit))) : 6;
      try {
        const recs = await loadArchive($, await archiveDir($));
        return { result: recs.length ? search(recs, query, limit) : 'Nothing is archived for this session yet.' };
      } catch (err) {
        return { result: `amnesia could not read this session's archive: ${String(err).slice(0, 200)}` };
      }
    }
    const r = await next(e);
    // archive the output as it happened: compaction may summarize it away, and
    // Claude Code may later clear old tool results for good
    if (archive && e.agentId === undefined && archivable(e.tool) && typeof r.text === 'string' && r.text.length > 0) {
      try {
        const at = Date.now();
        const rec = toolRecord(e.tool, e as unknown as Record<string, unknown>, r.text, at);
        await $.fs.write(`${await archiveDir($)}/t-${stamp(at)}.json`, JSON.stringify(rec));
      } catch {}
    }
    return r;
  // a failure after next() replays the settled result: a tool never runs twice
  }).catch(($, e, next) => next(e));

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e);

    const done = await next(e);
    if (done.skip !== undefined) return done;

    const inKeys = new Set(e.messages.map(keyOf));
    const outKeys = new Set(done.messages.map(keyOf));
    const dropped = e.messages.filter((m) => !outKeys.has(keyOf(m)));
    const fresh = done.messages.map((m, i) => (inKeys.has(keyOf(m)) ? -1 : i)).filter((i) => i >= 0);
    if (dropped.length === 0 || fresh.length === 0) return done;

    if (archive) {
      try {
        const at = Date.now();
        const dir = await archiveDir($);
        let k = 0;
        for (const file of droppedFiles(dropped, at)) await $.fs.write(`${dir}/c-${stamp(at)}-${k++}.json`, JSON.stringify(file));
      } catch {}
    }

    // what is still in context: the summary, and the messages kept verbatim beside it
    const kept = done.messages.filter((m) => inKeys.has(keyOf(m)));
    const inContext = [
      ...fresh.map((i) => done.messages[i]?.text ?? ''),
      ...kept.flatMap((m) => [
        m.text,
        ...m.toolUses.flatMap((u) => [JSON.stringify(u.input ?? {}), u.text ?? '']),
        ...(m.toolResults ?? []).map((r) => r.text ?? ''),
      ]),
    ].join('\n');
    const block = specificsBlock(dropped, inContext, budget, archive);
    if (!block) return done;

    const messages = [...done.messages];
    const after = fresh[fresh.length - 1] ?? 0;
    messages.splice(after + 1, 0, { role: 'user', text: block.text, toolUses: [] });
    const { tokensAfter: _stale, ...rest } = done;
    $.ui.status(`amnesia: kept ${block.included} dropped detail(s)`);
    return { ...rest, messages };
  }).catch(($, e, next) => next(e));
};
