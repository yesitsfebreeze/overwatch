'use strict';
// Obsidian host for the hotmap viewer. The engine (graph-core, map-merge, similar, cube, codenotes)
// lives in this folder, so overwatch ships the plugin whole; a repository may re-export it.
//
// Two views:
//  - `Hotness cube` (tab): the WebGPU cube in an iframe, canvas only; the page's own sidebar is
//    hidden by the server's `?part=cube` injection.
//  - `Hotmap` (right sidebar): a native list — stats, filter, sort, procedures — built from
//    graph-core.js. Picking a row centres the cube; picking in the cube highlights the row.
//
// server.js serves the page over loopback from this folder and .mosaic/map/<program>/,
// so there is one copy of the viewer and the iframe gets a real origin,
// which WebGPU needs.
//
// Loader note: Obsidian runs main.js through new Function and its require resolves relative
// paths against electron's renderer, not this folder, so sibling files load by absolute path
// derived from this.manifest.dir (itself vault-relative on some builds). __dirname does not
// exist here.
const { Plugin, ItemView, Notice, PluginSettingTab, Setting } = require('obsidian');
const fs = require('fs');
const path = require('path');

const VIEW = 'hotmap-cube';
const PANEL = 'hotmap-panel';
const SRC_MAP = /^src-/;                 // only maps built from src/; test and example fixtures stay out
const CODEBASE = 'codebase';             // every src-* build, merged by server.js into one map
const DEFAULT_SETTINGS = { top: 200, folder: '01 Specs/10 Tooling and Protocols/Codebase Map', transparent: false, sorts: ['hot', 'callers', 'tests'] };

class HotmapView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Hotness cube'; }
  getIcon() { return 'box'; }

  async onOpen() { await this.render(); }
  onClose() { this.contentEl.empty(); }

  async render() {
    const plugin = this.plugin, root = this.contentEl;
    root.empty();
    root.addClass('hotmap-view');
    const bar = root.createDiv({ cls: 'hotmap-bar' });
    const programs = plugin.programs();
    const current = (this.getState() || {}).program;
    const program = programs.includes(current) ? current : plugin.defaultProgram();
    if (programs.length > 1) {
      const sel = bar.createEl('select', { cls: 'dropdown' });
      for (const p of programs) { const o = sel.createEl('option', { text: p }); o.value = p; o.selected = p === program; }
      sel.onchange = () => {
        this.setState({ program: sel.value }, { history: false }).then(() => this.render());
        if (plugin.panel) plugin.panel.setProgram(sel.value);
      };
    } else if (program) bar.createEl('span', { cls: 'hotmap-program', text: program });
    const reload = bar.createEl('button', { text: 'Reload', cls: 'hotmap-reload' });
    reload.onclick = () => this.render();

    if (!program) {
      root.createDiv({ cls: 'hotmap-note', text: 'No src map under .mosaic/map. Build the compiler (just self) and reopen this view.' });
      return;
    }
    const frame = root.createEl('iframe', { cls: 'hotmap-frame' });
    frame.setAttribute('title', 'Hotness cube');
    plugin.cubeFrame = frame;
    frame.onload = () => {
      plugin.applyCube();
      if (!plugin.pendingSelect) return;
      plugin.post({ hotmap: 'select', name: plugin.pendingSelect });
      plugin.pendingSelect = null;
    };
    await plugin.server.ready;
    // Cache-bust, and hand the page the host's background so it has a concrete colour even if a
    // stylesheet is stale or the iframe document was reused.
    const bg = plugin.settings.transparent ? '' : (plugin.theme()?.bg || '');
    frame.src = plugin.server.url(program, 'cube') + '&v=' + Date.now() + (bg ? '&bg=' + encodeURIComponent(bg) : '');
  }
}

