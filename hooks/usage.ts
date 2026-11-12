/** Provider-reported sidecar usage. Pure imports: ordinary Bun callers need no native runtime. */
import type { EngineInterface } from 'claude-code';
import { STATE_DIR, today, type Io } from './io.ts';

export const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
type Field = typeof USAGE_FIELDS[number];
export type ReturnedUsage = Record<Field, number | null>;
type Coverage = { total: number | null; reported: number; unknown: number };
export type UsageSnapshot = { v: 1; session: string; nextOperation: number; attempts: number; successes: number; failures: number; retries: 0; estimatedInputTokens: number; usage: Record<Field, Coverage> };
type Account = { value: UsageSnapshot; path?: string; queue: Promise<void> };
export type UsageOperation = { account: Account; operation: 'compaction' | 'guard'; operationId: string };
export type UsageOutcome = 'success' | 'http_error' | 'invalid_response' | 'transport_error';
const sessions = new Map<string, Promise<Account>>();
const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const empty = (session: string): UsageSnapshot => ({ v: 1, session, nextOperation: 0, attempts: 0, successes: 0, failures: 0, retries: 0, estimatedInputTokens: 0,
  usage: Object.fromEntries(USAGE_FIELDS.map((k) => [k, { total: null, reported: 0, unknown: 0 }])) as Record<Field, Coverage> });
const count = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
export const returnedUsage = (body: any): ReturnedUsage => Object.fromEntries(USAGE_FIELDS.map((k) => [k, count(body?.usage?.[k]) ? body.usage[k] : null])) as ReturnedUsage;

function restore(text: string, id: string): UsageSnapshot | undefined {
  try {
    const s = JSON.parse(text);
    if (s.v !== 1 || s.session !== id || !['nextOperation', 'attempts', 'successes', 'failures', 'estimatedInputTokens'].every((k) => count(s[k])) || !['nextOperation', 'attempts', 'successes', 'failures'].every((k) => Number.isSafeInteger(s[k]))) return undefined;
    if (!USAGE_FIELDS.every((k) => s.usage?.[k] && (s.usage[k].total === null || count(s.usage[k].total)) && count(s.usage[k].reported) && s.usage[k].reported <= s.attempts)) return undefined;
    s.retries = 0;
    for (const k of USAGE_FIELDS) s.usage[k].unknown = s.attempts - s.usage[k].reported;
    return s;
  } catch { return undefined; }
}

async function account($: EngineInterface): Promise<Account> {
  try {
    const [cwd, id] = await Promise.all([$.session.cwd(), $.session.id()]);
    const key = `${cwd}\0${id}`;
    let pending = sessions.get(key);
    if (!pending) {
      pending = (async () => {
        const path = `${cwd}/${STATE_DIR}/usage/${id}.json`;
        let text = '';
        try { text = await $.fs.read(path); } catch {}
        return { path, value: restore(text, id) ?? empty(id), queue: Promise.resolve() };
      })();
      sessions.set(key, pending);
    }
    return pending;
  } catch {
    return { value: empty('unknown'), queue: Promise.resolve() };
  }
}

/** Allocation happens synchronously after one shared initialization; register() never resets it. */
export async function usageOperation($: EngineInterface, operation: UsageOperation['operation']): Promise<UsageOperation> {
  const a = await account($);
  return { account: a, operation, operationId: `${operation}-${++a.value.nextOperation}-${generation}` };
}

async function persist($: EngineInterface, a: Account) {
  const text = JSON.stringify(a.value);
  a.queue = a.queue.catch(() => {}).then(async () => { if (a.path) await $.fs.write(a.path, text); }).catch(() => {});
  await a.queue;
}

async function append($: EngineInterface, entry: object) {
  try {
    const script = 'use File::Path; mkpath($ARGV[0]); open(F, ">>", "$ARGV[0]/$ARGV[1]") or die; local $/; syswrite(F, <STDIN>)';
    await $.process.run(['perl', '-e', script, `${await $.env.get('HOME')}/.jev/log`, `${today()}.jsonl`], { stdin: JSON.stringify(entry) + '\n' });
  } catch { /* observation cannot fail the user's operation */ }
}

/** One actual HTTP invocation. Capture usage before response/answer validation; never log raw errors. */
export async function observedRequest<T>($: EngineInterface, op: UsageOperation, batch: number, estimatedInputTokens: number,
  send: () => Promise<{ ok: boolean; status: number; text: string }>, validate: (body: any) => T,
  dataset?: { state: unknown; questions: unknown }): Promise<T> {
  const a = op.account;
  a.value.attempts++;
  a.value.estimatedInputTokens += estimatedInputTokens;
  for (const k of USAGE_FIELDS) a.value.usage[k].unknown++;
  let outcome: UsageOutcome = 'transport_error';
  let usage = returnedUsage(undefined), body: any, httpStatus: number | null = null;
  try {
    const pending = send();
    void persist($, a);
    const response = await pending;
    httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    try { body = JSON.parse(response.text); } catch {}
    usage = returnedUsage(body);
    outcome = response.ok ? 'invalid_response' : 'http_error';
    if (!response.ok) throw new Error(outcome);
    const result = validate(body);
    outcome = 'success';
    return result;
  } catch { throw new Error(outcome); }
  finally {
    if (outcome === 'success') a.value.successes++; else a.value.failures++;
    for (const k of USAGE_FIELDS) if (usage[k] !== null) {
      const field = a.value.usage[k];
      field.total = (field.total ?? 0) + usage[k]!; field.reported++; field.unknown--;
    }
    await persist($, a);
    await append($, { ts: Date.now(), client: dataset && outcome === 'success' ? 'componion' : 'overwatch', session: a.value.session, operation: op.operation, operationId: op.operationId,
      batch, attempt: 1, outcome, httpStatus, retries: 0, estimatedInputTokens, usage,
      ...(dataset && outcome === 'success' ? { ...dataset, model: typeof body?.model === 'string' ? body.model : 'jev-latest', answers: body.answers } : {}) });
  }
}

export async function usageSnapshot($: EngineInterface): Promise<UsageSnapshot> {
  return JSON.parse(JSON.stringify((await account($)).value));
}

/** Disk-backed report also works when compaction is disabled, or in the portable CLI. */
export async function usageReport(io: Io): Promise<string> {
  const dir = `${io.cwd}/${STATE_DIR}/usage`;
  const files = (await io.list(dir)).filter((f) => f.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)).slice(-10);
  const lines: string[] = [];
  for (const f of files) {
    const id = f.name.slice(0, -5), text = await io.read(`${dir}/${f.name}`).catch(() => undefined);
    const s = text ? restore(text, id) : undefined;
    if (!s) { lines.push(`${id}: usage unavailable (invalid or unreadable snapshot)`); continue; }
    lines.push(`${id}: ${s.attempts} sidecar requests (${s.successes} success, ${s.failures} failed); estimated input ${s.estimatedInputTokens}; ` + USAGE_FIELDS.map((k) => `${k} ${s.usage[k].total ?? 'unknown'} (${s.usage[k].reported}/${s.attempts} reported)`).join(', '));
  }
  return lines.length ? `Jev provider-reported usage (up to 10 session files; incomplete fields remain unknown):\n${lines.join('\n')}\nContext removed is an estimate, not billed savings.` : 'Jev usage: no recorded requests; provider usage unknown.';
}

/** Tests simulate a process reload while retaining its disk snapshot. */
export const resetUsage = () => sessions.clear();
