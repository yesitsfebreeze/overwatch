// Compaction (once the componion plugin):
//   live     every tool result is minified before the model reads it; the original stays on disk
//   rolling  old history and earlier indexes consolidate into one bounded index at each fold.
//            The first prompt stays exact; folded originals remain reachable by id (decompress).
//            Jev decides how much of each folded tool result the index keeps. A fold runs in the
//            background after a turn, once the context grew enough to pay for the one prompt-cache
//            rewrite it causes, or once the cache has gone cold anyway.
//   fallback the built-in summary over a slimmed transcript when nothing can be folded
//   turn end a failed turn distilled to one line
import type { EngineInterface, Register, SessionMessage } from 'claude-code';
import { compact, resolveOptions } from '../jev/compact.js';
import { estimateTokens } from '../jev/state.js';
import { buildJevRequest, noulAnswer, DEFAULT_MODEL } from '../jev/request.js';
import { TOOL_PREFIX, type ToolSpec } from './catalog.ts';
import { STATE_DIR } from './io.ts';
import { observedRequest, usageOperation, usageSnapshot, type UsageOperation } from './usage.ts';
import { incident } from './incidents.ts';
import { liveResultBudget, originalPage } from './paging.ts';

type Limits = { keepRecentTokens: number; toolResultMaxChars: number; outcomeMaxChars: number; cutUserChars?: number };

const SUMMARY_TEMPLATE = `Structure the summary under these headings, terse, facts only:
## Goal
## Constraints & Preferences
## Progress (done / in progress / blocked)
## Key Decisions
## Next Steps
## Critical Context (exact paths, commands, error strings, ids)
Carry the <read-files> and <modified-files> lists below forward verbatim.`;

const FILE_TOOLS: Record<string, 'read' | 'modified'> = {
  Read: 'read', Grep: 'read', Glob: 'read', NotebookRead: 'read',
  Edit: 'modified', Write: 'modified', MultiEdit: 'modified', NotebookEdit: 'modified',
};
// Tools whose output the model copies back verbatim (Edit's old_string): never minified.
const VERBATIM = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_TOOLS = 8;
export const FOLD_TAG = '[overwatch fold';

export const tokens = (chars: number) => Math.ceil(chars / 4);

export function cut(text: string, max: number, id?: string): string {
  max = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (text.length <= max) return text;
  const notice = `\n[… overwatch cut${id ? `; decompress id=${id}` : ''} …]\n`;
  if (notice.length >= max) return notice.slice(0, max);
  const head = Math.ceil((max - notice.length) / 2), tail = max - notice.length - head;
  return text.slice(0, head) + notice + (tail ? text.slice(-tail) : '');
}

// Loss-free for reading: ANSI colour, progress-bar overwrites, trailing blanks, blank-line runs and repeated lines go.
export function minify(text: string, maxChars: number, id?: string): string {
  if (text.length < 200) return cut(text, maxChars, id);
  const lines = text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1).trimEnd());
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
    if (!(lines[i] === '' && out.at(-1) === '')) out.push(j > i && lines[i] ? `${lines[i]} [×${j - i + 1}]` : lines[i]);
    i = j + 1;
  }
  return cut(out.join('\n'), maxChars, id);
}

export function minifyDeep(value: unknown, maxChars: number, id?: string): unknown {
  if (typeof value === 'string') return minify(value, maxChars, id);
  if (Array.isArray(value)) return value.map((v) => minifyDeep(v, maxChars, id));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, minifyDeep(v, maxChars, id)]));
  return value;
}

const safeId = (id: unknown): id is string => typeof id === 'string' && /^[\w.-]{1,160}$/.test(id);
const hasMedia = (v: any): boolean => !!v && typeof v === 'object' && (
  v.isImage === true || /^(?:image|image_url|audio|input_audio|video|document|file|blob)$/.test(v.type ?? '') ||
  (v.type === 'base64' && typeof v.data === 'string') || (typeof v.blob === 'string' && typeof (v.mimeType ?? v.mime_type) === 'string') ||
  /^(?:image|audio|video)\//.test(v.mimeType ?? v.mime_type ?? '') ||
  Object.values(v).some(hasMedia)
);

