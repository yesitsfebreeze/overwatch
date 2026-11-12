'use strict';
// Obsidian host for the timeless plan. 00 Meta/Plan.md computes the waves, effort and
// dependency starts; 00 Meta/Plan Data.json is the projection this view renders. There is
// no calendar axis: x is effort; overlapping bars do not allocate worker or build slots.

const { Plugin, ItemView, PluginSettingTab, Setting } = require('obsidian');

const VIEW = 'plan-view';
const PLAN_DATA = '00 Meta/Plan Data.json';
const DEFAULT_SETTINGS = { scale: 22, showDone: true };

async function sourceState(app, data, cache = new Map()) {
  const source = data.source;
  if (source?.version !== 1 || source.algorithm !== 'sha256' || !Array.isArray(source.files) ||
      !source.files.every(item => typeof item.path === 'string' && /^[0-9a-f]{64}$/.test(item.sha256))) {
    return { state: 'unknown', changed: [] };
  }
  try {
    const excluded = new Set(source.excluded || []);
    const files = app.vault.getMarkdownFiles().filter(file => !excluded.has(file.path) &&
      !file.path.split('/').some(part => part.startsWith('.') || part.startsWith('_')));
    const expected = new Map(source.files.map(item => [item.path, item.sha256]));
    const changed = new Set([...expected.keys()].filter(name => !files.some(file => file.path === name)));
    const hash = require('node:crypto').createHash;
    for (const file of files) {
      if (!expected.has(file.path)) { changed.add(file.path); continue; }
      const prior = cache.get(file.path), stamp = file.stat ? [file.stat.mtime, file.stat.size].join(':') : null;
      let sha256 = stamp && prior?.stamp === stamp ? prior.sha256 : null;
      if (!sha256) {
        sha256 = hash('sha256').update(await app.vault.read(file)).digest('hex');
        if (stamp) cache.set(file.path, { stamp, sha256 });
      }
      if (sha256 !== expected.get(file.path)) changed.add(file.path);
    }
    for (const name of cache.keys()) if (!files.some(file => file.path === name)) cache.delete(name);
    return { state: changed.size ? 'stale' : 'current', changed: [...changed].sort() };
  } catch { return { state: 'unknown', changed: [] }; }
}

