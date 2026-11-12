// Compaction (once the componion plugin):
//   live     every tool result is minified before the model reads it; the original stays on disk
//   rolling  old history folds into an index block appended after the earlier folds. Nothing before it
//            is rewritten, and every folded message stays reachable by id (decompress, search_context).
//            Jev decides how much of each folded tool result the index keeps. A fold runs in the
//            background after a turn, once the context grew enough to pay for the one prompt-cache
//            rewrite it causes, or once the cache has gone cold anyway.
//   fallback the built-in summary over a slimmed transcript when nothing can be folded
//   turn end a failed turn distilled to one line
import type { EngineInterface, Register, SessionMessage } from 'claude-code';
import { compact, resolveOptions } from '../jev/compact.js';
import { estimateTokens } from '../jev/state.js';
import { buildJevRequest, parseJevResponse, DEFAULT_MODEL } from '../jev/request.js';
import { TOOL_PREFIX, type ToolSpec } from './catalog.ts';
import { STATE_DIR } from './io.ts';
import { today } from './io.ts';
import { incident } from './incidents.ts';

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
const SKIP_KEYS = new Set(['data', 'base64', 'source']);
const MAX_TOOLS = 8;
export const FOLD_TAG = '[overwatch fold';

export const tokens = (chars: number) => Math.ceil(chars / 4);

export function cut(text: string, max: number, id?: string): string {
  if (text.length <= max) return text;
  const half = Math.max(0, Math.floor((max - 80) / 2));
  const tail = id ? `; decompress id=${id}` : '';
  return `${text.slice(0, half)}\n[… overwatch cut ${text.length - 2 * half} chars${tail} …]\n${text.slice(-half)}`;
}

// Loss-free for reading: ANSI colour, progress-bar overwrites, trailing blanks, blank-line runs and repeated lines go.
export function minify(text: string, maxChars: number, id?: string): string {
  if (text.length < 200) return text;
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

export function minifyDeep(value: unknown, maxChars: number, id?: string, key = ''): unknown {
  if (typeof value === 'string') return SKIP_KEYS.has(key) ? value : minify(value, maxChars, id);
  if (Array.isArray(value)) return value.map((v) => minifyDeep(v, maxChars, id));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, minifyDeep(v, maxChars, id, k)]));
  return value;
}

