// Near-clone detection over procedure bodies, for the hotmap similarity metric and filter.
//
// A body is the lines after a procedure's header that are indented deeper than it (Mosaic suites;
// a braced body ends at its closing brace, which sits at the header's indent). It is tokenized
// with comments and whitespace dropped and local names and numbers collapsed to one placeholder
// each (renamed copies still match); keywords, operators, string literals, called names and field
// names stay literal, so bodies that differ only in what they call or say do not count as copies. Two bodies are compared
// as sets of K-token shingles (Jaccard). Identical token strings score 1 directly; the rest go
// through MinHash with LSH banding, so only candidate pairs get an exact Jaccard. Ceiling: a
// bucket of many near-identical bodies is compared pairwise; fine for one codebase, cap the
// bucket for much larger inputs.
// CommonJS because map-merge.js (viewer, query.mjs, Jev) loads it.
'use strict';
const fs = require('fs');
const path = require('path');

// Keywords stay literal so control flow shapes the shingles. Not the lexer's table: an omission
// only makes that word a placeholder, which loosens a match, never breaks one.
const KEYWORDS = new Set(['proc', 'if', 'else', 'for', 'in', 'not_in', 'when', 'return', 'defer', 'switch', 'case',
  'break', 'continue', 'fallthrough', 'do', 'struct', 'enum', 'union', 'bit_set', 'map', 'distinct', 'using',
  'context', 'cast', 'transmute', 'auto_cast', 'or_return', 'or_else', 'or_break', 'or_continue', 'nil', 'true',
  'false', 'where', 'import', 'foreign', 'dynamic', 'matrix', 'len', 'cap', 'size_of', 'make', 'delete', 'append']);
const TOKEN = /#[^\n]*|"(?:\\.|[^"\\\n])*"|`[^`]*`|'(?:\\.|[^'\\\n])*'|[A-Za-z_][A-Za-z0-9_]*|\d\w*(?:\.\d\w*)?|:=|::|->|\.\.[<=]?|[<>=!:+\-*/%&|^~]=|&&|\|\||<<|>>|[^\s\w]/g;

function tokens(text) {
  const raw = [];
  for (const [t] of String(text).matchAll(TOKEN)) if (t[0] !== '#') raw.push(t);
  return raw.map((t, i) => {
    const c = t[0];
    if (c >= '0' && c <= '9') return 'n';
    if (!/[A-Za-z_]/.test(c) || KEYWORDS.has(t)) return t;
    return raw[i + 1] === '(' || raw[i - 1] === '.' ? t : 'i';
  });
}

// Indent as a column: a tab counts 4, a space 1, so tab and space files both compare correctly.
const indentOf = line => { let c = 0; for (const ch of /^[\t ]*/.exec(line)[0]) c += ch === '\t' ? 4 : 1; return c; };

// Bracket depth change of one line, strings and comments ignored.
function depthOf(line) {
  let d = 0;
  for (const [t] of line.matchAll(TOKEN)) { if (t === '(' || t === '[') d++; else if (t === ')' || t === ']') d--; }
  return d;
}

// The header line of procedure `name` near 1-based `line`: a map written before the source last
// moved points a few lines off, so look outward for `proc <name>`, else keep `line`.
function headerLine(lines, line, name) {
  if (!name) return line;
  const re = new RegExp(`\\bproc\\s+${name.replace(/[^\w]/g, '\\$&')}\\b`);
  for (let d = 0; d <= 60; d++) for (const i of d ? [line - 1 - d, line - 1 + d] : [line - 1]) if (lines[i] != null && re.test(lines[i])) return i + 1;
  return line;
}

// Body text of the declaration whose header is on 1-based `line`; '' when there is none. A nested
// procedure is its own declaration, so its header and body are left out of the enclosing one.
function bodyAt(lines, line) {
  const head = lines[line - 1];
  if (head == null) return '';
  const base = indentOf(head), body = [];
  // A header whose parameters wrap over several lines ends where its brackets close.
  let start = line, open = depthOf(head);
  while (open > 0 && start < lines.length) open += depthOf(lines[start++]);
  let nested = -1;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const at = indentOf(l);
    if (at <= base) break;
    if (nested >= 0 && at > nested) continue;
    nested = /^\s*proc\b/.test(l) ? at : -1;
    if (nested < 0) body.push(l);
  }
  return body.join('\n');
}

