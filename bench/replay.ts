// Causal counterfactual replay: estimates of recorded context, never billed savings.
import { readFileSync } from 'node:fs';
import { chars, messageSizes, tokens, projectToolResult, foldBounds, foldIndex, shouldCompact, isMediaNode as isMedia } from '../hooks/compaction.ts';
import { liveResultBudget } from '../hooks/paging.ts';
import { returnedUsage, USAGE_FIELDS } from '../hooks/usage.ts';
type Msg = { role: 'user' | 'assistant'; text: string; toolUses: any[]; toolResults?: any[]; request?: string };
type Usage = ReturnType<typeof returnedUsage>;
export type Options = { prefixTokens?: number; inputWeight?: number; cacheWriteWeight?: number; cacheReadWeight?: number; resetCacheAfterFold?: boolean; minimum?: number; growth?: number; keep?: number; liveMax?: number; maxIndex?: number };
const finite = (n: unknown, fallback: number) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
export const parseJsonl = (text: string): any[] => text.split(/\r?\n/).filter((s) => s.trim()).map((s, i) => {
  try { return JSON.parse(s); } catch { throw new Error(`invalid JSONL at nonempty line ${i + 1}`); }
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const withoutMedia = (v: any): any => isMedia(v) ? { type: v.type ?? 'media', excluded: 'media payload unavailable for token estimation' }
  : Array.isArray(v) ? v.map(withoutMedia) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutMedia(x)])) : v;