// A stored Bash result is its JSON object; its escaped \n and \" cost ~7% more than the words (measured).
function plainShell(text: string): string {
  if (!text.startsWith('{"stdout":')) return text;
  try {
    const o = JSON.parse(text);
    if (typeof o.stdout !== 'string') return text;
    return [o.stdout, o.stderr, o.interrupted ? '[interrupted]' : ''].filter(Boolean).join('\n');
  } catch { return text; }
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

// Rolling fold: messages [frozen, tail) become one index block, in order, each by id; the frozen run and the
// tail (newest `keepTokens`, from a cut point) stay the engine's own objects. Null when nothing is worth folding.
export function fold(messages: readonly SessionMessage[], keepTokens: number, heads: Heads, n: number): SessionMessage[] | null {
  const from = frozenEnd(messages);
  let to = keepFrom(messages, keepTokens);
  // One message holds the whole budget right past the frozen run: fold up to the next cut point instead.
  if (to - from < 2) to = messages.findIndex((m, i) => i > from + 1 && cutPoint(m));
  if (to < 0 || to - from < 2) return null;
  const region = messages.slice(from, to);
  const ids = lineIds(region, n);
  const lines: string[] = [];
  for (const m of region) {
    if (m.text) lines.push(`${m.role === 'user' ? 'u' : 'a'} ${ids.get(m)}: ${oneLine(stripRecap(m.text), 240)}${m.text.length > 240 ? ` (+${m.text.length - 240} chars)` : ''}`);
    for (const u of m.toolUses) {
      const out = u.text ?? '';
      const head = heads.get(u.tool_use_id) ?? HEAD.drop_result;
      lines.push(`${ids.get(u)} ${u.tool} ${oneLine(mainArg(u), 80)}${u.isError ? ' ERROR' : ''} (${out.length} chars)${head && out ? `: ${oneLine(out, head)}` : ''}`);
    }
  }
  const text = `${FOLD_TAG} F${n}: ${region.length} earlier messages, oldest first. Full text of any #id or fN.k: mcp__overwatch__decompress; search all: mcp__overwatch__search_context.]\n${lines.join('\n')}\n${fileLists(region)}`;
  return [...messages.slice(0, from), { role: 'user', text, toolUses: [] }, ...messages.slice(to)];
}

// One line per failed turn: its tools (up to 8) and the first error, 120 chars.
export const failureLine = (fails: { tool: string; text: string }[], outcomeMax: number) =>
  `${[...new Set(fails.map((f) => f.tool))].slice(0, MAX_TOOLS).join(',')}: ${fails[0].text.replace(/\s+/g, ' ').slice(0, outcomeMax)}`;

// CONTRACT §2 (~/orchi/docs/CONTRACT.md): what kern's turn deck reads.
type Status = { saved: number; folds: number; lastFold: number; jev: string; compacting: boolean; failures: number; nextCompactAt: number };
export const statusPayload = (s: Status, ts: number) => ({ v: 1, ts, ...s });

type State = { home: string };

// A sibling of the originals dir, so decompress/search_context never list it. Plain write: $.fs has no
// rename, so a reader may rarely see a torn file and must treat bad JSON as silent.
async function publish($: EngineInterface, s: Status) {
  try {
    const path = `${await $.session.cwd()}/${STATE_DIR}/status/${await $.session.id()}.json`;
    await $.fs.write(path, JSON.stringify(statusPayload(s, Date.now())));
  } catch { /* status is best effort */ }
}

async function dir($: EngineInterface, s: State) {
  return (s.home ||= `${await $.session.cwd()}/${STATE_DIR}/context/${await $.session.id()}`);
}

async function keepOriginal($: EngineInterface, s: State, id: string, text: string, ext = 'txt') {
  try {
    const path = `${await dir($, s)}/${id}.${ext}`;
    if (!(await $.fs.exists(path))) await $.fs.write(path, text);
  } catch { /* recall is best effort */ }
}

// CONTRACT §8 dataset: one line per answered Jev call. $.fs has no append or mkdir, so a child does both;
// perl's syswrite is one O_APPEND write, so kern and orly appending the same file never interleave.
async function logJev($: EngineInterface, entry: object) {
  try {
    const day = today(); // UTC day, CONTRACT §8
    const script = 'use File::Path; mkpath($ARGV[0]); open(F, ">>", "$ARGV[0]/$ARGV[1]") or die; local $/; syswrite(F, <STDIN>)';
    await $.process.run(['perl', '-e', script, `${await $.env.get('HOME')}/.jev/log`, `${day}.jsonl`], { stdin: JSON.stringify(entry) + '\n' });
  } catch { /* the dataset never fails a fold */ }
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
    const asker = { ask: async (st: never, questions: never) => {
      const q = buildJevRequest({ apiKey, model: DEFAULT_MODEL }, st, questions);
      const init = { method: q.method, headers: q.headers, body: q.body };
      const requestTokens = estimateTokens(q.body);
      const send = () => {
        if (requests >= budget.maxRequests || inputTokens + requestTokens > budget.maxTotalTokens) {
          throw new Error('fold grading budget exhausted');
        }
        requests++;
        inputTokens += requestTokens;
        return $.http.fetch(q.url, init);
      };
      const r = await send().catch(() => send());
      const res = parseJevResponse(r.status, r.ok, r.text);
      void logJev($, { ts: Date.now(), client: 'componion', model: res.model ?? DEFAULT_MODEL, state: st, questions, answers: res.answers });
      return res;
    } };
    const result = await compact(region as never, asker as never, options);
    for (const d of result.decisions) heads.set(d.tool_use_id, HEAD[d.action as keyof typeof HEAD] ?? HEAD.drop_result);
    out.jev = 'jev';
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    $.ui.log(`overwatch compaction: jev failed: ${reason}`, { to: 'debug' });
    out.jev = `jev failed: ${reason.slice(0, 80)}`;
  }
  return heads;
}

