// Dataview notes for Mosaic codebase maps (.mosaic/map/<program>/index.json).
// Pure data in, note texts out, so node checks it without Obsidian (mapnotes.test.mjs).
// One note per package and per hot procedure, a dashboard per program, and one overview across
// programs. Dataview queries those notes by their `type` frontmatter field.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MapNotes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FOLDER = '01 Specs/10 Tooling and Protocols/Codebase Map';

  // Frontmatter string values are JSON-quoted, which is valid YAML and survives every key.
  const q = v => JSON.stringify(String(v));
  const clean = s => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '_').replace(/\s+/g, ' ').trim() || 'unnamed';
  const front = fields => ['---', ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
  const num = v => (Number.isFinite(v) ? +v.toFixed(4) : 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // build(program, doc, GraphCore, opts) -> { folder, files: [{ path, text }], manifest }
  // opts: { now, top = 200, folder }. `path` is vault-relative; `manifest` lists every generated path.
  function build(program, doc, GraphCore, opts) {
    const o = Object.assign({ top: 200, folder: FOLDER, now: new Date().toISOString() }, opts || {});
    const graph = GraphCore.build(doc, { kinds: new Set(['procedure']) });
    const stats = GraphCore.stats(graph);            // also writes node.rank
    const groups = GraphCore.groups(graph, stats);
    const base = `${o.folder}/${clean(program)}`;
    const files = [];

    const hotness = n => GraphCore.METRICS.hot.get(n);
    const procsOf = p => p.members.slice().sort((a, b) => hotness(b) - hotness(a));
    const untested = p => p.members.filter(n => n.testCount === 0).length;
    const effects = n => (Array.isArray(n.effects) ? n.effects.join(', ') : (n.effects || ''));

    // Procedures that get a note: the hottest `top`, so the dashboards have something to query.
    const hottest = graph.nodes.slice().sort((a, b) => hotness(b) - hotness(a)).slice(0, o.top);
    const noted = new Set(hottest.map(n => GraphCore.qualified(n)));
    const notePath = n => `${base}/procedures/${clean(GraphCore.qualified(n))}.md`;
    const pkgPath = p => `${base}/packages/${clean(p.name)}.md`;

    for (const n of hottest) {
      const fields = {
        type: 'hotmap-procedure', program: q(program), generated: q(o.now),
        package: q(n.pkg), procedure: q(n.name), signature: q(n.type || ''), location: q(GraphCore.spanText(n.span)),
        hotness: num(hotness(n)), pagerank: num(n.rank || 0),
        callers: n.in.length, callees: n.out.length, tests: n.testCount, external_calls: n.external || 0,
        untested: n.testCount === 0,
      };
      const fx = effects(n);
      if (fx) fields.effects = q(fx);
      const callers = n.in.slice().sort((a, b) => hotness(b) - hotness(a));
      const callees = n.out.slice().sort((a, b) => hotness(b) - hotness(a));
      const line = list => list.length ? list.map(x => `- \`${GraphCore.qualified(x)}\` (${GraphCore.spanText(x.span)})`).join('\n') : '- none';
      files.push({ path: notePath(n), text: `${front(fields)}\n\n# ${GraphCore.qualified(n)}\n\n`
        + `\`${GraphCore.spanText(n.span)}\`\n\n${n.type ? '```text\n' + n.type + '\n```\n\n' : ''}`
        + `## Callers (${n.in.length})\n\n${line(callers)}\n\n## Callees (${n.out.length})\n\n${line(callees)}\n` });
    }

    for (const p of groups.packages) {
      const members = procsOf(p);
      const fields = {
        type: 'hotmap-package', program: q(program), generated: q(o.now),
        package: q(p.name), path: q(p.path || ''), procedures: members.length,
        in_calls: p.inCalls, out_calls: p.outCalls, dependents: p.inPkgs, rank: num(p.rank), untested: untested(p),
      };
      const rows = members.slice(0, 40).map(n => noted.has(GraphCore.qualified(n))
        ? `- [[${clean(GraphCore.qualified(n))}]] — hotness ${num(hotness(n))}`
        : `- \`${GraphCore.qualified(n)}\` — hotness ${num(hotness(n))}`).join('\n');
      const uses = [...p.in.keys()].sort((a, b) => p.in.get(b) - p.in.get(a));
      files.push({ path: pkgPath(p), text: `${front(fields)}\n\n# ${p.name}\n\n`
        + `${members.length} procedures · ${p.inCalls} cross-package calls in · used by ${plural(p.inPkgs, 'package')}\n\n`
        + `## Hottest here\n\n${rows || '- none'}\n\n`
        + `## Used by\n\n${uses.length ? uses.map(x => `- [[${clean(x)}]] (${p.in.get(x)})`).join('\n') : '- none'}\n` });
    }

    const dash = `${front({ type: 'hotmap-dashboard', program: q(program), generated: q(o.now),
      procedures: stats.symbols, edges: stats.edges, packages: stats.packages, untested: stats.untested })}
# Hotmap: ${program}

`
      + `Call-graph map written by the compiler to \`.mosaic/map/${program}/index.json\`. `
      + `Regenerate these notes with the command **Hotmap: write map notes**; the cube is the **Hotness cube** view.\n\n`
      + `## Packages by cross-package calls\n\n\`\`\`dataview\nTABLE procedures AS "procs", in_calls AS "in-calls", dependents AS "used by", rank AS "rank", untested AS "untested"\nFROM "${base}"\nWHERE type = "hotmap-package"\nSORT in_calls DESC\n\`\`\`\n\n`
      + `## Hottest procedures\n\n\`\`\`dataview\nTABLE package AS "package", hotness AS "hotness", callers, callees, tests, location\nFROM "${base}"\nWHERE type = "hotmap-procedure"\nSORT hotness DESC\nLIMIT 40\n\`\`\`\n\n`
      + `## Hot but untested\n\n\`\`\`dataview\nTABLE hotness, callers, location\nFROM "${base}"\nWHERE type = "hotmap-procedure" AND untested = true\nSORT hotness DESC\nLIMIT 25\n\`\`\`\n`;
    files.unshift({ path: `${base}/Hotmap.md`, text: dash });

    return { folder: base, files, manifest: { program, generated: o.now, paths: files.map(f => f.path) } };
  }

  // overview(folder, now) -> one note across every program's dashboard and procedure notes.
  function overview(folder, now) {
    const base = folder || FOLDER;
    return { path: `${base}/Hotmap.md`, text: `${front({ type: 'hotmap-overview', generated: q(now || new Date().toISOString()) })}
# Hotmap

Every program the compiler mapped, from \`.mosaic/map/\`. Regenerate with **Hotmap: write map notes**; open the cube with **Hotmap: open hotness cube**.

## Programs

\`\`\`dataview
TABLE program AS "program", procedures AS "procs", edges AS "call edges", packages AS "pkgs", untested AS "untested"
FROM "${base}"
WHERE type = "hotmap-dashboard"
SORT program ASC
\`\`\`

## Hottest procedures across programs

\`\`\`dataview
TABLE program AS "program", package AS "package", hotness AS "hotness", callers, tests, location
FROM "${base}"
WHERE type = "hotmap-procedure"
SORT hotness DESC
LIMIT 30
\`\`\`

## Hot but untested

\`\`\`dataview
TABLE program, package, hotness, callers, location
FROM "${base}"
WHERE type = "hotmap-procedure" AND untested = true
SORT hotness DESC
LIMIT 20
\`\`\`
` };
  }

  return { build, overview, clean, FOLDER };
});
