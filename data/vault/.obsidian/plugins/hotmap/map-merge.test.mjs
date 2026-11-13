// Maps written at different source revisions must merge one declaration into one node.
// Run: node dev/tools/hotmap/map-merge.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const M = createRequire(import.meta.url)('./map-merge.js');
const sym = (id, name, line, calls = [], tests = 0, file = 'core/os/a.mi') =>
  ({ id, kind: 'procedure', package: 'os', name, span: { file, line }, calls, tests });

// An older map saw `f` at line 10, a newer one at line 14 after an edit above it.
const older = { symbols: [sym(0, 'f', 10), sym(1, 'g', 20, [0])] };
const newer = { symbols: [sym(0, 'f', 14), sym(1, 'h', 30, [0])] };
let doc = M.mergeDocs([older, newer]);
assert.equal(doc.symbols.filter(s => s.name === 'f').length, 1, 'a moved declaration is one node');
const f = doc.symbols.find(s => s.name === 'f').id;
assert.deepEqual(doc.symbols.filter(s => s.calls.includes(f)).map(s => s.name).sort(), ['g', 'h'], 'callers from both maps reach it');

// Two same-named declarations in one file (local procedures) stay two nodes, by order.
const locals = { symbols: [sym(0, 'less', 5), sym(1, 'less', 40)] };
const shifted = { symbols: [sym(0, 'less', 7), sym(1, 'less', 42)] };
doc = M.mergeDocs([locals, shifted]);
assert.deepEqual(doc.symbols.filter(s => s.name === 'less').map(s => s.span.line), [5, 40], 'same-named locals keep their order and identity');

// Test reach from a test map written before the shift still credits the moved declaration.
const dir = mkdtempSync(path.join(os.tmpdir(), 'map-merge-'));
try {
  const maps = path.join(dir, '.mosaic', 'map');
  const put = (name, d) => { mkdirSync(path.join(maps, name), { recursive: true }); writeFileSync(path.join(maps, name, 'index.json'), JSON.stringify(d)); };
  put('src-app', newer);
  put('dev-tests-old', { symbols: [sym(0, 'f', 10, [], 3)] });
  doc = M.mergeMaps(maps);
  assert.equal(doc.symbols.find(s => s.name === 'f').tests, 3, 'an older test map credits the moved declaration');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('PASS map-merge: moved declarations merge, same-named locals stay apart, old test reach credits');