function boundedValue(value: unknown, max: number, id: string, error: boolean): unknown {
  const small = minifyDeep(value, max, id);
  if (JSON.stringify(small).length <= max && (!error || JSON.stringify(value).length <= max)) return small;
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (error) {
    const evidence = text.split(/\n|\\n/).filter((line) => /\b(error|fail(?:ed|ure)?|assertion|panic|traceback)\b/i.test(line)).slice(0, 4).map((line) => cut(line, 200)).join('\n');
    if (evidence) text = evidence + '\n' + text;
  }
  let low = 0, high = Math.min(text.length, max);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (JSON.stringify(cut(text, mid, id)).length <= max) low = mid;
    else high = mid - 1;
  }
  return cut(text, low, id);
}

const stripRecap = (text: string) => text.replace(/<recap>[\s\S]*?<\/recap>\s*/g, '');
// `!` command output rides in user text; old runs keep a head and tail (excludeFromContext).
const cutBash = (text: string, max: number) =>
  text.replace(/(<bash-std(?:out|err)>)([\s\S]*?)(<\/bash-std(?:out|err)>)/g, (_, a, body, b) => a + cut(body, max) + b);

const size = (m: SessionMessage) => m.text.length
  + m.toolUses.reduce((k, u) => k + (u.text?.length ?? 0) + JSON.stringify(u.input).length, 0)
  + (m.toolResults ?? []).reduce((k, r) => k + r.text.length, 0);
export const chars = (ms: readonly SessionMessage[]) => ms.reduce((n, m) => n + size(m), 0);

// Cut point: a message without tool results. Compaction runs between turns, so every call before it
// has its result before it too, and a long autonomous turn still folds.
const cutPoint = (m: SessionMessage) => !m.toolResults?.length;

// Oldest index kept whole: the newest `keepTokens` (chars/4), moved back to a cut point.
export function keepFrom(messages: readonly SessionMessage[], keepTokens: number): number {
  let i = messages.length, budget = keepTokens;
  while (i > 0 && budget > 0) budget -= tokens(size(messages[--i]));
  while (i > 0 && !cutPoint(messages[i])) i--;
  return i;
}

export function slim(messages: readonly SessionMessage[], limits: Limits): SessionMessage[] {
  const from = keepFrom(messages, limits.keepRecentTokens);
  return messages.map((m, i) => {
    if (i >= from) return m;
    let text = cutBash(stripRecap(m.text), limits.toolResultMaxChars);
    if (limits.cutUserChars && m.role === 'user') text = cut(text, limits.cutUserChars);
    const toolResults = m.toolResults?.map((r) => {
      const max = r.isError ? limits.outcomeMaxChars : limits.toolResultMaxChars;
      return r.text.length <= max ? r : { tool_use_id: r.tool_use_id, isError: r.isError, text: cut(r.text, max, r.tool_use_id) };
    });
    const toolUses = m.toolUses.map((u) =>
      u.text && u.text.length > limits.toolResultMaxChars
        ? { ...u, result: undefined, text: cut(u.text, limits.toolResultMaxChars, u.tool_use_id) }
        : u,
    );
    const changed = text !== m.text
      || toolResults?.some((r, j) => r !== m.toolResults![j])
      || toolUses.some((u, j) => u !== m.toolUses[j]);
    if (!changed) return m;
    return { role: m.role, text, toolUses, ...(toolResults ? { toolResults } : {}) };
  });
}

const filePath = (u: { input: Record<string, unknown> }) => {
  const p = u.input.file_path ?? u.input.notebook_path ?? u.input.path;
  return typeof p === 'string' ? p : undefined;
};

export function fileLists(messages: readonly SessionMessage[]): string {
  const files = { read: new Set<string>(), modified: new Set<string>() };
  for (const m of messages)
    for (const u of m.toolUses) {
      const kind = FILE_TOOLS[u.tool], path = filePath(u);
      if (kind && path) files[kind].add(path);
    }
  for (const p of files.modified) files.read.delete(p);
  return `<read-files>\n${[...files.read].join('\n')}\n</read-files>\n<modified-files>\n${[...files.modified].join('\n')}\n</modified-files>`;
}

