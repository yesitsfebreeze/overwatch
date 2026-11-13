// Near-clone scoring and the list order it feeds. Run: node dev/tools/hotmap/similar.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('./similar.js');
const G = require('./graph-core.js');

// Locals and numbers collapse, calls, fields, strings and keywords stay; comments drop.
assert.deepEqual(S.tokens('x := foo(a.len, 3) # note\nreturn "s"'), ['i', ':=', 'foo', '(', 'i', '.', 'len', ',', 'n', ')', 'return', '"s"']);

// The body is the deeper-indented lines; a nested procedure is left out; a stale line is re-anchored.
const src = [
  'proc outer(a: int) -> int',
  '\tproc inner() -> int',
  '\t\treturn 99',
  '\tb := a + 1',
  '',
  '\treturn b',
  'proc next()',
].join('\n').split('\n');
assert.equal(S.bodyAt(src, 1), '\tb := a + 1\n\treturn b');
assert.equal(S.headerLine(src, 4, 'outer'), 1, 'a map line a few lines off finds the header by name');
const wrapped = ['proc long(', '\ta: int,', '\tb: int,', ') -> int', '\treturn a + b', 'proc next()'];
assert.equal(S.bodyAt(wrapped, 1), '\treturn a + b', 'a wrapped parameter list is header, not body');
assert.equal(S.bodyAt(['  proc two()', '    x := 1', '  proc next()'], 1), '    x := 1', 'space indents compare by column');
assert.deepEqual(S.tokens('0..<n'), ['n', '..<', 'i'], 'a literal bound keeps the range operator whole');
assert.deepEqual(S.tokens('1.5 + x'), ['n', '+', 'i']);

// A renamed copy scores 1, a body that calls something else scores lower, a different body not at all.
const body = v => `${v} := make_thing(ctx.size)\nif ${v} == nil\n\treturn false\nfor e in ${v}.items\n\tvisit(e, ctx.depth + 1)\nfinish(${v})\nreturn true`;
const items = [
  { id: 0, tokens: S.tokens(body('a')) },
  { id: 1, tokens: S.tokens(body('renamed')) },
  { id: 2, tokens: S.tokens(body('a').replace('finish', 'cleanup')) },
  { id: 3, tokens: S.tokens('total := 0\nfor x in values\n\ttotal += x * weight(x)\nif total > limit\n\tlog("over")\nreturn total') },
];
const found = S.similar(items, { minTokens: 10 });
assert.equal(found.get(0).score, 1);
assert.ok(found.get(2).score < 1 && found.get(2).score >= 0.5, `a one-call change is near: ${found.get(2) && found.get(2).score}`);
assert.ok(!found.has(3), 'an unrelated body has no twin');

// Tests rank more-tested first; the similarity filter keeps clones and puts each beside its twin.
const sym = (id, name, tests, similar, twin, calls = []) => ({ id, kind: 'procedure', package: 'p', name, tests, similar, twin, calls });
const graph = G.build({ packages: [{ name: 'p', path: 'p' }, { name: 'q', path: 'q' }], symbols: [
  sym(0, 'a', 0, 0.9, 3, [1, 2]), sym(1, 'b', 5, 0, null), sym(2, 'c', 2, 0.95, 4), sym(3, 'd', 1, 0.9, 0), sym(4, 'e', 9, 0.95, 2)] });
G.stats(graph);
assert.deepEqual(G.list('procs', graph.nodes, { sort: 'tests' }).map(r => r.label), ['p.e', 'p.b', 'p.c', 'p.d', 'p.a'], 'best first is most tests first');
assert.deepEqual(G.list('procs', graph.nodes, { sort: 'tests', minSimilar: 0.9 }).map(r => r.label), ['p.e', 'p.c', 'p.d', 'p.a'], 'clone pairs side by side');
assert.deepEqual(G.list('procs', graph.nodes, { sort: 'tests', minSimilar: 0.95 }).map(r => r.label), ['p.e', 'p.c']);
assert.deepEqual(G.order(graph.nodes, { sorts: ['tests'], minSimilar: 0.9 }).map(G.qualified), ['p.e', 'p.c', 'p.d', 'p.a'], 'panel and cube order agree with list');
assert.deepEqual(G.order(graph.nodes, { sorts: ['tests'], desc: false }).map(G.qualified), ['p.a', 'p.d', 'p.c', 'p.b', 'p.e']);
console.log('PASS similar: tokens, bodies, clone scores, tests order, clone grouping');
