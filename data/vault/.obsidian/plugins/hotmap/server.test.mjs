// Self-check for server.js: the page and the map are reachable over loopback, and the program
// segment cannot escape .mosaic/map. Needs a built map; skips (exit 0) when none exists.
// Run: node ".overwatch/vault/.obsidian/plugins/hotmap/server.test.mjs"
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { MapServer, repoRoot } = require('./server.js');

const repo = repoRoot(here);
assert.ok(repo, 'repo root found by walking up from the plugin');
const maps = path.join(repo, '.mosaic', 'map');
const program = fs.existsSync(maps)
  ? fs.readdirSync(maps).find(d => fs.existsSync(path.join(maps, d, 'index.json')))
  : null;
if (!program) { console.log('server: skipped, no .mosaic/map'); process.exit(0); }

const server = new MapServer(repo);
await server.ready;
try {
  const page = await fetch(server.url(program, 'cube'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const pageText = await page.text();
  assert.match(pageText, /Hotness Cube|<canvas id="cube">/);
  assert.match(pageText, /aside\{display:none/, 'cube mode hides the page sidebar');
  assert.match(pageText, /hotmap!=='select'/, 'pick/select bridge injected');
  assert.match(pageText, /#peelcol span\{display:none/, 'peel labels hidden');
  assert.match(pageText, /#peelcol\{border:0/, 'peel column border gone');

  // One merged codebase map: every src-* declaration once, call indices in range.
  const merged = await fetch(`http://127.0.0.1:${server.port}/codebase/index.json`);
  assert.equal(merged.status, 200);
  assert.match(merged.headers.get('content-type'), /application\/json/);
  const mergedDoc = JSON.parse(await merged.text());
  assert.equal(mergedDoc.program, 'codebase');
  const srcDirs = fs.readdirSync(maps).filter(d => /^src-/.test(d) && fs.existsSync(path.join(maps, d, 'index.json')));
  // map-merge's key: package + name + file + ordinal among same-named declarations in that file
  // (not the line, which shifts between maps written at different revisions).
  const most = new Map();
  for (const d of srcDirs) {
    const count = new Map();
    for (const s of JSON.parse(fs.readFileSync(path.join(maps, d, 'index.json'), 'utf8')).symbols) {
      const k = [s.package, s.name, s.span && s.span.file].join('\0');
      count.set(k, (count.get(k) || 0) + 1);
    }
    for (const [k, n] of count) most.set(k, Math.max(most.get(k) || 0, n));
  }
  let declarations = 0; for (const n of most.values()) declarations += n;
  assert.equal(mergedDoc.symbols.length, declarations, 'one node per declaration across every src map');
  assert.ok(mergedDoc.symbols.some(s => s.similar > 0 && s.twin >= 0), 'near clones carry a similarity and a twin');
  let bad = 0; for (const s of mergedDoc.symbols) for (const c of s.calls) if (!(c >= 0 && c < mergedDoc.symbols.length)) bad++;
  assert.equal(bad, 0, 'merged call indices stay in range');
  const perProgram = await fetch(`http://127.0.0.1:${server.port}/${program}/index.json`);
  assert.equal(perProgram.status, 404, 'per-program maps are build inputs, not viewer options');

  const core = await fetch(`http://127.0.0.1:${server.port}/${program}/graph-core.js`);
  assert.equal(core.status, 200);
  assert.match(await core.text(), /GraphCore/);

  const escape = await fetch(`http://127.0.0.1:${server.port}/..%2F..%2Fetc/index.json`);
  assert.ok(escape.status === 400 || escape.status === 404, 'no path escape, got ' + escape.status);
  const unknown = await fetch(`http://127.0.0.1:${server.port}/${program}/nope.js`);
  assert.equal(unknown.status, 404);

  // A theme callback restyles the served page without touching the file on disk.
  const themed = new MapServer(repo, { theme: () => ({ bg: '#202020', fg: '#dddddd' }) });
  await themed.ready;
  const themedPage = await (await fetch(themed.url(program))).text();
  const themedCube = await (await fetch(`http://127.0.0.1:${themed.port}/${program}/cube.js`)).text();
  themed.stop();
  assert.match(themedPage, /--bg:#202020/, 'theme vars injected');
  assert.match(themedPage, /<canvas id="cube">/, 'page still whole');
  assert.match(themedCube, /clearValue: \{ r: 0\.1255, g: 0\.1255, b: 0\.1255, a: 1 \}/, 'clear colour patched');
  assert.doesNotMatch(themedCube, /a: 0 \}/, 'no transparent clear left');

  const clearServer = new MapServer(repo, { theme: () => ({ bg: '#202020' }), transparent: () => true });
  await clearServer.ready;
  const clearJs = await (await fetch(`http://127.0.0.1:${clearServer.port}/${program}/cube.js`)).text();
  const clearHtml = await (await fetch(clearServer.url(program, 'cube'))).text();
  clearServer.stop();
  assert.match(clearJs, /a: 0 \}/, 'transparent mode leaves the clear alpha alone');
  assert.match(clearHtml, /background:transparent !important/, 'page paints no background');
} finally { server.stop(); }

console.log('server: ok (' + program + ')');
