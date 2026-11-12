import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { analyze, deterministicFold, parseJsonl, sidecarUsage } from './replay.ts';
import { chars, keepFrom, projectToolResult, compactTurnEnd, register, shouldCompact } from '../hooks/compaction.ts';
const fixture = () => parseJsonl(readFileSync(new URL('./fixtures/causal.jsonl', import.meta.url), 'utf8'));

test('causal immutable replay never puts a future result in an earlier request', () => {
  const records = fixture(), before = JSON.stringify(records), result = analyze(records, { minimum: 0, growth: 0, keep: 1 });
  expect(result.frames).toHaveLength(4);
  expect(JSON.stringify(result.frames[0])).not.toContain('FUTURE_RESULT_SENTINEL');
  expect(JSON.stringify(result.frames[1].original)).toContain('FUTURE_RESULT_SENTINEL');
  expect(JSON.stringify(records)).toBe(before);
  expect(result.frames[1].original[1].toolUses[0].text).toBeUndefined();
  const delayed = [...records.slice(0, 3), { type: 'assistant', sessionId: 's1', requestId: 'pending', message: { id: 'pending', content: 'The tool is still running.' } }, ...records.slice(3)];
  const pending = analyze(delayed).frames[1].original;
  expect(JSON.stringify(pending)).toContain('toolu_read');
  expect(JSON.stringify(pending)).not.toContain('FUTURE_RESULT_SENTINEL');
  expect(result.frames[3].deterministic_fold.some((m) => m.text.startsWith('[overwatch fold'))).toBe(true);
  expect(result.report.assumptions.prefix).toContain('Unknown');
  expect(result.report.observed.sidecar.available).toBe(false);
});

test('stream snapshots deduplicate main and worker usage; zero differs from missing', () => {
  const report = analyze(fixture()).report;
  expect(report.observed.main.requests).toBe(4);
  expect(report.observed.main.usage.input_tokens).toEqual({ total: 15, reported: 3, unknown: 1 });
  expect(report.observed.main.usage.output_tokens).toEqual({ total: 3, reported: 3, unknown: 1 });
  expect(report.observed.workers.usage.input_tokens.total).toBe(4);
  expect(report.observed.main.usage.cache_read_input_tokens).toEqual({ total: 0, reported: 1, unknown: 3 });
  const sidecar = sidecarUsage(readFileSync(new URL('./fixtures/sidecar.jsonl', import.meta.url), 'utf8'), new Set(['s1']));
  expect(sidecar).toMatchObject({ available: true, requests: 2, attempts: 2, successes: 1, failures: 1, outcomes: { transport_error: 1 }, operations: { guard: 1, compaction: 1 }, usage: { input_tokens: { total: 20, reported: 1, unknown: 1 } } });
  expect(analyze([]).report.counterfactuals.original_recorded.requests).toBe(0);
});

test('media bytes are excluded while text and original media content survive; UUID-only requests are provisional', () => {
  const records = fixture();
  records[3].message.content[0].content = [{ type: 'text', text: 'visible evidence' }, { type: 'image', source: { type: 'base64', data: 'BASE64'.repeat(10000) } }];
  const result = analyze(records, { liveMax: 512 });
  const received = result.frames[1].live[2].toolResults![0];
  expect(received.content[1].source.data).toHaveLength(60000);
  expect(received.text).toContain('visible evidence');
  expect(received.text).not.toContain('BASE64');
  expect(received.text.length).toBeLessThan(300);
  expect(result.report.assumptions.excluded_media_blocks).toBe(1);
  records[3].message.content[0].content[1] = { blob: 'PDFBASE64'.repeat(10000), mimeType: 'application/pdf' };
  const pdf = analyze(records).frames[1].live[2].toolResults![0];
  expect(pdf.content[1].blob).toHaveLength(90000);
  expect(pdf.text).toContain('visible evidence');
  expect(pdf.text).not.toContain('PDFBASE64');
  delete records[1].requestId; delete records[1].message.id;
  expect(analyze(records).report.observed.unidentified_requests).toBe(1);
  expect(analyze(records).report.assumptions.usage).toContain('provisional');
});

