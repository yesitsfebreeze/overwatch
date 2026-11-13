// Write the codebase into the spec vault as linked notes: one note per source file under
// `<vault>/code/<path>.md` (e.g. code/src/compiler/check/expr.mi.md), one heading per procedure
// with its calls and callers as wikilinks, so Obsidian's graph, backlinks and agents can follow
// the code the way the call graph does.
//
// Each note ends with a kept section: everything from the KEEP marker line down is the reader's
// and is carried over verbatim when the notes are regenerated. A note whose source file is gone
// is deleted only when its kept section is still the untouched default; otherwise it stays.
// Unchanged notes are not rewritten, so the tracked folder only changes where the code did.
//
// Usage: node codenotes.js [--repo DIR] [--vault DIR]   (default: the checkout this vault sits in,
// and <repo>/.overwatch/vault)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = 'code';
const KEEP = '%% hotmap: everything below this line is kept when the code notes are regenerated %%';
const DEFAULT_KEPT = `${KEEP}\n## Notes\n`;
const MAX_CALLERS = 25, MAX_CALLEES = 40;

const notePath = file => `${ROOT}/${file}.md`;

// Heading text per node of one file, `nodes` in line order: the name, and `name (2)`, `name (3)` for
// later same-named declarations (local procedures), so a heading keeps its meaning across edits.
function headings(nodes, into) {
  const seen = new Map();
  for (const n of nodes) {
    const base = n.name || '(anonymous)', k = (seen.get(base) || 0) + 1;
    seen.set(base, k);
    into.set(n, k === 1 ? base : `${base} (${k})`);
  }
}

