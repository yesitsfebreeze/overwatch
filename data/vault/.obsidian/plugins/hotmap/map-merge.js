// Merge the program maps a build writes into one codebase map.
//
// .mosaic/map/<program>/index.json is per program, and the compiler and its cmd entry reach
// different parts of src/. The viewer and Jev both want one graph, so this is the single merge:
// one node per declaration (package + name + position), calls unioned and every index remapped.
// CommonJS because the Obsidian plugin, query.mjs and jev-eval all load it.
'use strict';
const fs = require('fs');
const path = require('path');

const CODEBASE = 'codebase';
const SRC_MAP = /^src-/;

// One declaration across programs: package + name + file + its ordinal among same-named
// declarations in that file (by line). Not the line itself: maps written at different source
// revisions see a declaration at shifted lines, and keying on the line split one procedure into
// several nodes with split callers and test reach. Ceiling: adding or removing a same-named
// declaration (a local procedure) above another one in the file still mismatches until both
// maps are rebuilt.
const KEY_VERSION = 2;
function declKeys(doc) {
  const symbols = doc.symbols || [];
  const base = s => [s.package, s.name, s.span && s.span.file].join('\0');
  const groups = new Map();
  symbols.forEach((s, i) => { const k = base(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
  const keys = new Array(symbols.length);
  for (const [k, list] of groups) {
    list.sort((a, b) => ((symbols[a].span && symbols[a].span.line) || 0) - ((symbols[b].span && symbols[b].span.line) || 0) || a - b);
    list.forEach((i, n) => { keys[i] = `${k}\0${n}`; });
  }
  return keys;
}
// `tests` is the id list the compiler emits, or its count in a slimmed index.
const testCount = t => (Array.isArray(t) ? t.length : t || 0);

function mergeDocs(docs, program = CODEBASE) {
  const symbols = [], at = new Map(), packages = new Map();
  for (const doc of docs) {
    for (const p of doc.packages || []) if (!packages.has(p.path)) packages.set(p.path, p);
    const keys = declKeys(doc);
    const remap = (doc.symbols || []).map((s, n) => {
      const key = keys[n];
      let i = at.get(key);
      if (i === undefined) { i = symbols.length; at.set(key, i); symbols.push({ ...s, calls: [] }); }
      else { const kept = symbols[i]; kept.external = Math.max(kept.external || 0, s.external || 0); if (testCount(s.tests) > testCount(kept.tests)) kept.tests = s.tests; }
      return i;
    });
    doc.symbols.forEach((s, i) => { const into = symbols[remap[i]]; for (const c of s.calls || []) into.calls.push(remap[c]); });
  }
  symbols.forEach((s, i) => { s.id = i; s.calls = [...new Set(s.calls)].sort((a, b) => a - b); });
  return { version: 1, program, command: 'merge', packages: [...packages.values()], symbols };
}

// Read the maps under `maps`, keeping names `match` accepts, in name order so the merge is
// deterministic for identical builds.
function srcDocs(maps, match = SRC_MAP) {
  if (!fs.existsSync(maps)) return [];
  return fs.readdirSync(maps)
    .filter(d => match.test(d) && fs.existsSync(path.join(maps, d, 'index.json')))
    .sort()
    .map(d => JSON.parse(fs.readFileSync(path.join(maps, d, 'index.json'), 'utf8')));
}

// A JSON value kept in <maps>/../cache/hotmap/<name> while `signature` holds; `build()` makes it
// otherwise. A cache that cannot be read or written only costs the rebuild.
function cached(maps, name, signature, build) {
  const file = path.join(maps, '..', 'cache', 'hotmap', name);
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.signature === signature && 'value' in c) return c.value; } catch { /* missing or stale: rebuild */ }
  const value = build();
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ signature, value })); } catch { /* the cache only saves time */ }
  return value;
}

// Test reach recorded by the maps `match` rejects (dev/tests programs, examples, scripts):
// declaration key -> the most @test procedures any of them saw reach it. Their tests exercise
// src procedures too, but their own symbols stay out of the codebase graph. Reading them all is
// about 0.5 GB, so the reach is cached in .mosaic/cache/hotmap/test-reach.json and rebuilt when
// any map's mtime or size changes.
function testReach(maps, match = SRC_MAP) {
  const names = fs.existsSync(maps) ? fs.readdirSync(maps).filter(d => !match.test(d)).sort() : [];
  const stamp = [];
  for (const d of names) {
    try { const st = fs.statSync(path.join(maps, d, 'index.json')); stamp.push([d, st.mtimeMs, st.size]); } catch { /* no map in this directory */ }
  }
  return new Map(cached(maps, 'test-reach.json', JSON.stringify([KEY_VERSION, stamp]), () => {
    const reach = new Map();
    for (const [d] of stamp) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(maps, d, 'index.json'), 'utf8')); } catch { continue; } // a map being written
      const keys = declKeys(doc);
      (doc.symbols || []).forEach((s, n) => {
        const t = testCount(s.tests);
        if (t) reach.set(keys[n], Math.max(reach.get(keys[n]) || 0, t));
      });
    }
    return [...reach];
  }));
}

// The codebase map: the maps `match` accepts (src-* by default) merged, with test reach from the
// rest credited, so the viewer, query.mjs and Jev (which merges every map) agree on tests. Each
// procedure with a near clone also gets `similar` and `twin` (similar.js), read from the sources
// under `repo` (default: the checkout `maps` sits in as <repo>/.mosaic/map).
function mergeMaps(maps, match = SRC_MAP, repo = path.resolve(maps, '..', '..')) {
  const doc = mergeDocs(srcDocs(maps, match));
  const reach = testReach(maps, match);
  const keys = declKeys(doc);
  doc.symbols.forEach((s, n) => { const t = reach.get(keys[n]) || 0; if (t > testCount(s.tests)) s.tests = t; });
  return require('./similar.js').annotate(doc, repo, undefined, (name, signature, build) => cached(maps, name, signature, build));
}

function mergeSrc(repo, match = SRC_MAP) {
  return mergeMaps(path.join(repo, '.mosaic', 'map'), match, repo);
}

module.exports = { CODEBASE, SRC_MAP, mergeDocs, srcDocs, testReach, mergeMaps, mergeSrc };
