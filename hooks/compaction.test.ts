import { test, expect, mock } from 'claude-code/testing';
import { session } from './test-session.ts'
import { slim, keepFrom, fileLists, cut, minify, minifyDeep, failureLine, fold, frozenEnd, FOLD_TAG, statusPayload, jevHeads, compactToolCall } from './compaction.ts';
import { compact, resolveOptions } from '../jev/compact.ts';
import { estimateTokens } from '../jev/state.ts';
import { originalPage } from './paging.ts';

// The fs engine resolves a path before a hook sees it (win32: 'C:\h\x' for '/h/x'); back to the mocks' POSIX keys.
const norm = (p: unknown) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');

/** Session `sid` in `/h` whose stored originals are `files` (name under context/sid/ to text); returns decompress by id. */
const stored = ($: any, on: any, files: Record<string, string>) => {
  on('session.cwd', async () => ({ value: '/h' }));
  on('session.id', async () => ({ value: 'sid' }));
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const name = norm(e.path).replace('/h/.overwatch/context/sid/', '');
    return Object.hasOwn(files, name) ? { value: files[name] } : { deny: 'ENOENT' };
  });
  return async (id: string) => $.tool.call({ tool: 'mcp__overwatch__decompress', id });
};

/** One user prompt, then 20 Bash calls of 4000 chars each with their results. */
const longTurn = (prompt: string) => [
  { role: 'user', text: prompt, toolUses: [] },
  ...Array.from({ length: 20 }, (_, k) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${k}`, tool: 'Bash', input: { command: 'ls' }, text: 'r'.repeat(4000) }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${k}`, text: 'r'.repeat(4000), isError: false }] },
  ]).flat(),
];