// The page's analytics, filter and list, native to Obsidian, so the cube tab stays a canvas.
class HotmapPanel extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.state = { program: null, filter: '', sort: 'hot', desc: true, similar: 0 }; this.loaded = null; }
  getViewType() { return PANEL; }
  getDisplayText() { return 'Hotmap'; }
  getIcon() { return 'box'; }

  async onOpen() { this.plugin.panel = this; await this.render(); }
  onClose() { if (this.plugin.panel === this) this.plugin.panel = null; }

  setProgram(program) { if (this.state.program === program) return; this.state.program = program; this.loaded = null; this.render(); }

  // Build the graph once per program; graph-core also fills node.rank here.
  graphFor(program) {
    if (this.loaded && this.loaded.program === program) return this.loaded;
    const G = this.plugin.graphCore();
    const doc = program === CODEBASE ? this.plugin.codebaseDoc()
      : JSON.parse(fs.readFileSync(path.join(this.plugin.repo, '.mosaic', 'map', program, 'index.json'), 'utf8'));
    const graph = G.build(doc, { kinds: new Set(['procedure']) });
    const stats = G.stats(graph);
    this.loaded = { program, G, graph, stats };
    return this.loaded;
  }

  async render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('hotmap-panel');
    const wanted = this.state.program;
    const program = this.plugin.programs().includes(wanted) ? wanted : this.plugin.defaultProgram();
    if (!program) { root.createDiv({ cls: 'hotmap-note', text: 'No src map under .mosaic/map.' }); return; }
    this.state.program = program;
    const { G, graph, stats } = this.graphFor(program);

    const bar = root.createDiv({ cls: 'hotmap-panel-bar' });
    const programs = this.plugin.programs();
    if (programs.length > 1) {
      const sel = bar.createEl('select', { cls: 'dropdown' });
      for (const p of programs) { const o = sel.createEl('option', { text: p }); o.value = p; o.selected = p === program; }
      sel.onchange = () => {
        const p = sel.value;
        this.setProgram(p);
        this.plugin.pendingSelect = null;
        this.plugin.openCube(p);
      };
    } else bar.createEl('span', { cls: 'hotmap-program', text: program });

    const counts = root.createDiv({ cls: 'hotmap-panel-stats' });
    for (const [label, value] of [['procedures', stats.symbols], ['calls', stats.edges], ['packages', stats.packages], ['untested', stats.untested]]) {
      const cell = counts.createDiv({ cls: 'hotmap-panel-stat' });
      cell.createEl('b', { text: value.toLocaleString() });
      cell.createEl('span', { text: label });
    }

    const tools = root.createDiv({ cls: 'hotmap-panel-tools' });
    const find = tools.createEl('input', { type: 'search', placeholder: 'search procedures…' });
    find.value = this.state.filter;
    find.oninput = () => { this.state.filter = find.value; this.paint(G, graph); this.plugin.applyCube(); };
    // 'best first' is the larger value of every metric: more tests, more callers, hotter.
    const dir = tools.createEl('button', { cls: 'hotmap-panel-dir', text: this.state.desc ? 'best first' : 'worst first' });
    dir.title = 'flip the sort order';
    dir.onclick = () => { this.state.desc = !this.state.desc; dir.setText(this.state.desc ? 'best first' : 'worst first'); this.paint(G, graph); this.plugin.applyCube(); };
    // Similarity filter: keep procedures with a near clone at least this close, each beside its group.
    const sim = tools.createEl('select', { cls: 'dropdown hotmap-panel-similar' });
    sim.title = 'only procedures with a near clone (token shingles of the body)';
    for (const [v, text] of [[0, 'any'], [0.7, '≈ 70%'], [0.8, '≈ 80%'], [0.9, '≈ 90%'], [1, 'identical']]) {
      const o = sim.createEl('option', { text }); o.value = String(v); o.selected = v === this.state.similar;
    }
    sim.onchange = () => { this.state.similar = Number(sim.value); this.paint(G, graph); this.plugin.applyCube(); };

    // The sort keys are the cube's axes, in order: x primary, y first tiebreak, z second.
    const keys = root.createDiv({ cls: 'hotmap-panel-keys' });
    ['x', 'y', 'z'].forEach((label, i) => {
      const wrap = keys.createDiv({ cls: 'hotmap-panel-key' });
      wrap.createSpan({ cls: 'hotmap-panel-key-label', text: label });
      const pick = wrap.createEl('select', { cls: 'dropdown' });
      const options = [...Object.entries(G.METRICS).map(([k, m]) => [k, m.label]), ['name', 'name']];
      for (const [k, text] of options) { const o = pick.createEl('option', { text }); o.value = k; o.selected = k === this.plugin.sorts()[i]; }
      pick.onchange = async () => {
        const next = this.plugin.sorts().slice();
        next[i] = pick.value;
        this.plugin.settings.sorts = next;
        await this.plugin.saveSettings();
        this.paint(G, graph);
        this.plugin.applyCube();
      };
    });

    this.listEl = root.createDiv({ cls: 'hotmap-panel-list' });
    this.paint(G, graph);
  }

  // graph-core's `order`, which the cube bridge calls too: the list and the cube are one order.
  ordered(G, nodes) {
    return G.order(nodes, { sorts: this.plugin.sorts(), desc: this.state.desc, filter: this.state.filter, minSimilar: this.state.similar });
  }

  paint(G, graph) {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const nodes = this.ordered(G, graph.nodes).slice(0, 300);
    const metric = G.METRICS[this.plugin.sorts()[0]] || null;
    for (const n of nodes) {
      const row = list.createDiv({ cls: 'hotmap-panel-row' });
      row.dataset.name = G.qualified(n);
      const nm = row.createEl('span', { cls: 'hotmap-panel-name' });
      nm.createEl('i', { text: n.pkg + '.' });
      nm.appendText(n.name);
      const value = metric ? metric.get(n) : null;
      row.createEl('span', { cls: 'hotmap-panel-value', text: value == null ? '' : metric.fmt(value) });
      if (n.testCount === 0) row.addClass('hotmap-untested');
      if (n.twin) row.title = `≈ ${G.qualified(n.twin)} (${Math.round(n.similar * 100)}%)`;
      row.onclick = () => this.plugin.selectInCube(G.qualified(n));
    }
    if (!nodes.length) list.createDiv({ cls: 'hotmap-note', text: 'nothing matches' });
    this.highlight(null);
  }

  // Follow a pick made inside the cube.
  highlight(name) {
    if (!this.listEl) return;
    for (const row of this.listEl.querySelectorAll('.hotmap-panel-row')) {
      row.toggleClass('is-selected', row.dataset.name === name);
    }
  }
}

class HotmapSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Hotmap' });

    new Setting(containerEl)
      .setName('Procedure notes')
      .setDesc('How many of the hottest procedures get a note per program. The cube and query.mjs still see every procedure.')
      .addText(t => t.setValue(String(this.plugin.settings.top)).onChange(async v => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) return;
        this.plugin.settings.top = n;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Notes folder')
      .setDesc('Vault folder the Dataview notes are written to.')
      .addText(t => t.setValue(this.plugin.settings.folder).onChange(async v => {
        this.plugin.settings.folder = v.trim() || DEFAULT_SETTINGS.folder;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Transparent canvas')
      .setDesc('Let the pane behind the cube show through the canvas. Only works where the app honours WebGPU canvas alpha; where it does not, the cube area renders black. Off, the render pass clears to the theme background instead.')
      .addToggle(t => t.setValue(!!this.plugin.settings.transparent).onChange(async v => {
        this.plugin.settings.transparent = v;
        await this.plugin.saveSettings();
        new Notice('hotmap: reopen the cube to apply');
      }));

    new Setting(containerEl)
      .setName('Programs')
      .setDesc('Only maps built from src/ (src-*) are listed. Test and example fixtures stay on disk and stay available to query.mjs, but not here.');
  }
}

class HotmapPlugin extends Plugin {
  async onload() {
    // Register the visible surface first and report failures instead of vanishing: a silent throw
    // here used to leave only "Failed to load plugin" in the console.
    try {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
      this.registerView(VIEW, leaf => new HotmapView(leaf, this));
      this.registerView(PANEL, leaf => new HotmapPanel(leaf, this));
      this.addRibbonIcon('box', 'Hotness cube', () => this.openCube());
      this.addSettingTab(new HotmapSettingTab(this.app, this));
      this.addCommand({ id: 'open-cube', name: 'Open hotness cube', callback: () => this.openCube() });
      this.addCommand({ id: 'write-notes', name: 'Write map notes (Dataview)', callback: () => this.writeNotes().catch(e => new Notice('hotmap: ' + e.message)) });
      this.addCommand({ id: 'write-code-notes', name: 'Write code notes (code/)', callback: () => this.writeCodeNotes() });

      // A pick inside the cube arrives here, wrapped in the iframe's message.
      this.registerDomEvent(window, 'message', e => {
        const d = e.data;
        if (!d || d.hotmap !== 'pick' || !this.panel) return;
        this.panel.highlight(d.name);
      });

      const base = this.app.vault.adapter.basePath;
      const abs = p => (path.isAbsolute(p) ? p : path.join(base, p));
      const dir = abs(this.manifest.dir || '.obsidian/plugins/hotmap');
      const { MapServer, repoRoot, mergeSrc } = require(path.join(dir, 'server.js'));
      this.MapNotes = require(path.join(dir, 'mapnotes.js'));
      this.dir = dir;

      this.repo = repoRoot(base) || repoRoot(dir);
      if (!this.repo) throw new Error('this vault is not at <repo>/.overwatch/vault');
      this.codebaseDoc = () => mergeSrc(this.repo);
      this.server = new MapServer(this.repo, { theme: () => this.theme(), transparent: () => this.settings.transparent, page: path.join(dir, 'view.html') });
      this.server.ready.catch(e => new Notice('hotmap server: ' + e.message));
      console.log('hotmap: loaded', this.manifest.version, this.repo);
    } catch (e) {
      console.error('hotmap: load failed', e);
      new Notice('hotmap: load failed — ' + (e && e.message), 0);
    }
  }
  onunload() { if (this.server) this.server.stop(); }
  async saveSettings() { await this.saveData(this.settings); }

  // The page's palette, taken from the app's own theme so the cube looks like the vault around it.
  // Falls back to the body's painted colours when a theme does not define the variables.
  theme() {
    if (typeof document === 'undefined' || !document.body) return null;
    const cs = getComputedStyle(document.body), v = n => cs.getPropertyValue(n).trim();
    const opaque = c => (c && !/rgba\([^)]*,\s*0(\.0+)?\)/.test(c) ? c : '');
    const t = {
      bg: opaque(v('--background-primary')) || opaque(cs.backgroundColor) || v('--color-base-00') || v('--background-secondary') || '#1e1e1e',
      fg: v('--text-normal') || v('--color-base-10') || cs.color || '#dadada',
      panel: v('--background-secondary'), card: v('--background-modifier-hover'),
      line: v('--background-modifier-border'), mute: v('--text-muted'),
      accent: v('--interactive-accent'), accentSoft: v('--background-modifier-active-hover'),
    };
    if (!this.themeLogged) { this.themeLogged = true; console.log('hotmap: theme', JSON.stringify(t)); }
    return t;
  }

  graphCore() { return require(path.join(this.dir, 'graph-core.js')); }

  // One entry: every src-* map merged into the codebase map. Test and example fixtures stay out.
  programs() {
    const maps = path.join(this.repo, '.mosaic', 'map');
    if (!fs.existsSync(maps)) return [];
    return fs.readdirSync(maps).some(d => SRC_MAP.test(d) && fs.existsSync(path.join(maps, d, 'index.json'))) ? [CODEBASE] : [];
  }
  defaultProgram() { return this.programs()[0] || null; }

  async openCube(program) {
    if (!this.server) { new Notice('hotmap: plugin did not finish loading; check the console'); return; }
    program = program || this.defaultProgram();
    if (!program) { new Notice('hotmap: no src map under .mosaic/map; build the compiler first'); return; }
    const leaf = this.app.workspace.getLeavesOfType(VIEW)[0] || this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW, active: true, state: { program } });
    this.app.workspace.revealLeaf(leaf);
    // The cube is only half the view: its list lives in the right sidebar, so open that too.
    if (!this.app.workspace.getLeavesOfType(PANEL).length) {
      const right = this.app.workspace.getRightLeaf(false);
      if (right) await right.setViewState({ type: PANEL, active: false });
    }
    const split = this.app.workspace.rightSplit;
    if (split && typeof split.expand === 'function') split.expand();
  }

  post(message) {
    const frame = this.cubeFrame;
    if (frame && frame.contentWindow) frame.contentWindow.postMessage(message, '*');
  }

  // The panel drives the cube: the search text, the three sort keys and the direction.
  sorts() {
    const s = this.settings.sorts;
    return Array.isArray(s) && s.length === 3 ? s : DEFAULT_SETTINGS.sorts;
  }
  applyCube() {
    if (this.panel) this.pendingFilter = this.panel.state.filter || '';
    this.post({ hotmap: 'filter', text: this.pendingFilter || '', sorts: this.sorts(), desc: this.panel?.state.desc !== false, similar: this.panel?.state.similar || 0 });
  }

  async selectInCube(name) {
    if (!this.cubeFrame) this.pendingSelect = name;
    if (this.cubeFrame) this.post({ hotmap: 'select', name });
    else await this.openCube();
  }

  // The whole codebase as linked notes under code/ (codenotes.js in this folder; also a node CLI).
  writeCodeNotes() {
    try {
      const r = require(path.join(this.dir, 'codenotes.js')).write(this.repo, this.app.vault.adapter.basePath);
      new Notice(`hotmap: code notes ${r.written} written, ${r.unchanged} unchanged, ${r.deleted} deleted${r.kept.length ? `, ${r.kept.length} kept for gone files` : ''}`);
    } catch (e) { new Notice('hotmap: ' + e.message); }
  }

  // One note per package and per hot procedure per program, a dashboard per program, one overview.
  async writeNotes() {
    const programs = this.programs();
    if (!programs.length) { new Notice('hotmap: no src map under .mosaic/map; build the compiler first'); return; }
    const GraphCore = this.graphCore();
    const now = new Date().toISOString();
    let written = 0;

    for (const program of programs) {
      const doc = program === CODEBASE ? this.codebaseDoc()
        : JSON.parse(fs.readFileSync(path.join(this.repo, '.mosaic', 'map', program, 'index.json'), 'utf8'));
      const built = this.MapNotes.build(program, doc, GraphCore, { top: this.settings.top, folder: this.settings.folder, now });
      written += await this.writeBuilt(built);
    }
    const ov = this.MapNotes.overview(this.settings.folder, now);
    await this.writeFile(ov.path, ov.text);
    new Notice(`hotmap: wrote ${written + 1} notes for ${programs.join(', ')}`);
  }

  async writeBuilt(built) {
    for (const f of built.files) await this.writeFile(f.path, f.text);
    const manifestPath = `${built.folder}/.hotmap-manifest.json`;
    // Drop notes a previous run wrote that this one no longer generates.
    const prior = this.app.vault.getAbstractFileByPath(manifestPath);
    if (prior) {
      try {
        const old = JSON.parse(await this.app.vault.read(prior));
        for (const p of old.paths || []) {
          if (built.manifest.paths.includes(p)) continue;
          const stale = this.app.vault.getAbstractFileByPath(p);
          if (stale) await this.app.vault.delete(stale);
        }
      } catch (e) { /* a corrupt manifest only costs stale notes */ }
    }
    await this.writeFile(manifestPath, JSON.stringify(built.manifest, null, 2));
    return built.files.length;
  }

  async writeFile(filePath, text) {
    const current = this.app.vault.getAbstractFileByPath(filePath);
    if (current) await this.app.vault.modify(current, text);
    else await this.app.vault.create(filePath, text);
  }
}

module.exports = HotmapPlugin;