class PlanView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.sourceCache = new Map(); }

  getViewType() { return VIEW; }
  getDisplayText() { return 'Plan'; }
  getIcon() { return 'git-fork'; }

  async onOpen() {
    this.plugin.views.add(this);
    if (this.timer) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (this.plugin.views.has(this)) this.render().catch(error => console.error('plan-view: live refresh failed', error));
    }, 30_000);
    await this.render();
  }

  onClose() {
    this.renderRevision = (this.renderRevision || 0) + 1;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    this.plugin.views.delete(this);
    this.contentEl.empty();
  }

  async readData() {
    const text = await this.app.vault.adapter.read(PLAN_DATA);
    return JSON.parse(text);
  }

  async render() {
    const revision = this.renderRevision = (this.renderRevision || 0) + 1;
    const root = this.contentEl;
    root.addClass('plan-view');

    let data;
    try { data = await this.readData(); } catch (error) {
      if (revision !== this.renderRevision) return;
      root.empty();
      root.createDiv({ cls: 'plan-note', text: `Missing or invalid ${PLAN_DATA}. Run the overwatch tool vault_plan (or: overwatch vault plan)` });
      return;
    }

    const freshness = await sourceState(this.app, data, this.sourceCache);
    if (revision !== this.renderRevision) return;
    const p = data.progress || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const now = Date.now();
    const basePath = basePathOf(this.app);
    const claims = new Map();
    for (const row of rows) if (row.owner) claims.set(row, claimFor(this.app, row, basePath, now));
    const claimed = claims.size;
    const staleClaims = [...claims.values()].filter(state => state?.stale).length;
    let dataUpdated = 'unknown';
    try {
      const stat = await this.app.vault.adapter.stat(PLAN_DATA);
      if (stat?.mtime) dataUpdated = new Date(stat.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (error) { /* adapter stat is optional; the data itself still renders */ }
    if (revision !== this.renderRevision) return;
    root.empty();
    const head = root.createDiv({ cls: 'plan-head' });
    const title = head.createDiv({ cls: 'plan-title-block' });
    title.createDiv({ cls: 'plan-title', text: 'Plan' });
    title.createDiv({ cls: 'plan-sub', text: `${p.implemented ?? 0}/${p.total ?? 0} implemented · ${p.proven ?? 0} with proof references · ${p.open ?? 0} open · ${p.ready ?? 0} ready (${p.scoped ?? 0} scoped) · ${claimed} claimed${staleClaims ? ` (${staleClaims} stale)` : ''} · ${data.parallel ?? 0} dependency concurrency · ${data.critical ?? 0}u critical · data ${dataUpdated}` });

    const snapshot = freshness.state === 'current'
      ? 'Source snapshot unchanged. Proof references have not been revalidated.'
      : freshness.state === 'stale'
        ? 'Source snapshot changed (' + freshness.changed.length + ' files). Regenerate the plan before choosing work.'
        : 'Snapshot freshness unavailable. Regenerate the plan to capture source identities.';
    head.createDiv({ cls: 'plan-note', text: snapshot });
    const controls = head.createDiv({ cls: 'plan-controls' });
    const zoomOut = controls.createEl('button', { cls: 'plan-button', text: '−' });
    zoomOut.onclick = () => this.setScale(this.plugin.settings.scale - 2);
    const zoomIn = controls.createEl('button', { cls: 'plan-button', text: '+' });
    zoomIn.onclick = () => this.setScale(this.plugin.settings.scale + 2);
    const refresh = controls.createEl('button', { cls: 'plan-button', text: 'Refresh' });
    refresh.onclick = () => { this.sourceCache.clear(); return this.render(); };
    const doneToggle = controls.createEl('button', {
      cls: 'plan-button' + (this.plugin.settings.showDone ? ' is-active' : ''),
      text: this.plugin.settings.showDone ? 'Hide done' : 'Show done',
    });
    doneToggle.onclick = async () => {
      this.plugin.settings.showDone = !this.plugin.settings.showDone;
      await this.plugin.saveSettings();
      await this.render();
    };

    const progress = root.createDiv({ cls: 'plan-progress' });
    const percent = p.total ? Math.round(100 * (p.implemented || 0) / p.total) : 0;
    const fill = progress.createDiv({ cls: 'plan-progress-fill' });
    fill.style.width = percent + '%';
    progress.createDiv({ cls: 'plan-progress-label', text: `${percent}% · ${p.proven ?? 0} with proof references · ${p.effort ?? 0}u remaining` });

    const doneItems = Array.isArray(data.done) ? data.done : [];
    // Per-row status: no header bar repeats the working list. A scope clash marks each
    // conflicting row with a red outline, and every row carries its state in the hover title.
    const conflicts = new Map();
    for (const pair of Array.isArray(data.clashes) ? data.clashes : []) {
      for (const name of pair) {
        const others = conflicts.get(name) || [];
        for (const other of pair) if (other !== name && !others.includes(other)) others.push(other);
        conflicts.set(name, others);
      }
    }

    const legend = root.createDiv({ cls: 'plan-legend' });
    // Done specs have no place on the remaining-effort axis; each sits left of zero, ending at it.
    const done = this.plugin.settings.showDone
      ? doneItems.map(item => ({ ...item, status: 'implemented', start: -(Number(item.effort) || 1), end: 0 }))
        .sort((a, b) => String(a.updated || '').localeCompare(String(b.updated || '')) || String(a.name).localeCompare(String(b.name)))
      : [];
    const offset = Math.max(0, ...done.map(item => -item.start));
    for (const [kind, label] of [['is-ready', 'ready'], ['is-claimed', 'working'], ['is-stale', 'stale claim'], ['is-waiting', 'waiting'], ['is-blocked', 'blocked'], ...(done.length ? [['is-done', 'done with proof reference'], ['is-unproven', 'done, no proof']] : [])]) {
      const item = legend.createSpan({ cls: 'plan-legend-item' });
      item.createSpan({ cls: 'plan-swatch ' + kind });
      item.appendText(label);
    }

    const scale = Number(this.plugin.settings.scale) || DEFAULT_SETTINGS.scale;
    const maxEnd = Math.max(1, ...rows.map(r => Number(r.end) || 0));
    const width = Math.max(420, Math.ceil((offset + maxEnd) * scale));
    const scroll = root.createDiv({ cls: 'plan-scroll' });
    const chart = scroll.createDiv({ cls: 'plan-chart' });
    chart.style.setProperty('--plan-plot-width', width + 'px');

    const axis = chart.createDiv({ cls: 'plan-axis' });
    axis.createDiv({ cls: 'plan-axis-title', text: 'effort units →' });
    const track = axis.createDiv({ cls: 'plan-axis-track' });
    track.style.width = width + 'px';
    const step = axisStep(offset + maxEnd);
    for (let u = -Math.floor(offset / step) * step; u <= maxEnd; u += step) {
      const tick = track.createDiv({ cls: 'plan-tick' });
      tick.style.left = ((offset + u) * scale) + 'px';
      tick.createEl('span', { text: String(u) });
    }

    const ordered = [...rows].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0) || (Number(a.wave) || 0) - (Number(b.wave) || 0) || String(a.name).localeCompare(String(b.name)));
    for (const row of done) this.renderRow(chart, row, scale, width, null, offset);
    for (const row of ordered) this.renderRow(chart, row, scale, width, claims.get(row), offset, conflicts.get(row.name) || []);
  }

  renderRow(chart, row, scale, width, claim, offset = 0, conflicts = []) {
    const isDone = row.status === 'implemented';
    const line = chart.createDiv({ cls: 'plan-row' + (isDone ? ' is-done' : '') + (conflicts.length ? ' is-error' : '') });
    const label = line.createDiv({ cls: 'plan-label' });
    const link = label.createEl('a', { cls: 'plan-name', text: row.name });
    link.onclick = event => { event.preventDefault(); this.openNote(row.path); };
    const scope = Array.isArray(row.paths) && row.paths.length ? `${row.paths.length} path${row.paths.length === 1 ? '' : 's'}` : 'scope unset';
    label.createDiv({ cls: 'plan-meta', text: isDone
      ? `${row.category} · ${row.effort ?? 1}u · done${row.updated ? ' ' + row.updated : ''} · ${row.proven ? 'proof reference' : 'no proof reference'}`
      : `${row.category} · w${row.wave} · ${row.effort}u · ${row.held || 'ready'} · ${scope}${claim ? ' · ' + claimLabel(claim) : ''}` });
    label.title = isDone
      ? `${row.name}\ndone · ${row.effort ?? 1}u · ${row.proven ? 'proof reference' : 'no proof reference'}${row.updated ? '\n' + row.updated : ''}`
      : `${row.name}\n${row.effort}u · ${row.start}–${row.end} · ${row.held || 'ready'}${row.owner ? '\nworking: ' + row.owner + ' · ' + claimLabel(claim) : ''}${Array.isArray(row.paths) && row.paths.length ? '\npaths ' + row.paths.join(', ') : '\nscope unset'}${conflicts.length ? '\nconflicts with ' + conflicts.join(', ') : ''}`;
    const track = line.createDiv({ cls: 'plan-track' });
    track.style.width = width + 'px';
    track.createDiv({ cls: 'plan-zero' }).style.left = offset * scale + 'px';
    const bar = track.createDiv({ cls: 'plan-bar ' + barClass(row, claim) });
    bar.style.left = (offset + (Number(row.start) || 0)) * scale + 'px';
    bar.style.width = Math.max(6, (Number(row.effort) || 1) * scale) + 'px';
    bar.title = isDone ? `${row.name}\ndone · ${row.effort ?? 1}u · ${row.proven ? 'proof reference' : 'no proof reference'}${row.updated ? '\n' + row.updated : ''}` : `${row.name}\n${row.effort}u · ${row.start}–${row.end}${row.after && row.after.length ? '\nafter ' + row.after.join(', ') : ''}${row.owner ? '\nowner ' + row.owner : ''}${claim ? '\n' + claimLabel(claim) : ''}${row.blocked ? '\nblocked ' + row.blocked : ''}${Array.isArray(row.paths) && row.paths.length ? '\npaths ' + row.paths.join(', ') : '\nscope unset'}`;
    bar.onclick = () => this.openNote(row.path);
  }

  openNote(path) {
    if (!path) return;
    this.app.workspace.openLinkText(path, '', false);
  }

  async setScale(value) {
    this.plugin.settings.scale = Math.min(40, Math.max(12, value));
    await this.plugin.saveSettings();
    this.render();
  }
}

