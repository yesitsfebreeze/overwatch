// Code notes: links resolve to headings, the kept Notes section survives regeneration, and a note
// for a gone source file is deleted only while its Notes section is untouched.
// Run: node dev/tools/hotmap/codenotes.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const C = require('./codenotes.js');
const G = require('./graph-core.js');

const sym = (id, name, file, line, calls = [], tests = 0, extra = {}) => ({ id, kind: 'procedure', package: 'p', name, span: { file, line }, calls, tests, ...extra });
const doc = () => ({ packages: [{ name: 'p', path: 'src/p' }, { name: 'q', path: 'src/q' }], symbols: [
  sym(0, 'main', 'src/p/a.mi', 1, [1, 2]),
  sym(1, 'helper', 'src/p/a.mi', 10, [3]),
  sym(2, 'helper', 'src/p/a.mi', 20, [], 2), // a same-named local procedure
  sym(3, 'leaf', 'src/p/b.mi', 5, [], 4, { similar: 0.9, twin: 1 }),
] });
const notes = () => { const g = G.build(doc(), null); G.stats(g); return C.build(g, G); };

// Every wikilink points at an existing note and, with an anchor, at a heading in it.
const n = notes();
const headingsOf = text => new Set([...text.matchAll(/^## (.+)$/gm)].map(m => m[1]));
for (const [rel, text] of n) {
  for (const [, target, anchor] of text.matchAll(/\[\[([^\]#|]*)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g)) {
    const note = target || rel;
    assert.ok(n.has(note), `${rel}: link to missing note ${note}`);
    if (anchor) assert.ok(headingsOf(n.get(note)).has(anchor), `${rel}: link to missing heading ${note}#${anchor}`);
  }
}
const a = n.get('code/src/p/a.mi.md');
assert.ok(headingsOf(a).has('helper') && headingsOf(a).has('helper (2)'), 'same-named locals get distinct headings');
assert.match(a, /Uses: \[\[code\/src\/p\/b\.mi\.md\|b\.mi\]\]/, 'file-level link to the file it calls into');
assert.match(n.get('code/src/p/b.mi.md'), /Used by: \[\[code\/src\/p\/a\.mi\.md\|a\.mi\]\]/, 'and the reverse');
assert.match(n.get('code/src/p/b.mi.md'), /≈ 90% \[\[code\/src\/p\/a\.mi\.md#helper\|p\.helper\]\]/, 'near clone linked');

// A file a stale map still names after the source moved gets no note and no links.
{
  const g = G.build(doc(), null); G.stats(g);
  const only = C.build(g, G, f => f !== 'src/p/b.mi');
  assert.ok(!only.has('code/src/p/b.mi.md') && !only.get('code/src/p/a.mi.md').includes('b.mi'), 'moved file dropped with its links');
}

// Specs link to the files their `paths` cover, by file or folder, never by a name prefix.
{
  assert.ok(C.covers(['src/p/'], 'src/p/a.mi') && C.covers(['src/p/a.mi'], 'src/p/a.mi') && !C.covers(['src/p/a'], 'src/p/a.mi'));
  const g = G.build(doc(), null); G.stats(g);
  const notes = C.build(g, G, undefined, [
    { note: '01 Specs/X/Unit', name: 'Unit', status: 'open', paths: ['src/p/b.mi'] },
    { note: '01 Specs/X/Wide', name: 'Wide', status: 'done', paths: ['src/p'] },
  ]);
  assert.match(notes.get('code/src/p/b.mi.md'), /^Specs: \[\[01 Specs\/X\/Unit\|Unit\]\] \(open\)$/m, 'a narrow spec links from its file');
  assert.ok(!notes.get('code/src/p/a.mi.md').includes('Specs:'), 'a tree-wide spec stays off file notes');
  assert.match(notes.get('code/index.md'), /^- \[\[01 Specs\/X\/Wide\|Wide\]\] \(done\): `src\/p`$/m, 'the index lists tree-wide specs');
  const vault = mkdtempSync(path.join(os.tmpdir(), 'codenotes-specs-'));
  try {
    mkdirSync(path.join(vault, '01 Specs', 'A'), { recursive: true });
    writeFileSync(path.join(vault, '01 Specs', 'A', 'Inline.md'), '---\nstatus: done\npaths: [src/p/, "dev/x.js"]\n---\nbody\n');
    writeFileSync(path.join(vault, '01 Specs', 'A', 'Block.md'), '---\npaths:\n  - src/q.mi\nstatus: open\n---\n');
    writeFileSync(path.join(vault, '01 Specs', 'A', 'None.md'), '---\nstatus: open\n---\n');
    assert.deepEqual(C.specIndex(vault), [
      { note: '01 Specs/A/Block', name: 'Block', status: 'open', paths: ['src/q.mi'] },
      { note: '01 Specs/A/Inline', name: 'Inline', status: 'done', paths: ['src/p/', 'dev/x.js'] },
    ]);
  } finally { rmSync(vault, { recursive: true, force: true }); }
}

// Regeneration keeps the Notes section; a gone file is deleted unless it has notes.
const repo = mkdtempSync(path.join(os.tmpdir(), 'codenotes-'));
try {
  const maps = path.join(repo, '.mosaic', 'map', 'src-app');
  mkdirSync(maps, { recursive: true });
  writeFileSync(path.join(maps, 'index.json'), JSON.stringify(doc()));
  mkdirSync(path.join(repo, 'src', 'p'), { recursive: true });
  for (const f of ['a.mi', 'b.mi']) writeFileSync(path.join(repo, 'src', 'p', f), '');
  const vault = path.join(repo, 'vault');
  let r = C.write(repo, vault);
  assert.equal(r.written, 3, 'a.mi, b.mi and the index');
  const aPath = path.join(vault, 'code/src/p/a.mi.md');
  writeFileSync(aPath, readFileSync(aPath, 'utf8') + 'helper (2) is the fast path.\n');
  const ghost = path.join(vault, 'code/src/p/gone.mi.md'), noted = path.join(vault, 'code/src/p/noted.mi.md');
  writeFileSync(ghost, `old\n${C.DEFAULT_KEPT}`);
  writeFileSync(noted, `old\n${C.DEFAULT_KEPT}keep me\n`);
  r = C.write(repo, vault);
  assert.equal(r.written, 0, 'a note edited only in its Notes section is not rewritten');
  assert.match(readFileSync(aPath, 'utf8'), /## Notes\nhelper \(2\) is the fast path\.\n$/, 'kept section survives');
  assert.ok(!existsSync(ghost) && r.deleted === 1, 'an untouched note for a gone file is deleted');
  assert.deepEqual(r.kept, ['code/src/p/noted.mi.md'], 'a note with notes for a gone file stays');
  r = C.write(repo, vault);
  assert.equal(r.written, 0, 'a second run changes nothing');
} finally {
  rmSync(repo, { recursive: true, force: true });
}
console.log('PASS codenotes: links resolve, locals distinct, notes kept, stale notes handled');