test('canonical runtime sizing counts arrived results once and preserves the tail boundary', () => {
  const call = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u', tool: 'Bash', input: {}, text: 'x'.repeat(1000) }] };
  const result = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u', text: 'x'.repeat(1000) }] };
  const view: any = [{ role: 'user', text: 'goal', toolUses: [] }, call, result, { role: 'assistant', text: 'end', toolUses: [] }];
  expect(chars(view)).toBe(1009);
  expect(chars([call] as any)).toBe(1002);
  expect(keepFrom(view, 252)).toBe(1);
});

test('shared live projection preserves exact tools/media and bounds structured errors', () => {
  const long = { result: 'same exact line\n'.repeat(2000) };
  expect(projectToolResult('Read', 'u', long, 512).response).toBe(long);
  expect(projectToolResult('Edit', 'u', long, 512).response).toBe(long);
  const media = { result: [{ type: 'image', source: { type: 'base64', data: 'x'.repeat(10000) } }] };
  expect(projectToolResult('imageTool', 'u', media, 512).response).toBe(media);
  const error = { result: Array.from({ length: 50 }, (_, i) => ({ type: 'text', text: `${i}:` + 'x'.repeat(100) })), text: 'ERROR unique evidence\n' + 'normal\n'.repeat(500), isError: true, metadata: 'keep' };
  const projected = projectToolResult('Bash', 'u', error, 1000);
  expect(JSON.stringify({ result: projected.response.result, text: projected.response.text }).length).toBeLessThanOrEqual(1000);
  expect(projected.response.text).toContain('ERROR unique evidence');
  expect(projected.response.metadata).toBe('keep');
  expect(projected.original).toBe(JSON.stringify({ result: error.result, text: error.text }));
  const records = fixture(); records[3].message.content[0].content = long.result;
  const replay = analyze(records, { liveMax: 512 });
  expect(replay.frames[1].live[2].toolResults![0].text).toBe(long.result);
});

test('deterministic folds hydrate cumulative offloaded path archives', () => {
  const state = { next: 1, archives: new Map<string, string>() };
  let view: any[] = [{ role: 'user', text: 'goal', toolUses: [] }];
  for (let wave = 0; wave < 3; wave++) {
    const id = `u${wave}`, path = `path${wave}-` + 'long'.repeat(100);
    view.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: path } }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'read' }] }, { role: 'assistant', text: 'done', toolUses: [] });
    view = deterministicFold(view, state, 1, 1000)!;
    expect(view).not.toBeNull();
  }
  const paths = state.archives.get('paths-f3')!;
  for (const n of [0, 1, 2]) expect(paths).toContain(`path${n}-`);
});

test('runtime idle callbacks cannot compact a replacement session and handle unavailable usage', async () => {
  let callback: () => void = () => {}, cancelled = 0, compacted = 0, fail = false;
  const $: any = { session: { usage: async () => { if (fail) throw new Error('closed'); return { context: { tokens: 0 } }; }, compact: async () => { compacted++; }, cwd: async () => '/tmp', id: async () => 's' }, fs: { write: async () => {} }, clock: { after: (_: number, fn: () => void) => { callback = fn; return { cancel: () => { cancelled++; } }; } } };
  register((() => {}) as any, {});
  await compactTurnEnd($, {});
  const stale = callback;
  register((() => {}) as any, {});
  stale(); await Promise.resolve();
  expect(cancelled).toBe(1); expect(compacted).toBe(0);
  await compactTurnEnd($, {}); fail = true; callback(); await new Promise((resolve) => setTimeout(resolve, 0));
  expect(compacted).toBe(0);
  expect(shouldCompact(50000, 40000, 50000, 20000)).toBe(false);
  expect(shouldCompact(60000, 40000, 50000, 20000)).toBe(true);
});
