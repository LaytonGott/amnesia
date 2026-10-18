import type { EngineInterface, Register } from 'claude-code';
import { specificsBlock, type Msg } from './specifics.ts';
import { RECALL_DESCRIPTION, archivable, droppedFiles, promptRecall, saidRecord, search, toolRecord, type Rec } from './recall.ts';

// userConfig budgetChars (plugin.json declares the default and range)
const budgetOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(40000, Math.max(1000, v)) : 6000);

const keyOf = (m: Msg) => m.handle ?? `${m.role}\u0000${m.text}`;

const RECALL = 'recall';
// the newest archive files a search reads; older ones stay on disk
const SEARCH_FILES = 3000;

// <AMNESIA_HOME or <config>/amnesia>/archive
async function archiveRoot($: EngineInterface): Promise<string> {
  const own = await $.env.get('AMNESIA_HOME');
  if (own) return `${own}/archive`;
  const config = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.';
  return `${config ?? `${home}/.claude`}/amnesia/archive`;
}

// <archive root>/<session id>
async function archiveDir($: EngineInterface): Promise<string> {
  return `${await archiveRoot($)}/${await $.session.id()}`;
}

// the project's other sessions searched by recall's project scope, newest first,
// and the newest archive files read from each
const OTHER_SESSIONS = 40;
const OTHER_FILES = 600;
const folderKey = (p: unknown) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : null);

// what other sessions of this project said (p- files) and had replaced (c- files);
// a session is this project's when its meta.json names the same folder
async function projectRecords($: EngineInterface, cwd: string): Promise<Rec[]> {
  const root = await archiveRoot($);
  const me = await $.session.id();
  if (!(await $.fs.exists(root))) return [];
  const here = folderKey(cwd);
  const dirs = (await $.fs.list(root)).filter((d) => d.kind === 'dir' && d.name !== me).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recs: Rec[] = [];
  let sessions = 0;
  for (const d of dirs) {
    if (sessions >= OTHER_SESSIONS) break;
    const dir = `${root}/${d.name}`;
    try {
      if (folderKey(JSON.parse(String(await $.fs.read(`${dir}/meta.json`)))?.cwd) !== here) continue;
    } catch {
      continue;
    }
    sessions++;
    for (const r of await loadArchive($, dir, /^[pc]-.*\.json$/, OTHER_FILES)) recs.push({ ...r, session: d.name });
  }
  return recs;
}

// prompt origins that are someone asking for work, not a machine's message
const PERSON = new Set(['composer', 'bridge', 'sdk', 'channel']);

const stamp = (at: number) => `${at}-${Math.random().toString(36).slice(2, 8)}`;

// t- files: tool outputs as they happened; c- files: what a compaction replaced;
// p- files: what the person and the agent said (read by other sessions only)
async function loadArchive($: EngineInterface, dir: string, files_ = /^[tc]-.*\.json$/, most = SEARCH_FILES): Promise<Rec[]> {
  if (!(await $.fs.exists(dir))) return [];
  const files = (await $.fs.list(dir))
    .filter((f) => f.kind === 'file' && files_.test(f.name))
    .sort((a, b) => (b.name < a.name ? -1 : 1))
    .slice(0, most);
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
  // naming what did not fit only helps when the agent can look it up
  const index = archive && options?.lossIndex !== false;
  // just-in-time recall: attach the replaced messages a prompt is about
  const jit = archive && options?.autoRecall !== false;
  // what was attached since the last compaction, so the same message is not sent twice
  let attached = new Set<string>();

  on('session.start', async ($, e, next) => {
    const r = await next(e);
    if (archive) {
      try {
        await $.tool.register({ name: RECALL, description: RECALL_DESCRIPTION, isDeferred: false, inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Distinctive words or strings to look for.' },
            limit: { type: 'number', description: 'Most snippets to return (default 6).' },
            scope: { type: 'string', enum: ['session', 'project'], description: 'session (default): this session. project: what was said in this project\'s other sessions.' },
          },
          required: ['query'],
        } });
      } catch {}
      // which project this session belongs to, for other sessions' project-scope recall
      try {
        await $.fs.write(`${await archiveDir($)}/meta.json`, JSON.stringify({ cwd: e.cwd, at: Date.now() }));
      } catch {}
    }
    return r;
  });

  on('tool.call', async ($, e, next) => {
    // the recall tool itself: answered here, never by core
    if (e.tool.startsWith('mcp__amnesia') && e.tool.endsWith(`__${RECALL}`)) {
      const input = e as unknown as { query?: unknown; limit?: unknown; scope?: unknown };
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? Math.min(20, Math.max(1, Math.floor(input.limit))) : 6;
      if (input.scope === 'project') {
        try {
          const recs = await projectRecords($, await $.session.cwd());
          return { result: recs.length ? search(recs, query, limit, 8000, { project: true }) : "No other session of this project has kept a log yet: amnesia starts one in each session it runs in." };
        } catch (err) {
          return { result: `amnesia could not read this project's other sessions: ${String(err).slice(0, 200)}` };
        }
      }
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

  // a prompt someone typed (or sent through the SDK), never a slash command, a
  // hidden prompt, a plugin's or a task notification: if it shares rare words
  // with messages a compaction replaced, those messages ride beside it
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind;
    const person = !e.command && !e.isMeta && (kind === undefined || PERSON.has(kind));
    // logged for the project's other sessions to search
    if (archive && person && e.text.trim()) {
      try {
        const at = Date.now();
        await $.fs.write(`${await archiveDir($)}/p-${stamp(at)}.json`, JSON.stringify(saidRecord('user', e.text, at)));
      } catch {}
    }
    if (!jit || !person) return next(e);
    let found: ReturnType<typeof promptRecall> = null;
    try {
      const recs = await loadArchive($, await archiveDir($), /^c-.*\.json$/);
      found = promptRecall(recs, e.text, { skip: attached });
    } catch {}
    if (!found) return next(e);
    for (const k of found.keys) attached.add(k);
    $.ui.status(`amnesia: attached ${found.keys.length} earlier message(s) to this prompt`);
    return next({ ...e, context: [...(e.context ?? []), found.text] });
  }).catch(($, e, next) => next(e));

  // the agent's final answer each turn, logged for the project's other sessions
  on('turn.complete', async ($, e, next) => {
    if (archive && e.agentId === undefined && typeof e.answer === 'string' && e.answer.trim()) {
      try {
        const at = Date.now();
        await $.fs.write(`${await archiveDir($)}/p-${stamp(at)}.json`, JSON.stringify(saidRecord('assistant', e.answer, at)));
      } catch {}
    }
    return next(e);
  }).catch(($, e, next) => next(e));

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e);

    attached = new Set();
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
    const block = specificsBlock(dropped, inContext, budget, archive, index);
    if (!block) return done;

    const messages = [...done.messages];
    const after = fresh[fresh.length - 1] ?? 0;
    messages.splice(after + 1, 0, { role: 'user', text: block.text, toolUses: [] });
    const { tokensAfter: _stale, ...rest } = done;
    $.ui.status(`amnesia: kept ${block.included} dropped detail(s)${block.indexed ? `, named ${block.indexed} more` : ''}`);
    return { ...rest, messages };
  }).catch(($, e, next) => next(e));
};
