import { test, expect, mock } from 'claude-code/testing';
import type { On, SessionMessage } from 'claude-code';
import { JIT_LEAD, promptRecall, promptTerms, search, termsOf, toolRecord, droppedFiles, type Rec } from '../hooks/recall.ts';

const rec = (label: string, text: string, at: number, kind: Rec['kind'] = 'tool'): Rec => ({ kind, label, text, at });

test('identifiers stay whole as query terms', () => {
  expect(termsOf('port for cobalt-payouts in src/runtime/config.ts, v1.2.3')).toEqual([
    'port', 'for', 'cobalt-payouts', 'in', 'src/runtime/config.ts', 'v1.2.3',
  ]);
});

test('a record with every term outranks one that repeats a single term', () => {
  const out = search(
    [
      rec('Read', 'staging staging staging staging staging notes', 1),
      rec('Bash', 'the staging port for cobalt-payouts is 17448', 2),
    ],
    'cobalt-payouts staging port',
  );
  const first = out.split('\n\n')[1] ?? '';
  expect(first).toContain('17448');
  expect(first).toContain('[Bash output');
});

test('no match says so instead of guessing', () => {
  expect(search([rec('Bash', 'unrelated text', 1)], 'OPS-77412')).toContain('Nothing earlier in this session matches');
});

test('records note what they came from and tool input travels with the output', () => {
  const r = toolRecord('Bash', { tool: 'Bash', tool_use_id: 'x', command: 'git log -1' }, 'commit 0ef02c3', 5);
  expect(r.text.startsWith('command: git log -1')).toBe(true);
  expect(r.text).toContain('commit 0ef02c3');
  const files = droppedFiles(
    [
      { role: 'user', text: 'pin pydantic to 2.7.4', toolUses: [] },
      { role: 'user', text: '[amnesia] an earlier block', toolUses: [] },
    ],
    5,
  );
  expect(files.length).toBe(1);
  expect(files[0]!.map((x) => x.text)).toEqual(['pin pydantic to 2.7.4']);
});

// an in-memory file system and environment for the plugin's archive
function memoryFs(on: On) {
  const files = new Map<string, string>();
  // the engine hands hooks absolute, platform-shaped paths (C:\mem\... on Windows)
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  on('fs.write', (_$, e) => {
    files.set(norm(e.path), e.text);
    return { value: undefined };
  });
  on('fs.read', (_$, e) => {
    const v = files.get(norm(e.path));
    return v === undefined ? { deny: 'ENOENT' } : { value: v };
  });
  on('fs.exists', (_$, e) => {
    const p = norm(e.path);
    return { value: [...files.keys()].some((k) => k === p || k.startsWith(p + '/')) };
  });
  on('fs.list', (_$, e) => {
    const p = norm(e.path);
    return {
      value: [...files.keys()]
        .filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'))
        .map((k) => ({ name: k.slice(p.length + 1), kind: 'file' as const, size: files.get(k)!.length, mtimeMs: 0, isLink: false })),
    };
  });
  mock.env(on, { AMNESIA_HOME: '/mem/amnesia' });
  on('session.id', () => ({ value: 'test-session' }));
  return files;
}

test('tool outputs are archived as they happen and the recall tool finds them', async ($, on) => {
  const files = memoryFs(on);
  on('tool.call', (_$, e) =>
    e.tool === 'Bash'
      ? { result: { stdout: 'deploy region is ap-southeast-3b' }, text: 'deploy region is ap-southeast-3b' }
      : { deny: 'unexpected tool' },
  );
  const ran = await $.tool.call({ tool: 'Bash', command: 'cat deploy.env' } as never);
  expect((ran as { text?: string }).text).toBe('deploy region is ap-southeast-3b');
  expect([...files.keys()].some((k) => k.includes('/archive/') && /\/t-.*\.json$/.test(k))).toBe(true);

  const found = await $.tool.call({ tool: 'mcp__amnesia__recall', query: 'deploy region' } as never);
  const text = String((found as { result?: unknown }).result);
  expect(text).toContain('ap-southeast-3b');
  expect(text).toContain('command: cat deploy.env');
});

