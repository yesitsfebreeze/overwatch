// Pure graph model over a Mosaic call-graph map (.mosaic/map/<program>/index.json, src/compiler/query/codebase_map.mi).
// No DOM here so the same code runs under node for the self-check.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GraphCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Build symbol-level and package-level graphs from an index document.
  // Edges: symbol `calls` (direct callees only; indirect calls and builtins are not in the index).
  function build(index, options) {
    const kinds = options && options.kinds; // null = every kind
    const symbols = (index.symbols || []).filter(s => !kinds || kinds.has(s.kind));
    // An index of one package (e.g. `alp_index` on src/compiler) still has structure: group by
    // the declaring file, so check_expr, lb, parser... show as the "packages" of that one package.
    const byDir = (index.packages || []).length <= 1;
    const pkgOf = s => byDir && s.span && s.span.file ? s.span.file.replace(/^src\//, '').replace(/\.mi$/, '') : (s.package || '?');
    if (byDir) { for (const s of symbols) s.package = pkgOf(s); index.packages = [...new Set(symbols.map(s => s.package))].sort().map(p => ({ path: 'src/' + p, name: p })); }
    const byId = new Map(symbols.map(s => [s.id, s]));
    // `tests` is the id list the compiler emits, or just its count in a slimmed index.
    // `similar` / `twin`: the best near-clone score and its procedure, when map-merge found one.
    const nodes = symbols.map(s => ({ id: s.id, name: s.name, kind: s.kind, pkg: s.package, span: s.span, type: s.type, effects: s.effects,
      tests: Array.isArray(s.tests) ? s.tests : [], testCount: typeof s.tests === 'number' ? s.tests : (s.tests || []).length, external: s.external || 0,
      similar: s.similar || 0, twin: s.twin, out: [], in: [] }));
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    for (const n of nodes) n.twin = n.twin == null ? null : nodeById.get(n.twin) || null;
    const edges = [];
    let dangling = 0;
    for (const s of symbols) {
      for (const callee of s.calls || []) {
        const target = nodeById.get(callee);
        if (!target) { dangling++; continue; } // callee outside the indexed scope or filtered kind
        const source = nodeById.get(s.id);
        source.out.push(target); target.in.push(source);
        edges.push({ source, target });
      }
    }
    // Package graph: aggregate cross-package calls. A real import graph needs the compiler
    // (check_program.mi package_import_targets); this is the call-derived approximation.
    const pkgs = new Map();
    for (const p of index.packages || []) pkgs.set(p.name, { id: p.name, name: p.name, path: p.path, symbols: 0, out: new Map(), in: new Map() });
    for (const n of nodes) {
      if (!pkgs.has(n.pkg)) pkgs.set(n.pkg, { id: n.pkg, name: n.pkg, path: '', symbols: 0, out: new Map(), in: new Map() });
      pkgs.get(n.pkg).symbols++;
    }
    for (const e of edges) {
      if (e.source.pkg === e.target.pkg) continue;
      const a = pkgs.get(e.source.pkg), b = pkgs.get(e.target.pkg);
      a.out.set(b.id, (a.out.get(b.id) || 0) + 1);
      b.in.set(a.id, (b.in.get(a.id) || 0) + 1);
    }
    return { nodes, edges, byId, nodeById, packages: [...pkgs.values()], dangling };
  }

  // Tarjan strongly connected components over nodes with `out` arrays of nodes.
  // Returns only components of size > 1 (real cycles), largest first.
  function cycles(nodes) {
    let index = 0; const stack = []; const onStack = new Set(); const idx = new Map(); const low = new Map(); const out = [];
    function strong(v) {
      idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
      for (const w of v.out) {
        if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = []; let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) out.push(comp);
      }
    }
    for (const v of nodes) if (!idx.has(v)) strong(v);
    return out.sort((a, b) => b.length - a.length);
  }

  // Package cycles: wrap package maps as nodes with `out` arrays. Ceiling: recursion depth equals
  // the longest chain; fine for packages, replace with an explicit stack for >10k symbol nodes.
  function packageCycles(packages) {
    const byId = new Map(packages.map(p => [p.id, { id: p.id, out: [] }]));
    for (const p of packages) for (const t of p.out.keys()) byId.get(p.id).out.push(byId.get(t));
    return cycles([...byId.values()]).map(c => c.map(n => n.id));
  }

  // Shortest call chain from `from` to `to` (BFS over callees). Null when unreachable.
  function path(from, to) {
    const prev = new Map([[from, null]]); const queue = [from];
    while (queue.length) {
      const v = queue.shift();
      if (v === to) { const p = []; for (let x = v; x; x = prev.get(x)) p.push(x); return p.reverse(); }
      for (const w of v.out) if (!prev.has(w)) { prev.set(w, v); queue.push(w); }
    }
    return null;
  }

  // Every node reachable from `roots` following callees.
  function reachable(roots) {
    const seen = new Set(roots); const queue = [...roots];
    while (queue.length) { const v = queue.shift(); for (const w of v.out) if (!seen.has(w)) { seen.add(w); queue.push(w); } }
    return seen;
  }

  // PageRank over call edges (callers vote for callees). A symbol is "hot" when many hot symbols
  // call it: that is the code every path runs through, so it must be fast and correct first.
  // Fixed 40 rounds, damping 0.85; plenty for a call graph of this size, not a convergence test.
  function rank(nodes, rounds) {
    const n = nodes.length; if (!n) return new Map();
    let r = new Map(nodes.map(v => [v, 1 / n]));
    for (let i = 0; i < (rounds || 40); i++) {
      const next = new Map(); let sink = 0;
      for (const v of nodes) if (!v.out.length) sink += r.get(v);
      for (const v of nodes) {
        let s = 0; for (const c of v.in) s += r.get(c) / c.out.length;
        next.set(v, (1 - 0.85) / n + 0.85 * (s + sink / n));
      }
      r = next;
    }
    for (const v of nodes) v.rank = r.get(v) * n; // 1.0 = average symbol
    return r;
  }

  // Package hotness: how much of the rest of the program leans on this package.
  // inCalls = cross-package call sites into it, inPkgs = how many packages depend on it,
  // rank = summed PageRank of its symbols, cycleWeight = calls arriving from within the package.
  function hotPackages(graph) {
    const byPkg = new Map(graph.packages.map(p => [p.id, { ...p, inCalls: 0, inPkgs: p.in.size, outCalls: 0, rank: 0, internal: 0 }]));
    for (const p of byPkg.values()) { for (const n of p.in.values()) p.inCalls += n; for (const n of p.out.values()) p.outCalls += n; }
    for (const n of graph.nodes) { const p = byPkg.get(n.pkg); if (p) p.rank += n.rank || 0; }
    for (const e of graph.edges) if (e.source.pkg === e.target.pkg) byPkg.get(e.source.pkg).internal++;
    return [...byPkg.values()].sort((a, b) => b.inCalls - a.inCalls || b.rank - a.rank);
  }

  function stats(graph) {
    const nodes = graph.nodes;
    const top = (key, n) => [...nodes].sort((a, b) => b[key].length - a[key].length).slice(0, n);
    const roots = nodes.filter(n => n.name === 'main');
    const live = reachable(roots);
    rank(nodes);
    return {
      symbols: nodes.length, edges: graph.edges.length, dangling: graph.dangling,
      packages: graph.packages.length,
      fanIn: top('in', 10), fanOut: top('out', 10),
      hot: [...nodes].sort((a, b) => b.rank - a.rank).slice(0, 15),
      hotPackages: hotPackages(graph),
      isolated: nodes.filter(n => n.in.length === 0 && n.out.length === 0).length,
      untested: nodes.filter(n => n.kind === 'procedure' && n.testCount === 0).length,
      unreachableFromMain: roots.length ? nodes.filter(n => !live.has(n)).length : null,
      symbolCycles: cycles(nodes), packageCycles: packageCycles(graph.packages),
    };
  }

  // Span text for both shapes the compiler has emitted: {file,start:{line}} and {file,line}.
  function lineOf(span) { return span ? span.line ?? span.start?.line : undefined; }
  function spanText(span) { if (!span) return ''; const line = lineOf(span); return line == null ? span.file : `${span.file}:${line}`; }

  // ---- Sorted, filtered lists: one definition shared by the viewer sidebar and query.mjs. ----
  // Procedure metrics. `weight` is the box volume when the cube is arranged by the metric. Every
  // metric reads the same way: the larger value ranks first ("best first", the low cube corner),
  // so a procedure with more tests ranks above an untested one.
  const METRICS = {
    hot:     { label: 'hotness',    get: n => 1 + n.in.length + 5 * (n.rank || 0), weight: v => v,        fmt: v => v.toFixed(1) },
    rank:    { label: 'PageRank',   get: n => n.rank || 0,                         weight: v => v + 0.01, fmt: v => v.toFixed(2) },
    callers: { label: 'callers',    get: n => n.in.length,                         weight: v => 1 + v,    fmt: String },
    callees: { label: 'callees',    get: n => n.out.length,                        weight: v => 1 + v,    fmt: String },
    tests:   { label: 'tests',      get: n => n.testCount,                         weight: v => 1 + v,    fmt: String },
    similar: { label: 'similarity', get: n => n.similar || 0,                      weight: v => 0.05 + v, fmt: v => `${Math.round(v * 100)}%` },
  };
  const PACKAGE_SORTS = { inCalls: ['in-calls', p => p.inCalls], dependents: ['dependents', p => p.inPkgs], rank: ['rank', p => p.rank], size: ['procedures', p => p.members.length] };
  const CYCLE_SORTS = { size: ['size', c => c.members.length] };
  const qualified = n => `${n.pkg}.${n.name}`;

  // Packages with their member procedures, and cycles (package cycles first) as member lists.
  function groups(graph, s) {
    const byPkg = new Map(); for (const n of graph.nodes) { if (!byPkg.has(n.pkg)) byPkg.set(n.pkg, []); byPkg.get(n.pkg).push(n); }
    const packages = s.hotPackages.map(p => ({ ...p, label: p.name, members: byPkg.get(p.id) || byPkg.get(p.name) || [] }));
    const cycles = [
      ...s.packageCycles.map(c => ({ label: 'packages: ' + c.join(' ⇄ '), packages: c, members: graph.nodes.filter(n => c.includes(n.pkg)) })),
      ...s.symbolCycles.map(c => ({ label: c.slice(0, 4).map(n => n.name).join(' → ') + (c.length > 4 ? ` … (${c.length})` : ''), members: c })),
    ];
    return { packages, cycles };
  }

  // Search terms: `;` separates alternatives, and an empty filter matches everything. A name
  // matches when it contains any term, case-insensitively. The cube, query.mjs and Jev share this
  // rule so a search means the same thing everywhere.
  function terms(text) {
    return String(text ?? '').toLowerCase().split(';').map(s => s.trim()).filter(Boolean);
  }
  function matcher(filter) {
    const list = terms(filter);
    if (!list.length) return () => true;
    return name => { const text = String(name).toLowerCase(); return list.some(term => text.includes(term)); };
  }
  function matches(name, filter) { return matcher(filter)(name); }

  // Clone groups: procedures joined through their `twin` links, each group kept together at the
  // position of its first member in `nodes`, members in their `nodes` order. Shows near copies side
  // by side whatever the sort.
  function cloneGroups(nodes) {
    const at = new Map(nodes.map((n, i) => [n, i])), up = new Map();
    const find = n => { let r = n; while (up.has(r)) r = up.get(r); while (n !== r) { const next = up.get(n); up.set(n, r); n = next; } return r; };
    for (const n of nodes) {
      if (!n.twin || !at.has(n.twin)) continue;
      const [a, b] = [find(n), find(n.twin)].sort((x, y) => at.get(x) - at.get(y));
      if (a !== b) up.set(b, a); // the earlier root stays the group's root
    }
    const groups = new Map();
    for (const n of nodes) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
    return [...groups.values()].flat();
  }

  // The one order over procedures that the panel, the cube and `list` share: sort keys in turn
  // ('name' compares as text), `desc` flipping every key unless a key is given as { key, desc },
  // ties by name; `filter`, `keep` (an extra predicate) and `minSimilar` as in `list`, with clone
  // groups kept together when minSimilar is on. compareBy is one key of it.
  function compareBy(key, desc) {
    if (key === 'name') return (a, b) => (desc ? 1 : -1) * qualified(a).localeCompare(qualified(b));
    const m = METRICS[key]; if (!m) return () => 0;
    return (a, b) => (desc ? m.get(b) - m.get(a) : m.get(a) - m.get(b));
  }
  function order(nodes, opts) {
    const o = Object.assign({ desc: true, sorts: ['hot'] }, opts), hit = matcher(o.filter);
    const cmps = o.sorts.map(k => (typeof k === 'string' ? compareBy(k, o.desc) : compareBy(k.key, k.desc)));
    const cmp = (a, b) => { for (const c of cmps) { const d = c(a, b); if (d) return d; } return qualified(a).localeCompare(qualified(b)); };
    const rows = nodes.filter(n => hit(qualified(n)) && (!o.keep || o.keep(n)) && (!o.minSimilar || n.similar >= o.minSimilar)).sort(cmp);
    return o.minSimilar ? cloneGroups(rows) : rows;
  }

  // One sorted, filtered list. what: 'procs' | 'pkgs' | 'cycles'. opts: { sort, desc = true (largest
  // value first), filter, package, untested, minCallers, minCallees, minSimilar }. filter is a
  // case-insensitive substring of the qualified name (procs) or label, with `;` separating alternative
  // substrings; package keeps one package's procedures; untested keeps procedures with no test;
  // minSimilar (0..1, 0 = off) keeps procedures with a near clone at least that close, grouped with it.
  // Rows: { ref, label, value, fmt }, value null when sorted by name. Ties break by hotness, then name.
  function list(what, source, opts) {
    const o = Object.assign({ desc: true }, opts), dir = o.desc ? -1 : 1;
    if (what === 'procs') {
      const sort = o.sort || 'hot';
      const m = METRICS[sort];
      if (!m && sort !== 'name') throw new Error(`unknown procedure sort '${sort}': ${Object.keys(METRICS).concat('name').join(', ')}`);
      const keep = n => (!o.package || n.pkg === o.package) && (!o.untested || n.testCount === 0)
        && n.in.length >= (o.minCallers || 0) && n.out.length >= (o.minCallees || 0);
      // Metric ties: hotter first (e.g. the hottest untested procedures), then by name.
      const sorts = m ? [sort, { key: 'hot', desc: true }] : ['name'];
      return order(source, { sorts, desc: o.desc, filter: o.filter, keep, minSimilar: o.minSimilar })
        .map(n => ({ ref: n, label: qualified(n), value: m ? m.get(n) : null, fmt: m ? m.fmt : null }));
    }
    const sorts = what === 'pkgs' ? PACKAGE_SORTS : CYCLE_SORTS, sort = o.sort || Object.keys(sorts)[0];
    if (!sorts[sort]) throw new Error(`unknown ${what} sort '${sort}': ${Object.keys(sorts).join(', ')}`);
    const get = sorts[sort][1];
    const hit = matcher(o.filter);
    return source.filter(x => hit(x.label)).sort((a, b) => dir * (get(a) - get(b)) || a.label.localeCompare(b.label))
      .map(x => ({ ref: x, label: x.label, value: get(x), fmt: v => Number.isInteger(v) ? String(v) : v.toFixed(1) }));
  }

  return { build, cycles, packageCycles, path, reachable, rank, hotPackages, stats, lineOf, spanText, METRICS, PACKAGE_SORTS, CYCLE_SORTS, groups, cloneGroups, compareBy, order, list, qualified, terms, matches };
});
