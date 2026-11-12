---
title: Dashboard
category: Meta
status: index
updated: 2026-11-12
tags: [meta, dashboard]
---

# Dashboard

Live view over every unit in `01 Specs`, rendered by Dataview. Completion counts `implemented` as 1 and `partial` as 0.5. Friction is the same score the plan uses; the legend is at the bottom. Open this note in Reading view.

```dataviewjs
const CSS = `
.msd { --ok:#3fb950; --half:#d29922; --todo:#8b949e; --prop:#a371f7; --hot:#f85149; font-size:0.92em; }
.msd h3 { margin:1.4em 0 .5em; font-size:1.05em; letter-spacing:.02em; text-transform:uppercase; opacity:.75; }
.msd .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; }
.msd .tile { background:var(--background-secondary); border-radius:8px; padding:12px 14px; border-left:4px solid var(--c); }
.msd .tile b { display:block; font-size:1.7em; line-height:1.1; }
.msd .tile span { opacity:.7; font-size:.85em; }
.msd .rows { display:grid; grid-template-columns:max-content 1fr max-content; gap:6px 12px; align-items:center; }
.msd .lbl { white-space:nowrap; }
.msd .bar { display:flex; height:14px; border-radius:7px; overflow:hidden; background:var(--background-modifier-border); }
.msd .bar i { display:block; height:100%; }
.msd .pct { font-variant-numeric:tabular-nums; opacity:.8; white-space:nowrap; }
.msd .heat { display:flex; height:14px; border-radius:7px; background:var(--background-modifier-border); overflow:hidden; }
.msd .heat i { display:block; height:100%; background:var(--hot); }
.msd .legend { display:flex; gap:14px; flex-wrap:wrap; opacity:.75; font-size:.85em; margin-top:6px; }
.msd .legend i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:4px; vertical-align:middle; }
.msd .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:10px; }
.msd .card { background:var(--background-secondary); border-radius:8px; padding:10px 12px; border-top:3px solid var(--hot); }
.msd .card .t { font-weight:600; }
.msd .card .m { opacity:.7; font-size:.85em; margin-top:2px; }
.msd .card .w { font-size:.85em; margin-top:6px; }
.msd .card .s { float:right; font-weight:700; color:var(--hot); }
.msd .small { opacity:.65; font-size:.85em; }
.msd p { margin:0; }
`;
dv.container.createEl("style", { text: CSS });
const root = dv.container.createDiv({ cls: "msd" });

const STATUS = { implemented: 1, partial: 0.5, target: 0, proposed: 0, deferred: 0, "open-question": 0 };
const COLOR = { implemented: "var(--ok)", partial: "var(--half)", target: "var(--todo)", proposed: "var(--prop)", deferred: "var(--todo)", "open-question": "var(--prop)" };
const STALE_MS = 15 * 60 * 1000;
const pages = dv.pages('"01 Specs"').where(p => p.status && p.status !== "index" && p.plan !== "skip");

const notes = [];
for (const p of pages) {
  const text = await dv.io.load(p.file.path);
  const section = name => { const s = text.split(/^## /m).find(x => x.startsWith(name)); return s ? s.slice(name.length) : ""; };
  const plan = section("Plan");
  const openItems = (plan.match(/^- \[ \] \S/gm) || []).length;
  const openQ = (section("Open questions").match(/^- \S/gm) || []).length;
  const issues = Array.isArray(p.issues) ? p.issues : [];
  const proposals = Array.isArray(p.proposals) ? p.proposals : [];
  const status = String(p.status);
  const depName = x => typeof x === "string" ? x.replace(/[[\]]/g, "").trim() : x?.path ? String(x.path).split("/").pop().replace(/\.md$/, "") : String(x).replace(/[[\]]/g, "").trim();
  const depends = (Array.isArray(p.depends) ? p.depends : p.depends ? [p.depends] : []).map(depName).filter(Boolean);
  const why = [];
  let score = 0;
  if (issues.length) { score += 2 * issues.length; why.push(`${issues.length} issue${issues.length > 1 ? "s" : ""}`); }
  if (openQ) { score += 2 * openQ; why.push(`${openQ} open question${openQ > 1 ? "s" : ""}`); }
  if (status === "proposed") { score += 3; why.push("proposed only"); }
  if (status === "partial") { score += 2; why.push("partial"); }
  if (status === "target") { score += 1; why.push("not implemented"); }
  if (status === "deferred") { score += 1; why.push("deferred"); }
  if (proposals.length > 1) { score += 1; why.push(`${proposals.length} proposals`); }
  notes.push({ p, status, openQ, issues, proposals, depends, openItems, score: Math.max(1, score), why, done: STATUS[status] ?? 0 });
}

// Waves from explicit depends, as computePlan does: one more than the latest open predecessor.
const byName = Object.fromEntries(notes.map(n => [n.p.file.name, n]));
const openNames = new Set(notes.filter(n => n.status !== "implemented").map(n => n.p.file.name));
const waveOf = (n, seen = []) => {
  if (n.wave) return n.wave;
  if (seen.includes(n.p.file.name)) return 0;
  let w = 1;
  for (const d of n.depends) { const dep = byName[d]; if (dep && openNames.has(d)) w = Math.max(w, waveOf(dep, [...seen, n.p.file.name]) + 1); }
  return (n.wave = w);
};
const held = n => n.status === "deferred" ? "deferred" : n.blocked ? "blocked" : n.depends.some(d => openNames.has(d)) ? "waiting" : "";
const claimed = n => n.owner && (!n.since || Date.now() - Date.parse(n.since) <= STALE_MS);
for (const n of notes) { waveOf(n); n.held = held(n); n.ready = !n.held && !claimed(n) && n.status !== "implemented"; n.stale = !!n.owner && !claimed(n); }

const byCat = {};
for (const n of notes) (byCat[n.p.category || "none"] ??= []).push(n);
const cats = Object.keys(byCat).sort();
const count = (arr, s) => arr.filter(n => n.status === s).length;
const completion = arr => arr.length ? arr.reduce((a, n) => a + n.done, 0) / arr.length : 0;
const pct = x => Math.round(x * 100) + "%";
const open = notes.filter(n => n.status !== "implemented");

root.createEl("h3", { text: "Unit completion" });
const tiles = root.createDiv({ cls: "tiles" });
const tile = (n, label, c) => { const t = tiles.createDiv({ cls: "tile" }); t.style.setProperty("--c", c); t.createEl("b", { text: String(n) }); t.createEl("span", { text: label }); };
tile(pct(completion(notes)), "complete", "var(--ok)");
tile(notes.length, "units", "var(--todo)");
tile(count(notes, "implemented"), "implemented", "var(--ok)");
tile(count(notes, "partial"), "partial", "var(--half)");
tile(count(notes, "target"), "target", "var(--todo)");
tile(open.filter(n => n.ready).length, "ready now", "var(--prop)");

root.createEl("h3", { text: "Completion by area" });
const rows = root.createDiv({ cls: "rows" });
for (const c of cats) {
  const arr = byCat[c];
  rows.createDiv({ cls: "lbl", text: c });
  const bar = rows.createDiv({ cls: "bar" });
  for (const s of ["implemented", "partial", "proposed", "deferred", "target"]) {
    const k = count(arr, s); if (!k) continue;
    const seg = bar.createEl("i"); seg.style.width = (100 * k / arr.length) + "%"; seg.style.background = COLOR[s]; seg.title = `${s}: ${k}`;
  }
  rows.createDiv({ cls: "pct", text: `${pct(completion(arr))} · ${arr.length}` });
}
const legend = root.createDiv({ cls: "legend" });
for (const s of ["implemented", "partial", "proposed", "target"]) { const l = legend.createEl("span"); const i = l.createEl("i"); i.style.background = COLOR[s]; l.appendText(s); }

root.createEl("h3", { text: "Friction by area" });
const frows = root.createDiv({ cls: "rows" });
const openOf = arr => arr.filter(n => n.status !== "implemented");
const avg = arr => arr.length ? arr.reduce((a, n) => a + n.score, 0) / arr.length : 0;
const maxAvg = Math.max(...cats.map(c => avg(openOf(byCat[c]))), 1);
for (const c of [...cats].sort((a, b) => avg(openOf(byCat[b])) - avg(openOf(byCat[a])))) {
  const arr = openOf(byCat[c]);
  frows.createDiv({ cls: "lbl", text: c });
  const h = frows.createDiv({ cls: "heat" }); const i = h.createEl("i"); i.style.width = (100 * avg(arr) / maxAvg) + "%";
  frows.createDiv({ cls: "pct", text: `${avg(arr).toFixed(1)} avg · ${arr.filter(n => n.score >= 4).length} hot` });
}
root.createDiv({ cls: "small", text: "avg = mean friction score of the open units in the area; hot = units scoring 4 or more." });

root.createEl("h3", { text: "Highest friction" });
const cards = root.createDiv({ cls: "cards" });
for (const n of [...open].sort((a, b) => b.score - a.score || a.p.file.name.localeCompare(b.p.file.name)).slice(0, 9)) {
  const card = cards.createDiv({ cls: "card" });
  card.createEl("span", { cls: "s", text: String(n.score) });
  dv.el("div", `[[${n.p.file.path}|${n.p.file.name}]]`, { container: card, cls: "t" });
  card.createDiv({ cls: "m", text: `${n.p.category || "none"} · ${n.status} · wave ${n.wave}` });
  card.createDiv({ cls: "w", text: n.why.join(" · ") || "open work" });
}

root.createEl("h3", { text: "Ready now" });
const ready = open.filter(n => n.ready).sort((a, b) => a.wave - b.wave || a.p.file.name.localeCompare(b.p.file.name));
if (!ready.length) root.createDiv({ cls: "small", text: "No unit can start now; see held units below." });
for (const n of ready.slice(0, 12)) dv.el("div", `[[${n.p.file.path}|${n.p.file.name}]] · wave ${n.wave} · ${n.openItems} open item(s)${Array.isArray(n.checks) ? ` · ${n.checks.length} check(s)` : ""}`, { container: root });

root.createEl("h3", { text: "Claims" });
const claims = notes.filter(n => n.owner);
if (!claims.length) root.createDiv({ cls: "small", text: "No unit is claimed." });
for (const n of claims) dv.el("div", `[[${n.p.file.path}|${n.p.file.name}]] · ${n.owner}${n.since ? ` since ${n.since}` : ""}${n.stale ? " · STALE (15+ minutes without a heartbeat)" : ""}`, { container: root });

root.createEl("h3", { text: "Held" });
const wait = open.filter(n => n.held);
if (!wait.length) root.createDiv({ cls: "small", text: "Every open unit can start." });
for (const n of wait.slice(0, 12)) dv.el("div", `[[${n.p.file.path}|${n.p.file.name}]] · ${n.held}${n.depends.length ? ` · after ${n.depends.join(", ")}` : ""}${n.blocked ? ` · ${n.blocked}` : ""}`, { container: root });
```

## Friction score

| Signal | Points |
| --- | --- |
| each linked GitHub issue | 2 |
| each bullet under Open questions | 2 |
| status `proposed` | 3 |
| status `partial` | 2 |
| status `target` or `deferred` | 1 |
| more than one proposal | 1 |

At least 1; the same score `computePlan` uses for effort. Weights live in the `dataviewjs` block above.

## Related

- [[Home]]
- [[Plan]]
- [[Plan Tasks]]

## Sources

- Every spec note's frontmatter (`status`, `category`, `depends`, `owner`, `since`, `blocked`, `checks`, `paths`, `proof`, `issues`, `proposals`) and its Plan and Open questions sections.