function basePathOf(app) {
  try {
    const adapter = app?.vault?.adapter;
    if (adapter && typeof adapter.getBasePath === 'function') return adapter.getBasePath();
    return adapter?.basePath || null;
  } catch { return null; }
}

function sinceOf(app, row) {
  if (row.since) return row.since;
  try {
    const file = app.vault.getAbstractFileByPath(row.path);
    return file ? app.metadataCache.getFileCache(file)?.frontmatter?.since ?? null : null;
  } catch { return null; }
}

const STALE_MS = 15 * 60 * 1000;

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null || value === '') return null;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? at : null;
}

function unitSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
}

function parseHeartbeat(text, row) {
  try {
    const heartbeat = JSON.parse(text);
    if (heartbeat.unit !== row.name || heartbeat.owner !== row.owner) return null;
    return timestamp(heartbeat.at);
  } catch {
    return null;
  }
}

function claimState(row, { since, heartbeat, now = Date.now() } = {}) {
  const started = timestamp(since);
  const beat = timestamp(heartbeat);
  const last = Math.max(started || 0, beat || 0) || null;
  const age = last == null ? null : Math.max(0, now - last);
  return { since: started, heartbeat: beat, last, age, stale: age != null && age > STALE_MS };
}

function formatAge(ms) {
  if (ms == null) return 'age unknown';
  if (ms < 60 * 1000) return 'just now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function claimLabel(state) {
  if (!state || state.last == null) return 'age unknown';
  return state.stale ? `stale ${formatAge(state.age)}` : `active ${formatAge(state.age)}`;
}