/** Compaction's tools, declared through overwatch's catalog (catalog.ts) when compaction is on. */
export const COMPACTION_TOOLS: Record<string, ToolSpec> = {
  decompress: {
    description: 'Read back the full original of a message or tool result that was cut or folded out of the context. Pass the id from a "decompress id=…" marker or a fold index line (#toolu_… or fN.k).',
    properties: { id: { type: 'string' } },
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
  limits: Limits; liveMax: number; foldFrom: number; growthTokens: number; cacheTtlMs: number; jevOptions: object;
  saved: number; folds: number; failures: number; lastFold: number; jev: string; compacting: boolean; lastCompactAt: number; foldedRestart: boolean;
  idle?: { cancel: () => void }; state: State; grade: { jev: string }; fails: { tool: string; text: string }[];
};

function session(options: Record<string, unknown>): Session {
  const n = (k: string, d: number) => (typeof options[k] === 'number' ? (options[k] as number) : d);
  return {
    limits: { keepRecentTokens: n('keepRecentTokens', 6000), toolResultMaxChars: n('toolResultMaxChars', 2000), outcomeMaxChars: n('outcomeMaxChars', 120) },
    liveMax: n('liveResultMaxChars', 8000),
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
const status = (): Status => ({ saved: c.saved, folds: c.folds, lastFold: c.lastFold, jev: c.jev, compacting: c.compacting, failures: c.failures, nextCompactAt: c.lastCompactAt + c.growthTokens });

/** Minifies every tool result before the model reads it and stores the original. Called from the plugin's one unmatched tool.call hook. */
export async function compactToolCall($: EngineInterface, e: any, next: (e: any) => Promise<any>): Promise<any> {
  const r = await next(e);
  if (r.deny !== undefined) return r;
  if (r.isError && !e.agentId) c.fails.push({ tool: e.tool, text: String(r.text ?? JSON.stringify(r.result)) });
  // overwatch's own tools print tables and originals meant to be read as-is (loadout, report, decompress).
  if (VERBATIM.has(e.tool) || e.tool.startsWith(TOOL_PREFIX) || r.isError || r.result === undefined) return r;
  try {
    const id = e.tool_use_id;
    const result = minifyDeep(r.result, c.liveMax, id);
    const before = JSON.stringify(r.result);
    const k = before.length - JSON.stringify(result).length;
    if (k <= 0) return r;
    c.saved += tokens(k);
    if (id) await keepOriginal($, c.state, id, typeof r.result === 'string' ? r.result : before);
    // The context hooks below attached must ride on: the engine skips a hook that drops it.
    return { result, ...(r.context ? { context: r.context } : {}) };
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
async function decompress($: EngineInterface, e: { id?: unknown }) {
  const id = String(e.id ?? '').replace(/^#/, '');
  const home = await dir($, c.state);
  // Exact id: a suffix match would read f11.1 back for f1.1.
  const read = async (x: string, ext: string) => (/^[\w.-]+$/.test(x) ? $.fs.read(`${home}/${x}.${ext}`).catch(() => undefined) : undefined);
  // A fold's short id for a call is a .ref naming its toolu original.
  const ref = await read(id, 'ref');
  const text = await read(ref?.trim() ?? id, 'txt');
  return text !== undefined ? { result: plainShell(text) } : { result: `no original stored for ${id}`, isError: true as const };
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

/** Compaction's own hooks. Off (the A/B baseline) it registers nothing; overwatch.ts then skips the two handlers above. */
export const register: Register = (on, options) => {
  c = session(options);
  if (!compactionEnabled(options)) return;

  on('tool.call', { tool: `${TOOL_PREFIX}decompress` }, async ($, e) => decompress($, e as any));
  on('tool.call', { tool: `${TOOL_PREFIX}search_context` }, async ($, e) => searchContext($, e as any));

  on('session.compact', async ($, e, next) => {
    const main = !e.agentId;
    if (main) c.foldedRestart = false;
    const n = frozenEnd(e.messages);
    const probe = fold(e.messages, c.limits.keepRecentTokens, new Map(), n);
    const region = probe ? e.messages.slice(n, e.messages.length - (probe.length - n - 1)) : [];
    // Originals first: every folded message stays readable by its id.
    const ids = lineIds(region, n);
    for (const m of region) {
      if (m.text.length > 240) void keepOriginal($, c.state, ids.get(m)!, m.text);
      for (const u of m.toolUses) if (u.text) {
        void keepOriginal($, c.state, u.tool_use_id, u.text);
        void keepOriginal($, c.state, ids.get(u)!, u.tool_use_id, 'ref');
      }
      for (const r of m.toolResults ?? []) void keepOriginal($, c.state, r.tool_use_id, r.text);
    }
    const folded = fold(e.messages, c.limits.keepRecentTokens, await jevHeads($, region, c.jevOptions, c.grade), n);
    if (folded) {
      const k = Math.max(0, tokens(chars(e.messages) - chars(folded)));
      if (main) { c.saved += k; c.lastFold = k; c.folds++; c.foldedRestart = true; c.jev = `F${n}: ${region.length} msgs folded · ${c.grade.jev}`; void publish($, status()); }
      return { messages: folded };
    }
    if (e.trigger === 'plugin') {
      $.ui.log(`overwatch compaction: no fold: frozen ${n}, of ${e.messages.length}: ${e.messages.map((m) => `${m.role[0]}${m.toolUses.length ? 't' : ''}${m.toolResults?.length ? 'r' : ''}${Math.round(chars([m]) / 400)}`).join(' ')}`, { to: 'debug' });
      return { skip: 'nothing to fold yet' };
    }
    // `/compact` or the engine's threshold with nothing foldable: the built-in summary over a slimmed transcript.
    const instructions = [e.instructions, SUMMARY_TEMPLATE, fileLists(e.messages)].filter(Boolean).join('\n\n');
    const r = await next({ ...e, messages: slim(e.messages, c.limits), instructions });
    if (r.messages && main) c.saved += Math.max(0, tokens(chars(e.messages) - chars(r.messages)));
    return r;
  });

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