// Note texts for a built graph: Map relative path -> generated text up to (not including) the kept
// section. G is graph-core; the graph's nodes need `rank` (G.stats fills it). `exists(file)` drops
// files a stale map still names after the source moved (default: keep every file). `specs` (from
// specIndex) links each file note to the spec units whose `paths` cover the file, so every spec gets
// its code as backlinks.
function build(graph, G, exists = () => true, specs = []) {
  const byFile = new Map();
  for (const n of graph.nodes) {
    const f = n.span && n.span.file; if (!f) continue;
    if (!byFile.has(f)) { if (!exists(f)) { byFile.set(f, null); continue; } byFile.set(f, []); }
    const list = byFile.get(f); if (list) list.push(n);
  }
  for (const [f, list] of byFile) if (!list) byFile.delete(f);
  const line = n => G.lineOf(n.span) || 0, heading = new Map();
  for (const nodes of byFile.values()) { nodes.sort((a, b) => line(a) - line(b) || a.id - b.id); headings(nodes, heading); }
  const link = (n, from) => {
    const f = n.span.file, h = heading.get(n);
    return f === from ? `[[#${h}]]` : `[[${notePath(f)}#${h}|${G.qualified(n)}]]`;
  };
  const fileLink = f => `[[${notePath(f)}|${path.posix.basename(f)}]]`;
  const capped = (list, max, from) => {
    const shown = list.slice(0, max).map(n => link(n, from)).join(', ');
    return list.length > max ? `${shown}, … +${list.length - max} more` : shown;
  };
  const hot = G.METRICS.hot.get, byHot = list => G.order(list.filter(n => heading.has(n)), { sorts: ['hot'] });

  const notes = new Map(), packages = new Map();
  for (const [file, nodes] of [...byFile].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pkg = nodes[0].pkg;
    if (!packages.has(pkg)) packages.set(pkg, []);
    packages.get(pkg).push(file);
    const uses = new Set(), usedBy = new Set();
    for (const n of nodes) {
      for (const c of n.out) if (heading.has(c) && c.span.file !== file) uses.add(c.span.file);
      for (const c of n.in) if (heading.has(c) && c.span.file !== file) usedBy.add(c.span.file);
    }
    const lines = ['---', 'type: code-file', `source: "${file}"`, `package: "${pkg}"`, `procedures: ${nodes.length}`,
      `untested: ${nodes.filter(n => n.testCount === 0).length}`, 'tags: [code]', '---', '',
      `# ${path.posix.basename(file)}`, '', `Source \`${file}\` · package \`${pkg}\``, ''];
    if (uses.size) lines.push(`Uses: ${[...uses].sort().map(fileLink).join(', ')}`, '');
    if (usedBy.size) lines.push(`Used by: ${[...usedBy].sort().map(fileLink).join(', ')}`, '');
    const covering = specs.filter(s => covers(s.paths.filter(p => !broad(p)), file));
    if (covering.length) lines.push(`Specs: ${covering.map(s => `[[${s.note}|${s.name}]]${s.status ? ` (${s.status})` : ''}`).join(', ')}`, '');
    for (const n of nodes) {
      lines.push(`## ${heading.get(n)}`, '');
      const facts = [`\`${G.spanText(n.span)}\``, `hotness ${Math.round(hot(n))}`, `tests ${n.testCount}`];
      if (n.twin && heading.has(n.twin)) facts.push(`≈ ${Math.round(n.similar * 100)}% ${link(n.twin, file)}`);
      if (n.type) lines.push('`' + String(n.type).replace(/`/g, "'") + '`', '');
      lines.push(facts.join(' · '), '');
      const calls = byHot(n.out), callers = byHot(n.in);
      if (calls.length) lines.push(`- calls: ${capped(calls, MAX_CALLEES, file)}`);
      if (callers.length) lines.push(`- called by: ${capped(callers, MAX_CALLERS, file)}`);
      if (calls.length || callers.length) lines.push('');
    }
    notes.set(notePath(file), lines.join('\n'));
  }
  const index = ['---', 'type: code-index', 'tags: [code]', '---', '', '# Code', '',
    'One note per source file; each procedure is a heading with its calls and callers. Regenerate with',
    '`node dev/tools/hotmap/codenotes.js` (or the Hotmap command); the Notes section of every note is kept.', ''];
  const wide = specs.filter(s => s.paths.some(broad));
  if (wide.length) {
    index.push('## Specs across the tree', '', 'Specs whose paths name a whole tree (one or two path segments); file notes list only the narrower ones.', '');
    for (const s of wide) index.push(`- [[${s.note}|${s.name}]]${s.status ? ` (${s.status})` : ''}: ${s.paths.filter(broad).map(p => `\`${p}\``).join(', ')}`);
    index.push('');
  }
  for (const [pkg, files] of [...packages].sort((a, b) => a[0].localeCompare(b[0]))) index.push(`## ${pkg}`, '', files.map(f => `- ${fileLink(f)}`).join('\n'), '');
  notes.set(`${ROOT}/index.md`, index.join('\n'));
  return notes;
}

// A paths entry of one or two segments (`src`, `src/compiler`) names a whole tree: linking it from
// every file under it would bury the specs that name the file, so the index lists it instead.
const broad = p => p.replace(/\/+$/, '').split('/').length <= 2;

// A spec's `paths` entry covers a file when it names the file or a folder above it.
function covers(paths, file) {
  return paths.some(p => { const d = p.replace(/\/+$/, ''); return file === d || file.startsWith(d + '/'); });
}

// The spec units under <vault>/01 Specs: { note (vault path, no .md), name, status, paths } from
// each note's frontmatter; `paths` may be an inline list or a block list.
function specIndex(vault) {
  const specs = [];
  for (const abs of walk(path.join(vault, '01 Specs'))) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(abs, 'utf8'));
    if (!fm) continue;
    const inline = /^paths:\s*\[(.*)\]\s*$/m.exec(fm[1]), block = /^paths:\s*\r?\n((?:\s+-\s.*\r?\n?)+)/m.exec(fm[1]);
    const raw = inline ? inline[1].split(',') : block ? block[1].split(/\r?\n/).map(l => l.replace(/^\s+-\s/, '')) : [];
    const paths = raw.map(p => p.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    if (!paths.length) continue;
    const status = (/^status:\s*(.+)$/m.exec(fm[1]) || [])[1];
    const note = path.relative(vault, abs).split(path.sep).join('/').replace(/\.md$/, '');
    specs.push({ note, name: path.posix.basename(note), status: status && status.trim(), paths });
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}

// The kept section of an existing note text: from the KEEP line on, or the default.
function keptOf(text) {
  const at = text == null ? -1 : text.indexOf(KEEP);
  return at < 0 ? DEFAULT_KEPT : text.slice(at);
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Write the notes for the merged src-* codebase map of `repo` into `vault`.
// Returns { written, unchanged, deleted, kept } where kept lists notes left for a gone source file.
function write(repo, vault) {
  const G = require('./graph-core.js'), M = require('./map-merge.js');
  const doc = M.mergeSrc(repo);
  if (!doc.symbols.length) throw new Error('no src map under .mosaic/map; build the compiler first');
  const graph = G.build(doc, { kinds: new Set(['procedure']) });
  G.stats(graph);
  const notes = build(graph, G, f => fs.existsSync(path.join(repo, f)), specIndex(vault));
  const result = { written: 0, unchanged: 0, deleted: 0, kept: [] };
  for (const [rel, generated] of notes) {
    const abs = path.join(vault, rel);
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    const text = rel === `${ROOT}/index.md` ? generated : `${generated}\n${keptOf(old)}`;
    if (old === text) { result.unchanged++; continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    result.written++;
  }
  for (const abs of walk(path.join(vault, ROOT))) {
    const rel = path.relative(vault, abs).split(path.sep).join('/');
    if (notes.has(rel)) continue;
    if (keptOf(fs.readFileSync(abs, 'utf8')) === DEFAULT_KEPT) { fs.rmSync(abs); result.deleted++; }
    else result.kept.push(rel);
  }
  return result;
}

// The command line: `repo` defaults to the checkout around this plugin's vault
// (<repo>/.overwatch/vault/.obsidian/plugins/hotmap).
function main(args, repo = path.resolve(__dirname, '..', '..', '..', '..', '..')) {
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  repo = path.resolve(opt('--repo') || repo);
  const vault = path.resolve(opt('--vault') || path.join(repo, '.overwatch', 'vault'));
  const t0 = Date.now(), r = write(repo, vault);
  console.log(`code notes: ${r.written} written, ${r.unchanged} unchanged, ${r.deleted} deleted in ${Date.now() - t0} ms under ${path.join(vault, ROOT)}`);
  for (const k of r.kept) console.log(`kept (source gone, has notes): ${k}`);
}

module.exports = { ROOT, KEEP, DEFAULT_KEPT, notePath, headings, build, covers, specIndex, keptOf, write, main };

if (require.main === module) main(process.argv.slice(2));