test('what a compaction drops is archived and recallable', async ($, on) => {
  memoryFs(on);
  const m = (role: 'user' | 'assistant', text: string, handle: string): SessionMessage => ({ role, text, toolUses: [], handle });
  const history = [m('user', 'The canary weight is 37 percent for ledger-holds', 'a'), m('user', 'continue', 'b')];
  on('session.compact', () => ({ messages: [m('user', 'Summary: tuning a canary.', 'S'), history[1]!], tokensBefore: 10, tokensAfter: 5 }));
  on('tool.call', () => ({ deny: 'no tools here' }));
  await $.session.compact({ trigger: 'auto', messages: history });
  const found = await $.tool.call({ tool: 'mcp__amnesia__recall', query: 'canary weight' } as never);
  const text = String((found as { result?: unknown }).result);
  expect(text).toContain('37 percent');
  expect(text).toContain('replaced by the compaction at');
});

test('with recall turned off nothing is archived', { options: { recall: false } }, async ($, on) => {
  const files = memoryFs(on);
  on('tool.call', () => ({ result: 'ok', text: 'some output 12345' }));
  await $.tool.call({ tool: 'Bash', command: 'true' } as never);
  expect([...files.keys()].length).toBe(0);
});

test('secrets are redacted before anything is archived', () => {
  const out = toolRecord(
    'Bash',
    { command: 'cat .env' },
    'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\npassword: hunter2hunter2\nregion=ap-southeast-3b\n' +
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\nghp_abcdefghijklmnopqrstuvwxyz0123456789',
    1,
  ).text;
  for (const secret of ['sk-abcdefghijklmnopqrstuvwxyz123456', 'hunter2hunter2', 'MIIEow', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) {
    expect(out.includes(secret)).toBe(false);
  }
  expect(out).toContain('region=ap-southeast-3b');
});

test("the desktop app's interface tools are not archived", async ($, on) => {
  const files = memoryFs(on);
  on('tool.call', () => ({ result: 'ok', text: 'Plan shown (4 steps).' }));
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [] } as never);
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never);
  expect([...files.keys()].length).toBe(0);
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__list_sessions' } as never);
  expect([...files.keys()].length).toBe(1);
});

test('prose and code about secret names are not redacted; values that look like secrets are', () => {
  const out = toolRecord(
    'Read',
    { file_path: 'README.md' },
    'private keys, common token formats and `password=`/`token:` values are redacted\n' +
      '// short appears in long as a whole token: config.ts in src/runtime/config.ts\n' +
      "[/\b((?:api[_-]?key|secret|token)[\"']?\s*[:=]\s*)/gi, '$1[redacted]'],\n" +
      'token: 9f8e7d6c5b4a\npassword=correcthorsebatterystaple\nAuthorization: Bearer abcdef0123456789',
    1,
  ).text;
  expect(out).toContain('`password=`/`token:` values');
  expect(out).toContain('whole token: config.ts');
  expect(out).toContain("[:=]\s*)/gi");
  for (const secret of ['9f8e7d6c5b4a', 'correcthorsebatterystaple', 'abcdef0123456789']) expect(out.includes(secret)).toBe(false);
});

test('a dropped message says where it sat and that its time is the compaction time', () => {
  const files = droppedFiles(
    [
      { role: 'user', text: 'the canary weight is 37 percent', toolUses: [] },
      { role: 'assistant', text: 'noted', toolUses: [] },
    ],
    Date.UTC(2026, 9, 17, 22, 44),
  );
  const out = search(files.flat(), 'canary weight');
  expect(out).toContain('[user message (1 of 2), replaced by the compaction at 22:44 UTC]');
});

// ---- just-in-time recall ----

const dropped = (text: string, at = 1): Rec => ({ kind: 'dropped', at, label: 'user', text });
// a dozen messages that all mention staging and deploy; one each per service
const ARCHIVE: Rec[] = [
  dropped('We are preparing the ledger-holds release. For acme-billing, the staging port is 29860 and the ticket is OPS-96797. Deploy soon.'),
  dropped('For kestrel-audit, the artifact bucket is s3://7103-artifacts-931/drop and the pinned commit is dfea153d2. Staging deploy next.'),
  ...Array.from({ length: 10 }, (_, i) => dropped(`For svc-${i}, the staging port is ${30000 + i}. Deploy it to staging later.`)),
];

test('prompt terms keep compounds whole and add their parts', () => {
  expect(promptTerms('Write release/deploy-staging.sh for acme-billing')).toEqual(
    ['write', 'release/deploy-staging.sh', 'release', 'deploy', 'staging', 'acme-billing', 'acme', 'billing'],
  );
});

