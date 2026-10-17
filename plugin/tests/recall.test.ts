import { test, expect, mock } from 'claude-code/testing';
import type { On, SessionMessage } from 'claude-code';
import { search, termsOf, toolRecord, droppedFiles, type Rec } from '../hooks/recall.ts';

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
  expect(text).toContain('replaced by a compaction');
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
