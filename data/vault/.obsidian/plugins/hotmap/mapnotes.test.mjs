// Self-check for mapnotes.js: a two-package fixture must yield one dashboard, one note per
// package, one note per hot procedure, and Dataview blocks that name the generated folder.
// Run: node ".overwatch/vault/.obsidian/plugins/hotmap/mapnotes.test.mjs"
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MapNotes = require('./mapnotes.js');
const G = require(path.join(here, 'graph-core.js'));

const doc = {
  packages: [{ path: 'src/app', name: 'app' }, { path: 'src/lib', name: 'lib' }],
  symbols: [
    { id: 1, name: 'main', package: 'app', kind: 'procedure', span: { file: 'src/app/main.mi', line: 3 }, calls: [2], tests: [] },
    { id: 2, name: 'append', package: 'lib', kind: 'procedure', span: { file: 'src/lib/list.mi', line: 9 }, calls: [], tests: [5, 6] },
    { id: 3, name: 'helper', package: 'lib', kind: 'procedure', span: { file: 'src/lib/list.mi', line: 20 }, calls: [2], tests: [] },
    { id: 5, name: 'main_test', package: 'app', kind: 'procedure', span: { file: 'src/app/main.mi', line: 30 }, calls: [1], tests: [] },
    { id: 6, name: 'append_test', package: 'lib', kind: 'procedure', span: { file: 'src/lib/list.mi', line: 40 }, calls: [2], tests: [] },
  ],
};

const built = MapNotes.build('app', doc, G, { top: 2, now: '2026-01-01T00:00:00.000Z' });
const byPath = new Map(built.files.map(f => [f.path, f.text]));
const base = '01 Specs/10 Tooling and Protocols/Codebase Map/app';

assert.equal(built.files.length, 1 + 2 + 2, 'dashboard + 2 packages + 2 hot procedures');
assert.ok(byPath.has(`${base}/Hotmap.md`), 'dashboard at the program folder');
assert.ok(byPath.has(`${base}/packages/app.md`), 'package note');
assert.ok(byPath.has(`${base}/procedures/lib.append.md`), 'hot procedure note');
assert.ok(!byPath.has(`${base}/procedures/app.main_test.md`), 'top N only');

const dash = byPath.get(`${base}/Hotmap.md`);
assert.match(dash, /```dataview/, 'dashboard has a dataview block');
assert.match(dash, /type = "hotmap-procedure"/, 'procedure query');
assert.match(dash, new RegExp(`FROM "${base}"`), 'queries the generated folder');

const proc = byPath.get(`${base}/procedures/lib.append.md`);
assert.match(proc, /^---\ntype: hotmap-procedure\n/, 'frontmatter type first');
assert.match(proc, /procedure: "append"/, 'procedure name');
assert.match(proc, /callers: 3/, 'three callers');
assert.match(proc, /tests: 2/, 'test count');

const pkg = byPath.get(`${base}/packages/lib.md`);
assert.match(pkg, /in_calls: 1/, 'cross-package calls in');
assert.match(pkg, /dependents: 1/, 'one package uses it');
assert.deepEqual(built.manifest.paths, built.files.map(f => f.path), 'manifest lists every note');

const ov = MapNotes.overview(MapNotes.FOLDER, '2026-01-01T00:00:00.000Z');
assert.equal(ov.path, '01 Specs/10 Tooling and Protocols/Codebase Map/Hotmap.md', 'overview at the folder root');
assert.match(ov.text, /type = "hotmap-dashboard"/, 'overview lists programs');
assert.match(ov.text, /type = "hotmap-procedure"/, 'overview lists procedures');
console.log('mapnotes: ok');