// Heads Jev grants a folded tool result: kept whole-ish, trimmed, or id only.
const HEAD = { keep: 400, drop_result: 100, drop_call: 0 } as const;
type Heads = Map<string, number>;

const oneLine = (t: string, n: number) => t.replace(/\s+/g, ' ').trim().slice(0, n);

// The leading run a fold never touches: the first prompt (its context blocks ride on it) and every earlier fold.
export function frozenEnd(messages: readonly SessionMessage[]): number {
  let i = messages.length ? 1 : 0;
  while (i < messages.length && messages[i].text.startsWith(FOLD_TAG)) i++;
  return i;
}

// One short id per fold index line, text and tool call alike: fN.0, fN.1, …
// A call's original stays under its toolu id; fN.k.ref points there.
function lineIds(region: readonly SessionMessage[], n: number): Map<object, string> {
  const ids = new Map<object, string>();
  let c = 0;
  for (const m of region) {
    if (m.text) ids.set(m, `f${n}.${c++}`);
    for (const u of m.toolUses) ids.set(u, `f${n}.${c++}`);
  }
  return ids;
}

// The bare argument a call is known by; compact JSON for anything else.
const mainArg = (u: { input: Record<string, unknown> }) => {
  const i = u.input ?? {};
  const v = filePath(u) ?? [i.command, i.pattern, i.prompt, i.url].find((x) => typeof x === 'string');
  return typeof v === 'string' ? v : JSON.stringify(i);
};

export function foldBounds(messages: readonly SessionMessage[], keepTokens: number): { from: number; to: number } | null {
  const from = frozenEnd(messages);
  let to = keepFrom(messages, keepTokens);
  // One message holds the whole budget right past the frozen run: fold up to the next cut point instead.
  if (to - from < 2) to = messages.findIndex((m, i) => i > from + 1 && cutPoint(m));
  if (to < 0 || to - from < 2) return null;
  return { from, to };
}

/** Preserve durable lines verbatim; older tool heads yield to the aggregate index budget. */
export function foldIndex(messages: readonly SessionMessage[], { from, to }: { from: number; to: number }, heads: Heads, n: number, maxChars = 16000, priorPaths: string[] = []) {
  const region = messages.slice(from, to);
  const ids = lineIds(region, n);
  const entries: { line: string; durable: boolean }[] = [];
  const paths = { read: new Set<string>(), modified: new Set<string>() };
  const collect = (text: string) => {
    let section: 'read' | 'modified' | undefined;
    for (const line of text.split('\n')) {
      if (line === '<read-files>') { section = 'read'; continue; }
      if (line === '<modified-files>') { section = 'modified'; continue; }
      if (/^<\/(?:read|modified)-files>$/.test(line)) { section = undefined; continue; }
      if (section) { if (line) paths[section].add(line); continue; }
      if (!line.trim() || /^\[overwatch fold F\d+:/.test(line) || /^(?:Archived indexes: index-f1 through index-f\d+ \(stored folds\)\.|Paths: decompress id=paths-f\d+)$/.test(line)) continue;
      entries.push({ line, durable: !/^f\d+\.\d+ \S+ .* \(\d+ chars\)(?:: .*)?$/.test(line) });
    }
  };
  for (const m of messages.slice(1, from)) collect(m.text);
  for (const paths of priorPaths) collect(paths);
  const results = new Map(region.flatMap((m) => (m.toolResults ?? []).map((r) => [r.tool_use_id, r] as const)));
  for (const m of region) {
    if (m.text) entries.push({ line: `${m.role === 'user' ? 'u' : 'a'} ${ids.get(m)}: ${oneLine(stripRecap(m.text), 240)}${m.text.length > 240 ? ` (+${m.text.length - 240} chars)` : ''}`, durable: true });
    for (const u of m.toolUses) {
      const out = results.get(u.tool_use_id)?.text ?? u.text ?? '';
      const head = heads.get(u.tool_use_id) ?? HEAD.drop_result;
      entries.push({ line: `${ids.get(u)} ${u.tool} ${oneLine(mainArg(u), 80)}${u.isError || results.get(u.tool_use_id)?.isError ? ' ERROR' : ''} (${out.length} chars)${head && out ? `: ${oneLine(out, head)}` : ''}`, durable: false });
    }
  }
  collect(fileLists(region));
  for (const path of paths.modified) paths.read.delete(path);
  const pathText = `<read-files>\n${[...paths.read].join('\n')}\n</read-files>\n<modified-files>\n${[...paths.modified].join('\n')}\n</modified-files>`;
  const header = `${FOLD_TAG} F${n}: consolidated history. Exact originals: mcp__overwatch__decompress id=fN.k.]\nArchived indexes: index-f1 through index-f${n} (stored folds).\n`;
  const pathRef = `Paths: decompress id=paths-f${n}`;
  const render = (lines: string[], files: string) => header + lines.join('\n') + '\n' + files;
  const full = render(entries.map((e) => e.line), pathText);
  const durable = entries.filter((e) => e.durable).map((e) => e.line);
  if (render(durable, pathRef).length > maxChars) return { text: null, full, paths: pathText, reason: 'durable fold index exceeds maxFrozenIndexChars; context retained' };
  const inlinePaths = pathText.length <= maxChars / 4 && render(durable, pathText).length <= maxChars ? pathText : pathRef;
  let left = maxChars - render(durable, inlinePaths).length;
  const keep = new Set<number>();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].durable) keep.add(i);
    else if (entries[i].line.length + 1 <= left) { keep.add(i); left -= entries[i].line.length + 1; }
  }
  return { text: render(entries.filter((_, i) => keep.has(i)).map((e) => e.line), inlinePaths), full, paths: pathText };
}