const mediaCount = (v: any): number => isMedia(v) ? 1 : v && typeof v === 'object' ? Object.values(v).reduce((n: number, x) => n + mediaCount(x), 0) : 0;
const contentText = (value: any) => typeof value === 'string' ? value : JSON.stringify(withoutMedia(value ?? ''));
const blocksOf = (m: any): any[] => typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
const requestKey = (d: any, n: number) => `${d.sessionId ?? 'session'}:${d.agentId ?? (d.isSidechain ? 'worker' : 'main')}:${d.requestId ?? d.message?.id ?? d.uuid ?? `unidentified-${n}`}`;
function mergeUsage(a: Usage, b: Usage): Usage {
  return Object.fromEntries(USAGE_FIELDS.map((k) => [k, b[k] === null ? a[k] : a[k] === null ? b[k] : Math.max(a[k]!, b[k]!)])) as Usage;
}
export function summarizeUsage(rows: Usage[]) {
  return { requests: rows.length, usage: Object.fromEntries(USAGE_FIELDS.map((k) => {
    const values = rows.map((r) => r[k]).filter((v): v is number => v !== null);
    return [k, { total: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length, unknown: rows.length - values.length }];
  })) };
}
/** Snapshot OR event JSONL; never add snapshots to their own events. */
export function sidecarUsage(text?: string, sessions?: Set<string>) {
  if (!text?.trim()) return { available: false, reason: 'No sidecar supplied; grader usage excluded and unknown.' };
  let whole: any; try { whole = JSON.parse(text); } catch {}
  if (whole?.v === 1 && whole.usage && Number.isSafeInteger(whole.attempts)) {
    if (sessions && !sessions.has(whole.session)) return { available: false, reason: 'Sidecar session does not match.' };
    const valid = USAGE_FIELDS.every((k) => { const f = whole.usage[k]; return f && (f.total === null || typeof f.total === 'number' && Number.isFinite(f.total) && f.total >= 0) && Number.isSafeInteger(f.reported) && f.reported >= 0 && f.reported <= whole.attempts; });
    return valid ? { available: true, source: 'snapshot', attempts: whole.attempts,
      successes: Number.isSafeInteger(whole.successes) ? whole.successes : null, failures: Number.isSafeInteger(whole.failures) ? whole.failures : null,
      usage: Object.fromEntries(USAGE_FIELDS.map((k) => [k, { ...whole.usage[k], unknown: whole.attempts - whole.usage[k].reported }])) } : { available: false, reason: 'Invalid sidecar snapshot; usage excluded.' };
  }
  const events = new Map<string, { usage: Usage; outcome: string; operation: string }>();
  for (const e of parseJsonl(text)) {
    if (!e.operationId || !['compaction', 'guard'].includes(e.operation) || sessions && !sessions.has(e.session)) continue;
    const key = `${e.session}:${e.operationId}:${e.batch}:${e.attempt}`;
    events.set(key, { usage: mergeUsage(events.get(key)?.usage ?? returnedUsage(undefined), returnedUsage({ usage: e.usage })), outcome: e.outcome, operation: e.operation });
  }
  const rows = [...events.values()];
  const outcomes = Object.fromEntries(['success', 'http_error', 'invalid_response', 'transport_error'].map((name) => [name, rows.filter((r) => r.outcome === name).length]));
  return events.size ? { available: true, source: 'events', attempts: events.size, successes: outcomes.success,
    failures: outcomes.http_error + outcomes.invalid_response + outcomes.transport_error,
    unknown_outcomes: rows.filter((r) => !(r.outcome in outcomes)).length, outcomes,
    operations: Object.fromEntries(['compaction', 'guard'].map((name) => [name, rows.filter((r) => r.operation === name).length])),
    ...summarizeUsage(rows.map((r) => r.usage)) } : { available: false, reason: 'No matching sidecar attempts; grader usage unknown.' };
}
function appendAssistant(view: Msg[], key: string, blocks: any[]): Msg[] {
  const at = view.findIndex((m) => m.request === key);
  const old: Msg = at < 0 ? { role: 'assistant', text: '', toolUses: [], request: key } : view[at];
  const text = blocks.filter((b) => b.type !== 'tool_use').map((b) => b.type === 'text' ? b.text ?? '' : contentText(b)).join('\n');
  const uses = new Map(old.toolUses.map((u) => [u.tool_use_id, u]));
  for (const b of blocks) if (b.type === 'tool_use') uses.set(b.id, { tool_use_id: b.id, tool: b.name, input: withoutMedia(clone(b.input ?? {})) });
  const combined = !text || old.text === text ? old.text : text.startsWith(old.text) ? text : old.text + text;
  const message = { ...old, text: combined, toolUses: [...uses.values()] };
  return at < 0 ? [...view, message] : view.map((m, i) => i === at ? message : m);
}
/** Same planner and cumulative path archives as runtime, without paid grading. */
export function deterministicFold(view: Msg[], state: { next: number; archives: Map<string, string> }, keep: number, maxIndex: number): Msg[] | null {
  const bounds = foldBounds(view as never, keep); if (!bounds) return null;
  const priorPaths = view.slice(1, bounds.from).flatMap((m) => [...m.text.matchAll(/^Paths: decompress id=(paths-f\d+)$/gm)].map((match) => state.archives.get(match[1])));
  if (priorPaths.some((p) => p === undefined)) return null;
  const region = view.slice(bounds.from, bounds.to), results = new Set(region.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id)));
  if (region.some((m) => m.toolUses.some((u) => !results.has(u.tool_use_id) && u.text === undefined))) return null;
  const n = state.next;
  const planned = foldIndex(view as never, bounds, new Map(region.flatMap((m) => m.toolUses.map((u) => [u.tool_use_id, 400]))), n, maxIndex, priorPaths as string[]);
  if (planned.text === null) return null;
  const index = foldIndex(view as never, bounds, new Map(), n, maxIndex, priorPaths as string[]);
  if (index.text === null) return null;
  state.archives.set(`paths-f${n}`, planned.paths); state.archives.set(`index-f${n}`, planned.full); state.next++;
  return [view[0], { role: 'user', text: index.text, toolUses: [] }, ...view.slice(bounds.to)];
}
function estimate(views: Msg[][], resets: Set<number>, o: Required<Options>) {
  let previous: string[] = [], sent = 0, weighted = 0, peak = 0, last = 0;
  views.forEach((view, index) => {
    const serialized = view.map((m) => JSON.stringify({ role: m.role, text: m.text, toolUses: m.toolUses, toolResults: m.toolResults }));
    let same = 0; if (!resets.has(index)) while (same < previous.length && same < serialized.length && previous[same] === serialized[same]) same++;
    const sizes = messageSizes(view as never).map(tokens), total = sizes.reduce((a, b) => a + b, 0), read = sizes.slice(0, same).reduce((a, b) => a + b, 0);
    last = o.prefixTokens + total; sent += last; peak = Math.max(peak, last);
    weighted += read * o.cacheReadWeight + (total - read) * o.cacheWriteWeight + o.prefixTokens * (index ? o.cacheReadWeight : o.cacheWriteWeight);
    previous = serialized;
  });
  return { requests: views.length, estimated_input_tokens_sent: sent, estimated_peak_context_tokens: peak, estimated_last_context_tokens: last, assumed_cache_weighted_input_units: weighted, uncached_input_units: sent * o.inputWeight };
}
export function analyze(records: readonly any[], config: Options = {}, sidecar?: string) {
  const options: Required<Options> = { prefixTokens: finite(config.prefixTokens, 0), inputWeight: finite(config.inputWeight, 1), cacheWriteWeight: finite(config.cacheWriteWeight, 2), cacheReadWeight: finite(config.cacheReadWeight, 0.1), resetCacheAfterFold: config.resetCacheAfterFold !== false, minimum: finite(config.minimum, 50000), growth: finite(config.growth, 20000), keep: finite(config.keep, 6000), liveMax: liveResultBudget(config.liveMax), maxIndex: finite(config.maxIndex, 16000) };
  let original: Msg[] = [], live: Msg[] = [], folded: Msg[] = [], lastFold = 0, folds = 0;
  const frames: { key: string; original: Msg[]; live: Msg[]; deterministic_fold: Msg[] }[] = [];
  const calls = new Map<string, string>(), seenRequests = new Set<string>(), finished = new Set<string>(), seenRecords = new Set<string>();
  const observed = new Map<string, { worker: boolean; usage: Usage }>(), sessions = new Set<string>(), resets = new Set<number>();
  const foldState = { next: 1, archives: new Map<string, string>() }; let unidentified = 0, excludedMediaBlocks = 0;
  records.forEach((d, ordinal) => {
    const m = d.message; if (!m || !['user', 'assistant'].includes(d.type)) return;
    if (d.sessionId) sessions.add(d.sessionId);
    const worker = !!d.isSidechain || !!d.agentId, key = requestKey(d, ordinal);
    if (d.type === 'assistant') {
      const previous = observed.get(key);
      observed.set(key, { worker, usage: mergeUsage(previous?.usage ?? returnedUsage(undefined), returnedUsage(m)) });
      if (!previous && !d.requestId && !m.id) unidentified++;
    }
    if (worker) return;
    const recordKey = `${d.uuid ?? key}:${d.type}:${JSON.stringify(m.content)}:${m.stop_reason ?? ''}`;
    if (seenRecords.has(recordKey)) return; seenRecords.add(recordKey);
    const blocks = blocksOf(m);
    excludedMediaBlocks += mediaCount(blocks);
    if (d.type === 'assistant') {
      // Every update replaces arrays/messages; retaining these immutable versions avoids copying history per request.
      if (!seenRequests.has(key)) { frames.push({ key, original, live, deterministic_fold: folded }); seenRequests.add(key); }
      if (finished.has(key)) return;
      original = appendAssistant(original, key, blocks); live = appendAssistant(live, key, blocks); folded = appendAssistant(folded, key, blocks);
      for (const b of blocks) if (b.type === 'tool_use') calls.set(b.id, b.name);
      if (m.stop_reason === 'end_turn') {
        finished.add(key);
        const now = options.prefixTokens + tokens(chars(folded as never));
        if (shouldCompact(now, lastFold, options.minimum, options.growth)) {
          const next = deterministicFold(folded, foldState, options.keep, options.maxIndex);
          if (next) { folded = next; folds++; lastFold = options.prefixTokens + tokens(chars(folded as never)); if (options.resetCacheAfterFold) resets.add(frames.length); }
        }
      }
    } else {
      const text = blocks.filter((b) => b.type !== 'tool_result').map((b) => b.type === 'text' ? b.text ?? '' : contentText(b)).join('\n');
      const raw = blocks.filter((b) => b.type === 'tool_result').map((b) => ({ tool_use_id: b.tool_use_id, isError: !!b.is_error, content: clone(b.content ?? ''), text: contentText(b.content) }));
      const transformed = raw.map((r) => {
        const tool = calls.get(r.tool_use_id); if (!tool) return r;
        const response = projectToolResult(tool, r.tool_use_id, { result: r.content, isError: r.isError }, options.liveMax).response;
        return { ...r, content: response.result, text: contentText(response.result) };
      });
      const message: Msg = { role: 'user', text, toolUses: [], ...(raw.length ? { toolResults: raw } : {}) };
      const compressed: Msg = { ...message, ...(raw.length ? { toolResults: transformed } : {}) };
      original = [...original, message]; live = [...live, compressed]; folded = [...folded, compressed];
    }
  });
  const rows = [...observed.values()];
  return { frames, archives: foldState.archives, report: {
    assumptions: { ...options, prefix: config.prefixTokens === undefined ? 'Unknown/excluded; zero added to estimates.' : 'User-configured assumption.', tokenizer: 'Canonical textual payload characters/4, not provider token counts. Structured media bytes excluded; media tokenization and unlogged framing unavailable.', excluded_media_blocks: excludedMediaBlocks, cache: 'Exact unchanged message prefix assumed reusable. Weights and fold reset are assumptions, not prices.', scope: 'Linear main-record arrival order only; branch ancestry and manual compaction are not reconstructed. Worker usage is observed separately; inherited worker prompts are unavailable. Recorded behavior is held fixed.', transforms: 'Successful archival assumed; deterministic default fold heads, no Jev calls. Only recorded end_turn triggers; idle/manual folds are not reconstructed.', usage: 'Cumulative streaming snapshots merged by maximum per field/request. Missing fields stay unknown. UUID-only or identity-free segmentation is provisional and cannot establish distinct provider requests.' },
    observed: { main: summarizeUsage(rows.filter((r) => !r.worker).map((r) => r.usage)), workers: summarizeUsage(rows.filter((r) => r.worker).map((r) => r.usage)), unidentified_requests: unidentified, sidecar: sidecarUsage(sidecar, sessions.size ? sessions : undefined) },
    counterfactuals: { original_recorded: estimate(frames.map((f) => f.original), new Set(), options), live_only: estimate(frames.map((f) => f.live), new Set(), options), deterministic_fold_without_jev: { ...estimate(frames.map((f) => f.deterministic_fold), resets, options), folds } },
  } };
}
if (import.meta.main) {
  const paths: string[] = [], options: Options = {}; let sidecar: string | undefined;
  const flags: Record<string, keyof Options> = { prefix: 'prefixTokens', input: 'inputWeight', write: 'cacheWriteWeight', read: 'cacheReadWeight', minimum: 'minimum', growth: 'growth', keep: 'keep', live: 'liveMax', index: 'maxIndex' };
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg); if (!m) { paths.push(arg); continue; }
    if (m[1] === 'sidecar') sidecar = readFileSync(m[2], 'utf8');
    else if (m[1] === 'reset-cache') options.resetCacheAfterFold = m[2] !== 'false';
    else if (flags[m[1]]) (options as any)[flags[m[1]]] = Number(m[2]);
    else throw new Error(`unknown option: ${m[1]}`);
  }
  for (const path of paths) console.log(JSON.stringify({ path, ...analyze(parseJsonl(readFileSync(path, 'utf8')), options, sidecar).report }, null, 2));
}