const big = 'x'.repeat(10_000);
const transcript = [
  { role: 'user', text: 'fix the test', toolUses: [] },
  { role: 'assistant', text: '<recap>old</recap>reading', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/r.ts' }, text: big }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: big, isError: false }] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Edit', input: { file_path: '/m.ts' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b', text: 'y'.repeat(500), isError: true }] },
  { role: 'user', text: 'now run it', toolUses: [] },
  { role: 'assistant', text: 'ok', toolUses: [] },
] as const;
const limits = { keepRecentTokens: 2, toolResultMaxChars: 2000, outcomeMaxChars: 120 };

const gradingOptions = { preserveRecentMessages: 0, maxStateTokens: 15000, maxRequestTokens: 18000 };
const gradingTranscript = (count: number) => [
  { role: 'user', text: 'Inspect the implementation and fix the known issue.', toolUses: [] },
  ...Array.from({ length: count }, (_, i) => [
    { role: 'assistant', text: 'Inspect the next file and check the exact implementation. '.repeat(15), toolUses: [{ tool_use_id: `u${i}`, tool: 'Read', input: { file_path: `src/file${i}.ts` }, text: 'export const value = 123;\n'.repeat(400) }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${i}`, text: 'export const value = 123;\n'.repeat(400) }] },
  ]).flat(),
] as never;
const graded = (questions: object) => ({ answers: Object.fromEntries(Object.keys(questions).map((q) => [q, { noul: 0.8 }])) });
const grader = (fetch: (...args: any[]) => Promise<any>) => ({
  env: { get: async () => 'key' }, ui: { log: () => {} }, process: { run: async () => ({}) }, http: { fetch },
}) as never;

test('a fold preflights the entire grading budget before any request', async () => {
  for (const [count, options, expected] of [
    [50, {}, 2], [60, {}, 0], [100, {}, 0], [50, { maxRequests: 1 }, 0],
    [50, { maxRequests: 5, maxTotalTokens: 20000 }, 0], [40, { maxRequests: 0 }, 0], [40, { maxTotalTokens: 0 }, 0],
  ] as const) {
    const bodies: string[] = [];
    const heads = await jevHeads(grader(async (_url, init) => {
      bodies.push(init.body);
      return { status: 200, ok: true, text: JSON.stringify(graded(JSON.parse(init.body).questions)) };
    }), gradingTranscript(count), { ...gradingOptions, ...options }, { jev: '' });
    expect(bodies.length).toBe(expected);
    expect(bodies.reduce((sum, body) => sum + estimateTokens(body), 0)).toBeLessThanOrEqual(36000);
    if (!expected) {
      expect(heads.size).toBe(0);
      expect(fold(gradingTranscript(count), 6000, heads, 1)).not.toBe(null);
    }
  }
  expect(resolveOptions({ maxRequests: NaN, maxTotalTokens: Infinity }).maxRequests).toBe(2);
  expect(resolveOptions({ maxRequests: NaN, maxTotalTokens: Infinity }).maxTotalTokens).toBe(36000);
});

test('grading batches run one at a time and stop after the first failure', async () => {
  let active = 0, peak = 0, calls = 0;
  await compact(gradingTranscript(50), { ask: async (_state, questions) => {
    calls++; active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return graded(questions);
  } }, gradingOptions);
  expect(calls).toBe(2);
  expect(peak).toBe(1);
  calls = 0;
  await expect(compact(gradingTranscript(50), { ask: async () => { calls++; throw new Error('offline'); } }, gradingOptions)).rejects.toThrow('offline');
  expect(calls).toBe(1);
});

test('transport retries also consume the fold request and input budgets', async () => {
  for (const options of [{ maxRequests: 1 }, { maxRequests: 2, maxTotalTokens: 17000 }]) {
    let attempts = 0;
    const heads = await jevHeads(grader(async () => { attempts++; throw new Error('offline'); }), gradingTranscript(40), { ...gradingOptions, ...options }, { jev: '' });
    expect(attempts).toBe(1);
    expect(heads.size).toBe(0);
  }
});

test('cut point never splits a call from its result', () => {
  expect(keepFrom(transcript, 2)).toBe(5);
  expect(keepFrom(transcript, 5)).toBe(3);
});

test('tiny cuts and short strings honor their complete character budget', () => {
  for (const max of [0, 1, 20, 79, 80]) {
    expect(cut('x'.repeat(500), max, 'toolu_1').length).toBeLessThanOrEqual(max);
    expect(minify('x'.repeat(100), max).length).toBeLessThanOrEqual(max);
  }
});

test('live output shares one serialized budget, keeps middle errors and all metadata', async () => {
  const files = new Map<string, string>();
  const $ = { session: { cwd: async () => '/h', id: async () => 'live' }, fs: {
    exists: async () => false, write: async (path: string, text: string) => { files.set(path, text); },
  } } as never;
  const r = { result: Array.from({ length: 200 }, (_, i) => ({ type: 'text', data: `${i}:` + '\\"'.repeat(90) })),
    text: 'start\n' + Array.from({ length: 1000 }, (_, i) => `ordinary line ${i}\n`).join('') + 'ERROR unique-middle-evidence\n' + Array.from({ length: 1000 }, (_, i) => `another ordinary line ${i}\n`).join('') + 'end',
    isError: true, exitCode: 7, context: ['keep this context'], extra: { trace: 'keep' } };
  const out = await compactToolCall($, { tool: 'mcp__overwatch__report', tool_use_id: 'toolu_live' }, async () => r);
  expect(JSON.stringify({ result: out.result, text: out.text }).length).toBeLessThanOrEqual(8000);
  expect(out.text).toContain('ERROR unique-middle-evidence');
  expect(out.isError).toBe(true);
  expect(out.exitCode).toBe(7);
  expect(out.context).toBe(r.context);
  expect(out.extra).toBe(r.extra);
  expect([...files.values()][0]).toBe(JSON.stringify({ result: r.result, text: r.text }));
});

test('unarchivable, exact-file and native media results remain unchanged', async () => {
  const r = { result: 'x'.repeat(20000), context: ['unchanged'] };
  const $ = { session: { cwd: async () => '/h', id: async () => 'live' }, fs: { exists: async () => false, write: async () => { throw new Error('disk full'); } } } as never;
  for (const id of [undefined, '../unsafe', 'toolu_disk']) expect(await compactToolCall($, { tool: 'Bash', tool_use_id: id }, async () => r)).toBe(r);
  let writes = 0;
  const writable = { session: { cwd: async () => '/h', id: async () => 'live' }, fs: { exists: async () => false, write: async () => { writes++; } } } as never;
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) expect(await compactToolCall(writable, { tool, tool_use_id: 'toolu_file' }, async () => r)).toBe(r);
  for (const type of ['image', 'document']) {
    const media = { result: [{ type, source: { type: 'base64', media_type: type === 'document' ? 'application/pdf' : 'image/png', data: 'x'.repeat(20000) } }] };
    expect(await compactToolCall(writable, { tool: 'media', tool_use_id: 'toolu_media' }, async () => media)).toBe(media);
  }
  expect(writes).toBe(0);
});

test('older messages are slimmed, recent ones kept whole', () => {
  const out = slim(transcript, limits);
  expect(out[1].text).toBe('reading');
  expect(out[2].toolResults![0].text.length).toBeLessThan(2100);
  expect(out[4].toolResults![0].text.length).toBeLessThan(200);
  expect(out[5]).toBe(transcript[5]);
  expect(out[0]).toBe(transcript[0]);
  expect(cut('short', 10)).toBe('short');
});

test('file lists name reads and modifications', () => {
  const lists = fileLists(transcript);
  expect(lists).toContain('<read-files>\n/r.ts\n</read-files>');
  expect(lists).toContain('<modified-files>\n/m.ts\n</modified-files>');
});

test('minify drops noise, keeps words', () => {
  const noisy = '\x1b[32mok\x1b[0m   \n' + 'same\n'.repeat(50) + '\n\n\n\n' + '10%\r50%\r100% done\n' + 'x'.repeat(200);
  const out = minify(noisy, 20_000);
  expect(out).toContain('ok\nsame [×50]\n\n100% done');
  expect(out).not.toContain('\x1b');
  expect(minifyDeep({ stdout: noisy, data: noisy }, 20_000)).toEqual({ stdout: out, data: out });
});

test('rolling fold: index in order, frozen prefix and tail untouched, ids kept', () => {
  const heads = new Map([['a', 400], ['b', 0]]);
  const out = fold(transcript, 2, heads, 1)!;
  expect(out[0]).toBe(transcript[0]);
  expect(out[1].text.startsWith(FOLD_TAG)).toBe(true);
  // Every index line gets a short fN.k id; a call shows its bare main argument.
  expect(out[1].text).toContain('a f1.0: reading');
  expect(out[1].text).toContain('f1.1 Read /r.ts (10000 chars): xxxx');
  expect(out[1].text).toContain('f1.2 Edit /m.ts (0 chars)');
  expect(out[1].text).not.toContain('#a ');
  expect(out[1].text).toContain('<modified-files>\n/m.ts');
  expect(out.slice(2)).toEqual([transcript[5], transcript[6]]);
  // A second fold appends after the first; the first is never rewritten.
  const grown = [...out, { role: 'assistant', text: 'more', toolUses: [] }, { role: 'user', text: 'next', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] }] as never[];
  expect(frozenEnd(grown)).toBe(2);
  const again = fold(grown, 2, new Map(), 2)!;
  expect(again[1]).toBe(out[1]);
  expect(again[2].text).toContain('F2');
  expect(fold(again, 2, new Map(), 3)).toBe(null);
  // One message holds the whole budget right past the frozen run: fold up to the next cut point.
  const long = [transcript[0], out[1], { role: 'user', text: 'big', toolUses: [] }, { role: 'assistant', text: 'y'.repeat(40000), toolUses: [] }, { role: 'user', text: 'new', toolUses: [] }] as never[];
  const rolled = fold(long, 500, new Map(), 3)!;
  expect(rolled.length).toBe(4);
  expect(rolled[3]).toBe(long[4]);
});

test('one long autonomous turn folds, and never splits a call from its result', () => {
  const turn = longTurn('work the board') as never[];
  const out = fold(turn, 6000, new Map(), 1)!;
  expect(out).not.toBe(null);
  expect(out[1].text.startsWith(FOLD_TAG)).toBe(true);
  expect(out[2].role).toBe('assistant');
  expect(out.length).toBeLessThan(turn.length);
  expect(out[1].text).toContain('f1.0 Bash ls (4000 chars)');
  expect(out[1].text).not.toContain('{"command"');
  // Every result left in the tail answers a call also in the tail.
  const calls = new Set(out.flatMap((m: any) => m.toolUses.map((u: any) => u.tool_use_id)));
  for (const m of out.slice(2) as any[]) for (const r of m.toolResults ?? []) expect(calls.has(r.tool_use_id)).toBe(true);
});

test('failure lines and cut ids', () => {
  expect(failureLine([{ tool: 'Bash', text: 'exit 1\n' + 'e'.repeat(300) }, { tool: 'Bash', text: 'x' }], 120).length).toBeLessThan(140);
  expect(cut('z'.repeat(500), 200, 'toolu_1')).toContain('decompress id=toolu_1');
});

test('status payload matches CONTRACT §2', () => {
  const s = { saved: 75000, folds: 3, lastFold: 12000, jev: 'F3: 12 msgs folded · jev', compacting: false, failures: 0, nextCompactAt: 85000 };
  expect(Object.keys(statusPayload(s, 1))).toEqual(['v', 'ts', 'saved', 'folds', 'lastFold', 'jev', 'compacting', 'failures', 'nextCompactAt']);
  expect(statusPayload(s, 1).v).toBe(1);
});

session('a minified tool result keeps the context an inner hook added', async ($, on) => {
  let archived = '';
  on('session.cwd', async () => ({ value: '/h' }));
  on('session.id', async () => ({ value: 'sid' }));
  on('fs.exists', async () => ({ value: false }));
  on('fs.write', async (_: unknown, e: { text: string }) => { archived = e.text; return { value: undefined }; });
  on('tool.call', async () => ({ result: 'same\n'.repeat(50), context: ['kern: nudge'] }));
  const r = await $.tool.call({ tool: 'Bash', command: 'rg x', tool_use_id: 'toolu_t' } as any);
  expect(String(r.result)).toContain('same [×50]');
  expect(r.context).toEqual(['kern: nudge']);
  expect(archived).toBe('same\n'.repeat(50));
});

session('decompress reads the exact id back, never a longer one ending the same', async ($, on) => {
  const decompress = stored($, on, { 'f11.1.txt': 'eleventh', 'f1.1.txt': 'first' });
  expect((await decompress('f1.1')).result.text).toBe('first');
  expect((await decompress('#f11.1')).result.text).toBe('eleventh');
  expect((await decompress('../x')).isError).toBe(true);
});

session('decompress resolves a fold short id through its alias, and still an old toolu id', async ($, on) => {
  const decompress = stored($, on, { 'toolu_x.txt': 'out', 'f2.3.ref': 'toolu_x' });
  expect((await decompress('f2.3')).result.text).toBe('out');
  expect((await decompress('#toolu_x')).result.text).toBe('out');
  expect((await decompress('f2.4')).isError).toBe(true);
});

session('decompress preserves stored Bash JSON exactly', async ($, on) => {
  const bash = JSON.stringify({ stdout: 'a "q"\nb', stderr: 'warn', interrupted: false, isImage: false, noOutputExpected: false });
  const decompress = stored($, on, { 't1.txt': bash, 't2.txt': '{"k":1}', 't3.txt': JSON.stringify({ stdout: 'x', stderr: '', interrupted: true }) });
  expect((await decompress('t1')).result.text).toBe(bash);
  expect((await decompress('t2')).result.text).toBe('{"k":1}');
  expect((await decompress('t3')).result.text).toBe(JSON.stringify({ stdout: 'x', stderr: '', interrupted: true }));
});

test('exact pages fit the serialized envelope and reconstruct escaped originals', () => {
  const original = '\\"\n\t😀'.repeat(4000);
  let offset = 0, restored = '', pages = 0;
  do {
    const page = originalPage(original, 'toolu_page', offset, 1000000, 8000);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(8000);
    restored += page.text; pages++;
    if (page.next_offset === null) break;
    expect(page.next_offset).toBeGreaterThan(offset);
    offset = page.next_offset;
  } while (true);
  expect(restored).toBe(original);
  expect(pages).toBeGreaterThan(1);
  for (const offset of [-1, 0.5, NaN, original.length + 1]) expect(() => originalPage(original, 'x', offset)).toThrow();
  for (const limit of [0, -1, Infinity]) expect(() => originalPage(original, 'x', 0, limit)).toThrow();
});

session('after a fold the SessionStart re-run adds no second copy; after a summary it does', async ($, on) => {
  on('classic.SessionStart' as never, (async () => ({ additionalContext: ['CAVEMAN MODE ACTIVE'] })) as never);
  on('session.compact' as never, (async () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] })) as never);
  const long = longTurn('work');
  const folded = await $.session.compact({ trigger: 'manual', messages: long } as any);
  expect((folded as any).messages[1].text.startsWith(FOLD_TAG)).toBe(true);
  expect((await $.classic.SessionStart({ source: 'compact' } as any) as any).additionalContext).toBeUndefined();
  // Nothing to fold: the built-in summary replaced the history, so the hooks' context comes back.
  await $.session.compact({ trigger: 'manual', messages: long.slice(0, 1) } as any);
  expect((await $.classic.SessionStart({ source: 'compact' } as any) as any).additionalContext).toEqual(['CAVEMAN MODE ACTIVE']);
  expect((await $.classic.SessionStart({ source: 'startup' } as any) as any).additionalContext).toEqual(['CAVEMAN MODE ACTIVE']);
});

test('a failed Jev grade names its reason in the status, clipped to 80 chars', async () => {
  const region = transcript.slice(0, 3) as never;
  const $ = (env: string | undefined, text: string) => ({
    env: { get: async () => env }, settings: { read: async () => ({}) }, ui: { log: () => {} },
    http: { fetch: async () => ({ status: 500, ok: false, text }) },
  }) as never;
  const out = { jev: '' };
  await jevHeads($(undefined, ''), region, {}, out);
  expect(out.jev).toBe('jev failed: no TYPESAFE_API_KEY');
  await jevHeads($('k', 'overloaded\n'.repeat(40)), region, { preserveRecentMessages: 0 }, out);
  expect(out.jev.slice(0, 50)).toBe('jev failed: Jev request failed (500): overloaded o');
  expect(out.jev.length).toBe('jev failed: '.length + 80);
});

test('Jev grades change folded results by original tool id, preserving pinned and fallback heads', async () => {
  const region = ['p', 'r'].flatMap((char, i) => [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: `toolu_${i}`, tool: 'Read', input: { file_path: `${i}.ts` }, text: char.repeat(500) }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `toolu_${i}`, text: char.repeat(500) }] },
  ]);
  const messages = [{ role: 'user', text: 'original request', toolUses: [] }, ...region, { role: 'user', text: 'next request', toolUses: [] }] as never;
  const grade = async (probability?: number) => jevHeads({
    env: { get: async () => probability === undefined ? undefined : 'key' },
    settings: { read: async () => ({}) }, ui: { log: () => {} }, process: { run: async () => ({}) },
    http: { fetch: async (_: string, init: any) => ({
      status: 200, ok: true,
      text: JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((q) => [q, { noul: probability }])) }),
    }) },
  } as never, region as never, { preserveRecentMessages: 0, keepThreshold: 0.6 }, { jev: '' });
  const kept = fold(messages, 1, await grade(1), 1)![1].text;
  const dropped = fold(messages, 1, await grade(0), 1)![1].text;
  const fallback = fold(messages, 1, await grade(), 1)![1].text;
  expect(kept).toContain('r'.repeat(400));
  expect(dropped).not.toContain('r'.repeat(2));
  expect(kept).toContain('p'.repeat(400));
  expect(dropped).toContain('p'.repeat(400));
  expect(fallback).toContain('r'.repeat(100));
  expect(fallback).not.toContain('r'.repeat(101));
});

test('an answered Jev call appends one dataset line; a failed log write still folds', async () => {
  const region = transcript.slice(0, 3) as never;
  const runs: any[] = [];
  const $ = (run: (argv: string[], init: any) => Promise<unknown>) => ({
    env: { get: async (k: string) => (k === 'HOME' ? '/h' : 'k') }, settings: { read: async () => ({}) }, ui: { log: () => {} },
    http: { fetch: async (_: string, init: any) => {
      const qs = Object.keys(JSON.parse(init.body).questions);
      return { status: 200, ok: true, text: JSON.stringify({ model: 'jev-9', answers: Object.fromEntries(qs.map((q) => [q, { noul: 0.9 }])) }) };
    } },
    process: { run },
  }) as never;
  const out = { jev: '' };
  const heads = await jevHeads($(async (argv, init) => runs.push({ argv, init })), region, { preserveRecentMessages: 0 }, out);
  const line0 = () => JSON.parse(runs[0].init.stdin);
  expect(out.jev).toBe('jev');
  expect(runs.length).toBe(1);
  expect(runs[0].argv[3]).toBe('/h/.jev/log');
  expect(runs[0].argv[4]).toBe(`${new Date(line0().ts).toISOString().slice(0, 10)}.jsonl`);
  expect(runs[0].init.stdin.indexOf('\n')).toBe(runs[0].init.stdin.length - 1);
  const line = line0();
  expect(Object.keys(line)).toEqual(['ts', 'client', 'model', 'state', 'questions', 'answers']);
  expect([line.client, line.model]).toEqual(['componion', 'jev-9']);
  expect(Object.keys(line.answers)).toEqual(Object.keys(line.questions));
  const failing = await jevHeads($(async () => { throw new Error('disk full'); }), region, { preserveRecentMessages: 0 }, out);
  expect(out.jev).toBe('jev');
  expect(failing.size).toBe(heads.size);
});