export function fold(messages: readonly SessionMessage[], keepTokens: number, heads: Heads, n: number, maxChars = 16000): SessionMessage[] | null {
  const bounds = foldBounds(messages, keepTokens);
  if (!bounds) return null;
  const index = foldIndex(messages, bounds, heads, n, maxChars);
  return index.text === null ? null : [messages[0], { role: 'user', text: index.text, toolUses: [] }, ...messages.slice(bounds.to)];
}

// One line per failed turn: its tools (up to 8) and the first error, 120 chars.
export const failureLine = (fails: { tool: string; text: string }[], outcomeMax: number) =>
  `${[...new Set(fails.map((f) => f.tool))].slice(0, MAX_TOOLS).join(',')}: ${fails[0].text.replace(/\s+/g, ' ').slice(0, outcomeMax)}`;

// CONTRACT §2 (~/orchi/docs/CONTRACT.md): what kern's turn deck reads.
type Status = { saved: number; folds: number; lastFold: number; jev: string; compacting: boolean; failures: number; nextCompactAt: number };
export const statusPayload = (s: Status, ts: number, usage?: unknown) => ({ v: 1, ts, ...s, savedKind: 'estimated_context_tokens_removed', ...(usage ? { usage } : {}) });

type State = { home: string };

// A sibling of the originals dir, so decompress/search_context never list it. Plain write: $.fs has no
// rename, so a reader may rarely see a torn file and must treat bad JSON as silent.
async function publish($: EngineInterface, s: Status) {
  try {
    const path = `${await $.session.cwd()}/${STATE_DIR}/status/${await $.session.id()}.json`;
    await $.fs.write(path, JSON.stringify(statusPayload(s, Date.now(), await usageSnapshot($))));
  } catch { /* status is best effort */ }
}

async function dir($: EngineInterface, s: State) {
  return (s.home ||= `${await $.session.cwd()}/${STATE_DIR}/context/${await $.session.id()}`);
}

async function keepOriginal($: EngineInterface, s: State, id: string, text: string, ext = 'txt'): Promise<boolean> {
  if (!safeId(id)) return false;
  try {
    const path = `${await dir($, s)}/${id}.${ext}`;
    if (await $.fs.exists(path)) return typeof await $.fs.read(path) === 'string';
    await $.fs.write(path, text);
    return true;
  } catch { return false; }
}