// The vault is vault inside the checkout; workflow state lives at the checkout root.
// Walk up to the nearest ancestor holding vault/00 Meta, the same rule workflow.mjs uses.
function checkoutRoot(basePath) {
  const fs = require('fs');
  const path = require('path');
  let dir = path.resolve(basePath);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'dev', 'vault', '00 Meta'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function heartbeatOf(basePath, row) {
  if (!basePath) return null;
  try {
    // Obsidian desktop plugins run in Electron's Node context. On a host without
    // the workflow state, the claim falls back to its frontmatter `since` stamp.
    const fs = require('fs');
    const path = require('path');
    const root = checkoutRoot(basePath);
    if (!root) return null;
    const file = path.join(root, '.workflow', 'units',
      `${unitSlug(row.name)}-${row.owner}`, 'heartbeat.json');
    return parseHeartbeat(fs.readFileSync(file, 'utf8'), row);
  } catch { return null; }
}

function claimFor(app, row, basePath, now) {
  return claimState(row, { since: sinceOf(app, row), heartbeat: heartbeatOf(basePath, row), now });
}

function barClass(row, claim) {
  if (row.status === 'implemented') return row.proven === false ? 'is-unproven' : 'is-done';
  if (row.blocked) return 'is-blocked';
  if (row.owner) return claim?.stale ? 'is-stale' : 'is-claimed';
  if (row.held) return 'is-waiting';
  return 'is-ready';
}

function axisStep(max) {
  for (const step of [1, 2, 5, 10, 20, 50, 100]) if (max / step <= 10) return step;
  return Math.ceil(max / 10);
}

class PlanSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName('Pixels per effort unit')
      .setDesc('How wide one friction unit is in the chart.')
      .addSlider(slider => slider
        .setLimits(12, 40, 1)
        .setValue(this.plugin.settings.scale)
        .setDynamicTooltip()
        .onChange(async value => { this.plugin.settings.scale = value; await this.plugin.saveSettings(); await this.plugin.refresh(); }));
    new Setting(containerEl)
      .setName('Show done')
      .setDesc('Show implemented specs as grayed rows in the chart, left of the zero line.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showDone)
        .onChange(async value => { this.plugin.settings.showDone = value; await this.plugin.saveSettings(); await this.plugin.refresh(); }));
  }
}

class PlanPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.views = new Set();
    this.registerView(VIEW, leaf => new PlanView(leaf, this));
    this.addRibbonIcon('git-fork', 'Plan: effort view', () => this.activateView());
    this.addCommand({ id: 'open-effort-view', name: 'Open effort view', callback: () => this.activateView() });
    this.addSettingTab(new PlanSettingTab(this.app, this));
    const refresh = file => {
      if (file.path !== PLAN_DATA && !file.path.endsWith('.md')) return;
      for (const view of this.views) { view.sourceCache?.delete(file.path); view.render().catch(error => console.error('plan-view: render failed', error)); }
    };
    this.registerEvent(this.app.vault.on('modify', refresh));
    this.registerEvent(this.app.vault.on('create', refresh));
    this.registerEvent(this.app.vault.on('delete', refresh));
    this.registerEvent(this.app.vault.on('rename', refresh));
  }

  onunload() { this.app.workspace.detachLeavesOfType(VIEW); }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async refresh() {
    for (const view of this.views) await view.render();
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
}

module.exports = PlanPlugin;
module.exports.PlanView = PlanView;
module.exports.claimState = claimState;
module.exports.claimLabel = claimLabel;
module.exports.unitSlug = unitSlug;
module.exports.checkoutRoot = checkoutRoot;
module.exports.heartbeatOf = heartbeatOf;
module.exports.STALE_MS = STALE_MS;
module.exports.barClass = barClass;
module.exports.sourceState = sourceState;
