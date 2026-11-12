import { test, expect } from 'claude-code/testing';
import { observedRequest, usageOperation, usageSnapshot, resetUsage, returnedUsage, usageReport } from './usage.ts';
import { jevHeads, register as configureCompaction } from './compaction.ts';

let serial = 0;
function host() {
  const files = new Map<string, string>(), events: any[] = [];
  let fail = false, reads = 0;
  const id = `usage-${++serial}`;
  const $: any = {
    session: { cwd: async () => '/repo', id: async () => id },
    fs: { read: async (p: string) => { reads++; if (!files.has(p)) throw new Error('missing'); return files.get(p); },
      write: async (p: string, s: string) => { if (fail) throw new Error('secret-key'); files.set(p, s); } },
    process: { run: async (_a: any, e: any) => { if (fail) throw new Error('secret-key'); events.push(JSON.parse(e.stdin)); } },
    env: { get: async () => 'secret-key' }, ui: { log: () => {} },
  };
  return { $, files, events, id, reads: () => reads, fail: () => { fail = true; } };
}
const response = (body: any, ok = true) => ({ ok, status: ok ? 200 : 503, text: JSON.stringify(body) });
const valid = (b: any) => { if (!b?.answers?.q || typeof b.answers.q.noul !== 'number' || b.answers.q.noul < 0 || b.answers.q.noul > 1) throw new Error('secret-key'); return b.answers.q.noul; };

test('usage keeps returned fields on invalid and HTTP replies; unknown transport is not zero', async () => {
  const h = host(), op = await usageOperation(h.$, 'compaction');
  await observedRequest(h.$, op, 1, 10, async () => response({ answers: { q: { noul: 1 } }, usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 3 } }), valid);
  await expect(observedRequest(h.$, op, 2, 11, async () => response({ answers: {}, usage: { input_tokens: 7, output_tokens: 2 } }), valid)).rejects.toThrow('invalid_response');
  await expect(observedRequest(h.$, op, 3, 12, async () => response({ usage: { input_tokens: 5 } }, false), valid)).rejects.toThrow('http_error');
  await expect(observedRequest(h.$, op, 4, 13, async () => { throw new Error('secret-key'); }, valid)).rejects.toThrow('transport_error');
  const s = await usageSnapshot(h.$);
  expect([s.attempts, s.successes, s.failures, s.retries, s.estimatedInputTokens]).toEqual([4, 1, 3, 0, 46]);
  expect(s.usage.input_tokens).toEqual({ total: 24, reported: 3, unknown: 1 });
  expect(s.usage.output_tokens).toEqual({ total: 2, reported: 2, unknown: 2 });
  expect(s.usage.cache_creation_input_tokens).toEqual({ total: null, reported: 0, unknown: 4 });
  expect(new Set(h.events.map((e) => e.operationId)).size).toBe(1);
  expect(h.events.map((e) => e.batch)).toEqual([1, 2, 3, 4]);
  expect(h.events.map((e) => e.httpStatus)).toEqual([200, 200, 503, null]);
  expect(JSON.stringify(h.events)).not.toContain('secret-key');
  expect(returnedUsage({ usage: { input_tokens: -1, output_tokens: '3', cache_read_input_tokens: Infinity } }).input_tokens).toBe(null);
  resetUsage();
  expect((await usageSnapshot(h.$)).attempts).toBe(4);
  expect((await usageOperation(h.$, 'guard')).operationId).toStartWith('guard-2-');
});

test('concurrent initialization and reverse completion preserve both operations and persisted totals', async () => {
  const h = host();
  const [a, b] = await Promise.all([usageOperation(h.$, 'compaction'), usageOperation(h.$, 'guard')]);
  expect(h.reads()).toBe(1);
  expect(a.operationId).not.toBe(b.operationId);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const first = observedRequest(h.$, a, 1, 4, async () => { await held; return response({ answers: { q: { noul: 1 } }, usage: { input_tokens: 8 } }); }, valid);
  await observedRequest(h.$, b, 1, 5, async () => response({ answers: { q: { noul: 0 } }, usage: { input_tokens: 9 } }), valid);
  release(); await first;
  const disk = JSON.parse(h.files.get(`/repo/.overwatch/usage/${h.id}.json`)!);
  expect(disk.attempts).toBe(2);
  expect(disk.usage.input_tokens.total).toBe(17);
  expect(disk.successes).toBe(2);
  expect(h.events.map((e) => e.operation)).toEqual(['guard', 'compaction']);
});