// Jev grades each tool call in the region; its answer always shapes the fold (a paid call is never
// discarded). Unreachable, every call gets a short head and the fold goes ahead anyway.
export async function jevHeads($: EngineInterface, region: readonly SessionMessage[], options: object, out: { jev: string }): Promise<Heads> {
  const heads: Heads = new Map();
  if (!region.some((m) => m.toolUses.length)) return heads;
  try {
    const apiKey = (await $.env.get('TYPESAFE_API_KEY'))
      ?? (((await $.settings.read()).env as Record<string, unknown> | undefined)?.TYPESAFE_API_KEY as string | undefined);
    if (!apiKey) throw new Error('no TYPESAFE_API_KEY');
    const budget = resolveOptions(options);
    let requests = 0, inputTokens = 0;
    let operation: UsageOperation | undefined;
    const asker = { ask: async (st: never, questions: never) => {
      const q = buildJevRequest({ apiKey, model: DEFAULT_MODEL }, st, questions);
      const init = { method: q.method, headers: q.headers, body: q.body };
      const requestTokens = estimateTokens(q.body);
      if (requests >= budget.maxRequests || inputTokens + requestTokens > budget.maxTotalTokens) throw new Error('fold grading budget exhausted');
      const send = () => {
        requests++;
        inputTokens += requestTokens;
        return $.http.fetch(q.url, init);
      };
      // A transport rejection may follow provider acceptance; never send it again.
      operation ??= await usageOperation($, 'compaction');
      return observedRequest($, operation, requests + 1, requestTokens, send, (body) => {
        if (!body?.answers || typeof body.answers !== 'object') throw new Error('invalid_response');
        for (const name of Object.keys(questions)) {
          const p = noulAnswer(body.answers, name);
          if (p < 0 || p > 1) throw new Error('invalid_response');
        }
        return body;
      }, { state: st, questions });
    } };
    const result = await compact(region as never, asker as never, options);
    for (const d of result.decisions) heads.set(d.tool_use_id, HEAD[d.action as keyof typeof HEAD] ?? HEAD.drop_result);
    out.jev = 'jev';
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    const reason = ['transport_error', 'http_error', 'invalid_response', 'no TYPESAFE_API_KEY', 'fold grading budget exhausted'].includes(message) ? message : 'grading unavailable';
    $.ui.log(`overwatch compaction: jev failed: ${reason}`, { to: 'debug' });
    out.jev = `jev failed: ${reason.slice(0, 80)}`;
  }
  return heads;
}