// 32-bit FNV-1a, then a murmur finalizer per MinHash seed.
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function mix(h, seed) { h ^= seed; h = Math.imul(h ^ (h >>> 16), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; }

function shingles(toks, k) {
  const set = new Set();
  if (toks.length < k) { if (toks.length) set.add(fnv(toks.join(' '))); return set; }
  for (let i = 0; i + k <= toks.length; i++) set.add(fnv(toks.slice(i, i + k).join(' ')));
  return set;
}
function jaccard(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let both = 0; for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

// items: [{ id, tokens }]. Returns Map id -> { score, twin } for every item with a match scoring at
// least opts.min (default 0.5); score is the best Jaccard, twin the id it was reached with.
// opts: k (shingle length, 5), minTokens (shorter bodies are skipped, 24), bands × rows MinHash.
function similar(items, opts) {
  const o = Object.assign({ k: 5, minTokens: 24, min: 0.5, bands: 16, rows: 4 }, opts);
  const best = new Map();
  const offer = (a, b, score) => {
    if (score < o.min) return;
    const pa = best.get(a); if (!pa || score > pa.score) best.set(a, { score, twin: b });
    const pb = best.get(b); if (!pb || score > pb.score) best.set(b, { score, twin: a });
  };
  // Identical token strings: one representative goes on to LSH, the rest score 1 against it.
  const exact = new Map();
  for (const it of items) {
    if (it.tokens.length < o.minTokens) continue;
    const key = it.tokens.join(' ');
    if (!exact.has(key)) exact.set(key, { tokens: it.tokens, ids: [] });
    exact.get(key).ids.push(it.id);
  }
  const reps = [];
  for (const { tokens: t, ids } of exact.values()) {
    for (let i = 1; i < ids.length; i++) offer(ids[0], ids[i], 1);
    reps.push({ ids, set: shingles(t, o.k) });
  }
  const n = o.bands * o.rows, seeds = Array.from({ length: n }, (_, i) => mix(i + 1, 0x9e3779b9));
  const buckets = new Map();
  reps.forEach((r, ri) => {
    const sig = new Uint32Array(n).fill(0xffffffff);
    for (const x of r.set) for (let i = 0; i < n; i++) { const h = mix(x, seeds[i]); if (h < sig[i]) sig[i] = h; }
    for (let b = 0; b < o.bands; b++) {
      const key = b + ':' + Array.prototype.join.call(sig.subarray(b * o.rows, (b + 1) * o.rows), ',');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(ri);
    }
  });
  const seen = new Set();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], pair = a < b ? a * reps.length + b : b * reps.length + a;
      if (seen.has(pair)) continue; seen.add(pair);
      // Equal shingle sets of different token strings are close, not identical: 1 stays exact-only.
      const s = Math.min(0.999, jaccard(reps[a].set, reps[b].set));
      // A representative's score passes on to every identical copy it stands for.
      for (const x of reps[a].ids) for (const y of reps[b].ids) offer(x, y, s);
    }
  }
  return best;
}

// Give every procedure in a map document `similar` (0..1) and `twin` (the id of its closest
// match) when it has a near clone. Sources are read from `repo` by span.file; a missing file only
// leaves its procedures without a score. The scores take seconds, so `cache(name, signature, build)`
// (map-merge's `cached`) keeps them under similar.json, keyed on the procedures and every source
// file's mtime and size; without one they are computed each time.
const CACHE_VERSION = 1;
function annotate(doc, repo, opts, cache = (name, signature, build) => build()) {
  const procs = (doc.symbols || []).filter(s => s.kind === 'procedure' && s.span && s.span.file);
  const stamp = new Map();
  for (const s of procs) if (!stamp.has(s.span.file)) { try { const st = fs.statSync(path.join(repo, s.span.file)); stamp.set(s.span.file, [st.mtimeMs, st.size]); } catch { stamp.set(s.span.file, null); } }
  const signature = fnv(JSON.stringify([CACHE_VERSION, opts || null, procs.map(s => [s.id, s.name, s.span.file, s.span.line]), [...stamp]])).toString(16);
  const rows = cache('similar.json', signature, () => [...scan(procs, repo, opts)].map(([id, f]) => [id, f.score, f.twin]));
  const found = new Map(rows.map(([id, score, twin]) => [id, { score, twin }]));
  for (const s of doc.symbols || []) {
    const f = found.get(s.id);
    if (f) { s.similar = Math.round(f.score * 1000) / 1000; s.twin = f.twin; }
  }
  return doc;
}

function scan(procs, repo, opts) {
  const files = new Map(), items = [];
  const linesOf = f => {
    if (!files.has(f)) { let t = null; try { t = fs.readFileSync(path.join(repo, f), 'utf8').split(/\r?\n/); } catch { /* moved or deleted since the build */ } files.set(f, t); }
    return files.get(f);
  };
  for (const s of procs) {
    const line = s.span.line ?? s.span.start?.line; // graph-core's lineOf; this file stays free of it
    const lines = line && linesOf(s.span.file);
    if (lines) items.push({ id: s.id, tokens: tokens(bodyAt(lines, headerLine(lines, line, s.name))) });
  }
  return similar(items, opts);
}

module.exports = { tokens, headerLine, bodyAt, shingles, jaccard, similar, annotate };