test('logging failures do not change successful results or reset totals at compaction registration', async () => {
  const h = host(); h.fail();
  const op = await usageOperation(h.$, 'guard');
  expect(await observedRequest(h.$, op, 1, 1, async () => response({ answers: { q: { noul: 1 } } }), valid)).toBe(1);
  configureCompaction((() => {}) as never, { enabled: false });
  const s = await usageSnapshot(h.$);
  expect(s.attempts).toBe(1);
  expect(s.usage.input_tokens.total).toBe(null);
});

test('real compaction requests record both batches and budget rejection records no attempt', async () => {
  const h = host();
  h.$.http = { fetch: async (_url: string, init: any) => response({ usage: { input_tokens: 20, output_tokens: 2 }, answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((k) => [k, { noul: 0.8 }])) }) };
  const region = [{ role: 'user', text: 'Inspect the implementation and fix the known issue.', toolUses: [] }, ...Array.from({ length: 50 }, (_, n) => [{ role: 'assistant', text: 'Inspect the next file and check the exact implementation. '.repeat(15), toolUses: [{ tool: 'Read', tool_use_id: `u${n}`, input: { file_path: `src/file${n}.ts` } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `u${n}`, text: 'export const value = 123;\n'.repeat(400) }] }]).flat()] as never;
  await jevHeads(h.$, region, { preserveRecentMessages: 0, maxRequests: 0 }, { jev: '' });
  expect((await usageSnapshot(h.$)).attempts).toBe(0);
  await jevHeads(h.$, region, { preserveRecentMessages: 0, maxStateTokens: 15000, maxRequestTokens: 18000, maxTotalTokens: 100000, maxRequests: 10 }, { jev: '' });
  expect(h.events.length).toBeGreaterThan(1);
  expect(new Set(h.events.map((e) => e.operationId)).size).toBe(1);
  expect((await usageSnapshot(h.$)).usage.input_tokens.total).toBe(h.events.length * 20);
});


test('disk reports keep missing and corrupt usage unknown without hiding valid guard-only sessions', async () => {
  const h = host();
  await observedRequest(h.$, await usageOperation(h.$, 'guard'), 1, 7, async () => response({ answers: { q: { noul: 1 } } }), valid);
  const output = await usageReport({ cwd: '/repo', list: async () => [{ name: `${h.id}.json` }, { name: 'corrupt.json' }, { name: 'unreadable.json' }],
    read: async (p: string) => { if (p.endsWith('unreadable.json')) throw new Error('disk'); return h.files.get(p) ?? '{bad'; } } as any);
  expect(output).toContain('1 sidecar requests');
  expect(output).toContain('input_tokens unknown (0/1 reported)');
  expect(output).toContain('corrupt: usage unavailable');
  expect(output).toContain('unreadable: usage unavailable');
});

test('compaction status and debug failures never echo a transport credential', async () => {
  const h = host(), logs: string[] = [], out = { jev: '' };
  h.$.ui.log = (text: string) => logs.push(text);
  h.$.http = { fetch: async () => { throw new Error('Bearer secret-key'); } };
  const region = [{ role: 'user', text: 'inspect source', toolUses: [] }, { role: 'assistant', text: '', toolUses: [{ tool: 'Read', tool_use_id: 'a', input: {} }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'source' }] }];
  await jevHeads(h.$, region as never, { preserveRecentMessages: 0 }, out);
  expect((await usageSnapshot(h.$)).attempts).toBe(1);
  expect(JSON.stringify({ logs, out, events: h.events })).not.toContain('secret-key');
  expect(out.jev).toBe('jev failed: transport_error');
});