/** Compaction's tools, declared through overwatch's catalog (catalog.ts) when compaction is on. */
export const COMPACTION_TOOLS: Record<string, ToolSpec> = {
  decompress: {
    description: 'Read an exact page of a stored original. Pass the id from a cut marker or fold index. Follow next_offset until null; concatenated text pages reproduce the stored original exactly. Offsets count JavaScript string characters.',
    properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } },
    required: ['id'],
  },
  search_context: {
    description: 'Search every message and tool result cut or folded out of the context this session. Returns matching lines with their decompress id (up to 50).',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

/** Off for the A/B baseline: `--settings` pluginConfigs overwatch enabled=false. */
export const compactionEnabled = (options: Record<string, unknown>) => options.enabled !== false;

/** This session's settings and counters. Module state, set by `register` (a reload starts it over), so overwatch.ts can call the handlers below from the plugin's one hook per event. */
type Session = {
  limits: Limits; liveMax: number; maxIndex: number; foldFrom: number; growthTokens: number; cacheTtlMs: number; jevOptions: object;
  saved: number; folds: number; failures: number; lastFold: number; jev: string; compacting: boolean; lastCompactAt: number; foldedRestart: boolean;
  idle?: { cancel: () => void }; state: State; grade: { jev: string }; fails: { tool: string; text: string }[];
};

function session(options: Record<string, unknown>): Session {
  const n = (k: string, d: number) => (typeof options[k] === 'number' ? (options[k] as number) : d);
  return {
    limits: { keepRecentTokens: n('keepRecentTokens', 6000), toolResultMaxChars: n('toolResultMaxChars', 2000), outcomeMaxChars: n('outcomeMaxChars', 120) },
    liveMax: liveResultBudget(options.liveResultMaxChars),
    maxIndex: Math.max(0, Number.isFinite(n('maxFrozenIndexChars', 16000)) ? Math.floor(n('maxFrozenIndexChars', 16000)) : 16000),
    // After a fold every message is written to the prompt cache again (measured on logged request bodies:
    // Claude Code merges the fold block into the first user message). That pays only once the context is
    // big, so a fold waits for `foldFromTokens`, then runs every `compactEveryTokens` (bench/replay.ts
    // sweep: 50k/20k saved most, on every replayed session). A cold cache folds for free.
    foldFrom: n('foldFromTokens', 50000),
    growthTokens: n('compactEveryTokens', 20000),
    cacheTtlMs: n('cacheTtlMinutes', 60) * 60000,
    jevOptions: {
      preserveRecentMessages: 0,
      keepThreshold: n('keepThreshold', 0.6),
      maxStateTokens: n('maxStateTokens', 15000),
      maxRequestTokens: n('maxRequestTokens', 18000),
      maxTotalTokens: n('maxTotalTokens', 36000),
      maxRequests: n('maxRequests', 2),
      truncateHeadChars: n('truncateHeadChars', 150),
    },
    saved: 0, folds: 0, failures: 0, lastFold: 0, jev: '', compacting: false, lastCompactAt: 0, foldedRestart: false,
    state: { home: '' }, grade: { jev: '' }, fails: [],
  };
}

let c: Session = session({});
let foldInFlight = false;
const status = (active: Session = c): Status => ({ saved: active.saved, folds: active.folds, lastFold: active.lastFold, jev: active.jev, compacting: active.compacting, failures: active.failures, nextCompactAt: active.lastCompactAt + active.growthTokens });

/** Minifies every tool result before the model reads it and stores the original. Called from the plugin's one unmatched tool.call hook. */
export async function compactToolCall($: EngineInterface, e: any, next: (e: any) => Promise<any>): Promise<any> {
  const r = await next(e);
  if (r.deny !== undefined) return r;
  if (r.isError && !e.agentId) c.fails.push({ tool: e.tool, text: String(r.text ?? JSON.stringify(r.result)) });
  if (VERBATIM.has(e.tool) || hasMedia(r) || e.tool === TOOL_PREFIX + 'decompress') return r;
  try {
    const id = e.tool_use_id;
    if (!safeId(id)) return r;
    const payload: Record<string, unknown> = {};
    if (r.result !== undefined) payload.result = r.result;
    if (typeof r.text === 'string') payload.text = r.text;
    const before = JSON.stringify(payload);
    if (!Object.keys(payload).length) return r;
    if (r.result?.next_offset !== undefined && typeof r.result?.total_chars === 'number' && before.length <= c.liveMax) return r;
    let budget = c.liveMax - 32;
    const entries = Object.entries(payload).sort((a, b) => JSON.stringify(a[1]).length - JSON.stringify(b[1]).length);
    const limited: Record<string, unknown> = {};
    entries.forEach(([key, value], i) => {
      limited[key] = boundedValue(value, Math.floor(budget / (entries.length - i)), id, !!r.isError);
      budget -= JSON.stringify(limited[key]).length;
    });
    const k = before.length - JSON.stringify(limited).length;
    if (k <= 0) return r;
    const original = Object.keys(payload).length > 1 ? before : typeof Object.values(payload)[0] === 'string' ? Object.values(payload)[0] as string : JSON.stringify(Object.values(payload)[0]);
    if (!await keepOriginal($, c.state, id, original)) return r;
    c.saved += tokens(k);
    return { ...r, ...limited };
  } catch {
    return r;
  }
}

/** After a turn: a failed turn leaves one line in the incident ledger, and a fold runs when it pays (growth or cold cache). Called from the plugin's one turn.complete hook. */
export async function compactTurnEnd($: EngineInterface, e: { agentId?: string }): Promise<void> {
  if (e.agentId) return;
  if (c.fails.length) {
    const line = failureLine(c.fails, c.limits.outcomeMaxChars);
    c.fails = [];
    c.failures++;
    void incident($, 'failed_turn', line);
  }
  const tokensNow = (await $.session.usage()).context.tokens ?? 0;
  const run = async () => {
    if (c.compacting) return;
    c.compacting = true;
    c.lastFold = 0;
    try { await $.session.compact(); } catch { /* headless sessions cannot compact */ } finally {
      c.compacting = false;
      c.lastCompactAt = tokensNow - c.lastFold;
      void publish($, status());
    }
  };
  if (tokensNow >= c.foldFrom && tokensNow - c.lastCompactAt >= c.growthTokens) void run();
  // Idle past the cache TTL: the next request rewrites the cache anyway, so a fold then costs nothing.
  c.idle?.cancel();
  c.idle = $.clock.after(c.cacheTtlMs + 30000, () => { void run(); });
  await publish($, status());
}

/** decompress: the exact original by id. */
async function decompress($: EngineInterface, e: { id?: unknown; offset?: unknown; limit?: unknown }) {
  const id = String(e.id ?? '').replace(/^#/, '');
  const home = await dir($, c.state);
  // Exact id: a suffix match would read f11.1 back for f1.1.
  const read = async (x: string, ext: string) => (safeId(x) ? $.fs.read(`${home}/${x}.${ext}`).catch(() => undefined) : undefined);
  // A fold's short id for a call is a .ref naming its toolu original.
  const ref = await read(id, 'ref');
  const text = await read(ref?.trim() ?? id, 'txt');
  if (text === undefined) return { result: `no original stored for ${id}`, isError: true as const };
  try { return { result: originalPage(text, id, e.offset === undefined ? 0 : Number(e.offset), e.limit === undefined ? 6000 : Number(e.limit), c.liveMax - 16) }; }
  catch (err) { return { result: String(err), isError: true as const }; }
}

/** search_context: matching lines over every stored original, each with its decompress id. */
async function searchContext($: EngineInterface, e: { query?: unknown }) {
  const q = String(e.query ?? '').toLowerCase();
  const hits: string[] = [];
  const home = await dir($, c.state);
  const names = (await $.fs.list(home).catch(() => [])).map((f) => f.name).filter((name) => name.endsWith('.txt'));
  // Read together, matched in listing order: a long session holds hundreds of originals.
  const texts = await Promise.all(names.map((name) => $.fs.read(`${home}/${name}`).catch(() => '')));
  names.forEach((name, i) => {
    for (const line of texts[i].split('\n')) if (hits.length < 50 && line.toLowerCase().includes(q)) hits.push(`${name.replace(/\.txt$/, '')}: ${line.slice(0, 200)}`);
  });
  return { result: hits.join('\n') || `nothing matches ${q}` };
}

/** One fold transaction: reserve its identity, retain every original, then grade and replace. */
export async function compactHistory($: EngineInterface, e: any, next: (e: any) => Promise<any>): Promise<any> {
  if (foldInFlight) return { skip: 'fold already in progress' };
  foldInFlight = true;
  const active = c;
  const main = !e.agentId;
  if (main) { active.foldedRestart = false; active.lastFold = 0; }
  const skip = async (reason: string) => {
    const message = reason.slice(0, 180);
    if (main) {
      if (active.jev !== message) $.ui.log(`overwatch compaction: ${message}`, { to: 'debug' });
      active.jev = message;
      await publish($, status(active));
    }
    return { skip: message };
  };
  try {
    const bounds = foldBounds(e.messages, active.limits.keepRecentTokens);
    if (!bounds) {
      if (e.trigger === 'plugin') return { skip: 'nothing to fold yet' };
      const instructions = [e.instructions, SUMMARY_TEMPLATE, fileLists(e.messages)].filter(Boolean).join('\n\n');
      const r = await next({ ...e, messages: slim(e.messages, active.limits), instructions });
      if (active !== c) return skip('session changed during fold; context retained');
      if (r.messages && main) active.saved += Math.max(0, tokens(chars(e.messages) - chars(r.messages)));
      return r;
    }
    const home = await dir($, active.state);
    const counterPath = `${home}/fold-counter.json`;
    let highest = 0;
    if (await $.fs.exists(counterPath)) {
      highest = JSON.parse(await $.fs.read(counterPath));
      if (!Number.isSafeInteger(highest) || highest < 0) return skip('invalid fold counter; context retained');
    }
    if (await $.fs.exists(home)) for (const entry of await $.fs.list(home)) {
      const m = /^(?:index-f|paths-f|f)(\d+)(?:\.|$)/.exec(entry.name);
      if (m) highest = Math.max(highest, Number(m[1]));
    }
    const old = e.messages.slice(1, bounds.from) as SessionMessage[];
    const priorPaths: string[] = [];
    for (const m of old) {
      for (const match of m.text.matchAll(/(?:\bF(\d+):|\bf(\d+)\.)/g)) highest = Math.max(highest, Number(match[1] ?? match[2]));
      for (const match of m.text.matchAll(/^Paths: decompress id=(paths-f\d+)$/gm)) priorPaths.push(await $.fs.read(`${home}/${match[1]}.txt`));
    }
    const n = highest + 1;
    if (!Number.isSafeInteger(n)) return skip('fold id exhausted; context retained');
    const region = e.messages.slice(bounds.from, bounds.to) as SessionMessage[];
    const fullHeads = new Map(region.flatMap((m) => m.toolUses.map((u) => [u.tool_use_id, HEAD.keep] as const)));
    const planned = foldIndex(e.messages, bounds, fullHeads, n, active.maxIndex, priorPaths);
    if (planned.text === null) return skip(planned.reason!);
    await $.fs.write(counterPath, JSON.stringify(n));
    const retain = async (id: string, text: string, ext = 'txt') => {
      if (!await keepOriginal($, active.state, id, text, ext)) throw new Error('original archive unavailable; context retained');
    };
    for (const m of old) {
      const number = /^\[overwatch fold F(\d+):/.exec(m.text)?.[1];
      if (!number) throw new Error('unrecognized old index; context retained');
      await retain(`index-f${number}`, m.text);
    }
    const ids = lineIds(region, n);
    const results = new Map(region.flatMap((m) => (m.toolResults ?? []).map((r) => [r.tool_use_id, r.text] as const)));
    for (const m of region) {
      if (m.text) await retain(ids.get(m)!, m.text);
      for (const u of m.toolUses) {
        const text = results.get(u.tool_use_id) ?? u.text;
        if (text === undefined) throw new Error('tool result unavailable; context retained');
        await retain(u.tool_use_id, text);
        await retain(ids.get(u)!, u.tool_use_id, 'ref');
      }
      for (const r of m.toolResults ?? []) await retain(r.tool_use_id, r.text);
    }
    await retain(`index-f${n}`, planned.full);
    await retain(`paths-f${n}`, planned.paths);
    if (active !== c) return skip('session changed during fold; context retained');
    const heads = await jevHeads($, region, active.jevOptions, active.grade);
    if (active !== c) return skip('session changed during fold; context retained');
    const index = foldIndex(e.messages, bounds, heads, n, active.maxIndex, priorPaths);
    if (index.text === null) return skip(index.reason!);
    const messages = [e.messages[0], { role: 'user', text: index.text, toolUses: [] }, ...e.messages.slice(bounds.to)];
    if (main) {
      const saved = Math.max(0, tokens(chars(e.messages) - chars(messages)));
      active.saved += saved; active.lastFold = saved; active.folds++; active.foldedRestart = true;
      active.jev = `F${n}: ${region.length} msgs folded · ${active.grade.jev}`;
      await publish($, status(active));
    }
    if (active !== c) return skip('session changed during fold; context retained');
    return { messages };
  } catch {
    return await skip('fold archive unavailable; context retained');
  } finally { foldInFlight = false; }
}

/** Compaction's own hooks. Off (the A/B baseline) it registers nothing; overwatch.ts then skips the two handlers above. */
export const register: Register = (on, options) => {
  c = session(options);
  if (!compactionEnabled(options)) return;

  on('tool.call', { tool: `${TOOL_PREFIX}decompress` }, async ($, e) => decompress($, e as any));
  on('tool.call', { tool: `${TOOL_PREFIX}search_context` }, async ($, e) => searchContext($, e as any));

  on('session.compact', async ($, e, next) => compactHistory($, e, next));

  // A fold is a compaction, so the engine re-runs every SessionStart hook with source `compact`. The frozen
  // first message still holds what they said at startup, so the re-run would only add a copy (a hook's stdout
  // rides beside the result, so dropping `additionalContext` is not enough): skip it. After the built-in
  // summary they run as usual.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source !== 'compact' || !c.foldedRestart) return next(e);
    c.foldedRestart = false;
    return {};
  });
};