test('a prompt that names a service brings back the message that set its values', () => {
  const r = promptRecall(ARCHIVE, 'Add a staging deploy step for acme-billing to the release script.');
  expect(r).not.toBe(null);
  expect(r!.text.startsWith(JIT_LEAD)).toBe(true);
  expect(r!.text).toContain('29860');
  expect(r!.text).toContain('OPS-96797');
  expect(r!.text.includes('dfea153d2')).toBe(false);
});

test('words most messages share are not enough', () => {
  expect(promptRecall(ARCHIVE, 'Deploy everything to staging now.')).toBe(null);
});

test('a message already attached is not attached again', () => {
  const first = promptRecall(ARCHIVE, 'staging deploy for acme-billing')!;
  expect(promptRecall(ARCHIVE, 'staging deploy for acme-billing', { skip: new Set(first.keys) })).toBe(null);
});

test('only messages a compaction replaced are searched, not tool outputs', () => {
  const tools = ARCHIVE.map((r) => ({ ...r, kind: 'tool' as const }));
  expect(promptRecall(tools, 'staging deploy for acme-billing')).toBe(null);
});

function promptCore(on: On, seen: { text: string; context?: readonly string[] }[]) {
  on('prompt.submit', (_$, e) => {
    seen.push({ text: e.text, context: e.context });
    return { text: e.text, context: e.context };
  });
}
const jm = (role: 'user' | 'assistant', text: string, handle: string): SessionMessage => ({ role, text, toolUses: [], handle });
const JHISTORY = [
  jm('user', 'For acme-billing, the staging port is 29860 and the tracking ticket is OPS-96797.', 'a'),
  ...Array.from({ length: 8 }, (_, i) => jm('user', `For svc-${i}, deploy to staging on port ${30000 + i}.`, `s${i}`)),
  jm('user', 'continue', 'z'),
];
const compactCore = (on: On) =>
  on('session.compact', () => ({ messages: [jm('user', 'Summary: configuring services.', 'S'), JHISTORY.at(-1)!], tokensBefore: 10, tokensAfter: 5 }));
const compactOnce = ($: any) => $.session.compact({ trigger: 'auto', messages: JHISTORY });

test('after a compaction, a prompt about a lost detail carries it as hidden context', async ($, on) => {
  memoryFs(on);
  on('tool.call', () => ({ deny: 'no tools here' }));
  const seen: { text: string; context?: readonly string[] }[] = [];
  promptCore(on, seen);
  compactCore(on);
  await $.prompt.submit({ text: 'Add a staging deploy step for acme-billing.' } as never);
  expect(seen.at(-1)?.context).toBe(undefined);
  await compactOnce($);
  await $.prompt.submit({ text: 'Add a staging deploy step for acme-billing.' } as never);
  const ctx = seen.at(-1)?.context ?? [];
  expect(ctx.length).toBe(1);
  expect(ctx[0]).toContain('29860');
  expect(seen.at(-1)?.text).toBe('Add a staging deploy step for acme-billing.');
});

test('autoRecall: false attaches nothing', { options: { autoRecall: false } }, async ($, on) => {
  memoryFs(on);
  on('tool.call', () => ({ deny: 'no tools here' }));
  const seen: { text: string; context?: readonly string[] }[] = [];
  promptCore(on, seen);
  compactCore(on);
  await compactOnce($);
  await $.prompt.submit({ text: 'Add a staging deploy step for acme-billing.' } as never);
  expect(seen.at(-1)?.context).toBe(undefined);
});

test('plain words never attach anything on their own, however rare', () => {
  const archive = [
    dropped('Merge the branch and push it with the tag, then tell me.'),
    ...Array.from({ length: 11 }, (_, i) => dropped(`For svc-${i}, the staging port is ${30000 + i}.`)),
  ];
  expect(promptRecall(archive, 'ok, merge it, push and tag')).toBe(null);
});

test('a name that recurs across many messages points at none of them', () => {
  const archive = Array.from({ length: 40 }, (_, i) => dropped(`Worked on agent-scientist step ${i}; for svc-${i} the port is ${30000 + i}.`));
  expect(promptRecall(archive, 'Add one more agent-scientist primitive for scheduling.')).toBe(null);
});

test('tool calls archived with a message are not matched, only what it said', () => {
  const archive = [
    dropped('Checking the config now.\n[Bash] command: cat acme-billing.env\nACME_BILLING_PORT=29860'),
    ...Array.from({ length: 11 }, (_, i) => dropped(`For svc-${i}, the staging port is ${30000 + i}.`)),
  ];
  expect(promptRecall(archive, 'Add a staging deploy step for acme-billing.')).toBe(null);
});
