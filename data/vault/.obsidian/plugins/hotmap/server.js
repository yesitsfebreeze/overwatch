'use strict';
// Loopback server for the hotmap page, shared by the plugin and its node check.
//
// view.html fetches index.json next to itself, so the page must be served from a real origin:
// /codebase/view.html maps onto the plugin's page and /codebase/index.json is the merged map;
// graph-core.js and cube.js come from this plugin folder. The loopback origin also gives the
// iframe the secure context WebGPU needs (127.0.0.1 counts).
//
// Two injections keep the page useful without editing the file on disk:
//  - `theme`: the app's palette, so the cube matches the vault.
//  - `?part=cube`: hide the page's own sidebar (the app's right-sidebar panel shows those lists
//    instead) and bridge picks back to the host with postMessage.
const fs = require('fs');
const http = require('http');
const path = require('path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8' };
const SAFE = /[^#a-zA-Z0-9(),.%\s-]/g;
const SERVED = new Set(['graph-core.js', 'cube.js']);

// The merge lives in this folder (`map-merge.js`); the repository's dev/tools/hotmap re-exports it,
// so Jev and the viewer cannot drift.
function mergeSrc(repo) { return require('./map-merge.js').mergeSrc(repo); }

// Walk up from a candidate (the vault, or this folder inside it) to the checkout that holds the
// vault as <repo>/.overwatch/vault.
function repoRoot(start) {
  let dir = start;
  for (let i = 0; i < 10 && dir; i++) {
    if (fs.existsSync(path.join(dir, '.overwatch', 'vault'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// The page's palette, keyed by the theme map the host returns. Unknown or missing values are dropped.
function themeCss(theme) {
  if (!theme || !theme.bg) return '';
  const v = k => String(theme[k] || '').replace(SAFE, '').trim();
  const vars = [['bg', 'bg'], ['fg', 'fg'], ['panel', 'panel'], ['card', 'card'], ['line', 'line'], ['mute', 'mute'], ['accent', 'accent'], ['accentSoft', 'accent-soft']]
    .filter(([k]) => v(k)).map(([k, name]) => `--${name}:${v(k)}`).join(';');
  return `<style>:root{${vars}}html,body,#app,aside,#stage{background:var(--bg) !important;color:var(--fg) !important}</style>`;
}

// Cube-only page: the page's sidebar and its list column go away, the canvas keeps the tab.
// The peel slider keeps its control but loses the page's labels and its column border.
const CUBE_ONLY = '<style>aside{display:none !important}#app{grid-template-columns:1fr 44px !important}'
  + '#peelcol{border:0 !important;background:transparent !important;padding:8px 0 !important}'
  + '#peelcol span{display:none !important}'
  + 'html,body,#stage{background:var(--bg) !important}</style>';

// Same cube-only chrome, but the page stops painting a background at all, so the canvas alpha has
// something to show through. Only works where the compositor honours canvas alpha.
const CUBE_TRANSPARENT = CUBE_ONLY.replace('html,body,#stage{background:var(--bg) !important}',
  'html,body,#app,#stage{background:transparent !important}');

// Obsidian's compositor draws the WebGPU canvas opaque, so the page background behind it never
// shows through: the render pass has to clear to the theme colour instead. cube.js is served from
// the checkout, so patch the clear value on the way out rather than editing the file on disk.
const CLEAR = /clearValue:\s*\{\s*r:\s*0,\s*g:\s*0,\s*b:\s*0,\s*a:\s*0\s*\}/;
function clearOf(theme) {
  const css = String((theme && theme.bg) || '').trim();
  const round = n => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    const n = parseInt(h, 16);
    return `clearValue: { r: ${round(((n >> 16) & 255) / 255)}, g: ${round(((n >> 8) & 255) / 255)}, b: ${round((n & 255) / 255)}, a: 1 }`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(css);
  if (rgb) return `clearValue: { r: ${round(+rgb[1] / 255)}, g: ${round(+rgb[2] / 255)}, b: ${round(+rgb[3] / 255)}, a: 1 }`;
  return null;
}

// Picks inside the cube are reported to the host so the right-sidebar panel can follow them.
// Picks inside the cube go to the host panel; a select from the panel comes back the other way.
// It hooks the two globals the page assigns (GraphCore, HotCube) instead of editing the page,
// and paints the host's background from `?bg=`, which beats any cached stylesheet.
const PICK_BRIDGE = `<script>(()=>{
let hc,gc,want='';
const bg=new URLSearchParams(location.search).get('bg');
const paint=()=>{if(!bg)return;const put=(el,k)=>{if(el)el.style.setProperty(k,bg,'important')};
put(document.documentElement,'background');put(document.body,'background');
put(document.getElementById('stage'),'background');put(document.getElementById('app'),'background');};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',paint);else paint();
const say=(type,n)=>{try{parent.postMessage({hotmap:type,name:n?n.pkg+'.'+n.name:null},'*');}catch(e){}};
Object.defineProperty(window,'HotCube',{configurable:true,get:()=>hc,set:v=>{hc=v;const view=v&&v.view;if(typeof view!=='function')return;
v.view=function(...a){const o=Object.assign({},a[2]||{});const pick=o.onPick;
o.onPick=n=>{if(pick)pick(n);say('pick',n);};a[2]=o;
return view.apply(v,a).then(c=>{window.__cube=c;return c;});};}});
Object.defineProperty(window,'GraphCore',{configurable:true,get:()=>gc,set:v=>{gc=v;const build=v&&v.build;if(typeof build!=='function')return;
v.build=function(...a){const g=build.apply(v,a);window.__graph=g;if(want||wantSimilar)apply(want,wantDesc,wantSorts,wantSimilar);return g;};}});
let wantDesc=true,wantSorts=['hot','callers','tests'],wantSimilar=0;
function apply(text,descIn,sortsIn,similarIn){
want=String(text||'');
if(typeof similarIn==='number')wantSimilar=similarIn;
if(typeof descIn==='boolean')wantDesc=descIn;
if(Array.isArray(sortsIn)&&sortsIn.length===3)wantSorts=sortsIn.slice(0,3);
let tries=0;
const run=()=>{
const G=window.GraphCore,g=window.__graph,c=window.__cube;
if(!G||!g||!c||!c.set){if(tries++<60)return setTimeout(run,50);return;}
// The cube is the search result: box size follows list rank (the first result is the biggest, then
// a 1/rank ladder), and each axis follows one of the panel's three sort keys, so the geometry stays
// aligned with the list. Nothing else feeds the layout.
if(!hc.layoutRank){if(tries++<60)return setTimeout(run,50);return;}
// graph-core's order, the same call the panel makes, so the list and the cube cannot drift.
const rows=G.order(g.nodes,{sorts:wantSorts,desc:wantDesc,filter:want,minSimilar:wantSimilar});
// Rank along each sort key: larger key = earlier result = nearer the low corner, so flipping the
// list to worst first puts the worst row there and the axis labels flip with it.
const rank=wantSorts.map(k=>{const ordered=G.order(rows,{sorts:[k],desc:wantDesc});const at=new Map();ordered.forEach((n,i)=>at.set(n,ordered.length-i));return at;});
c.set(hc.layoutRank(rows.map(n=>({ref:n,keys:rank.map(at=>at.get(n))}))));
if(c.order)c.order(rows);
if(c.links)c.links(g.nodes.flatMap(n=>n.out.map(o=>[n,o])));
if(c.axis)c.axis(wantSorts.map(k=>k==='name'?'name':(G.METRICS[k]&&G.METRICS[k].label)||k),wantDesc);
};
run();
}
addEventListener('message',e=>{const d=e.data;if(!d)return;
if(d.hotmap==='filter'){apply(d.text,d.desc,d.sorts,d.similar);return;}
if(d.hotmap!=='select')return;
const g=window.__graph,c=window.__cube;if(!g||!c||!c.select)return;
const n=g.nodes.find(x=>window.GraphCore.qualified(x)===d.name);if(n){c.select(n);c.hover(n);}});
})();</script>`;

class MapServer {
  constructor(repo, opts) {
    this.dir = __dirname;
    this.maps = path.join(repo, '.mosaic', 'map');
    this.theme = (opts && opts.theme) || null;
    this.transparent = (opts && opts.transparent) || null;
    // The page and its two scripts live in this folder; the checkout only supplies the map.
    this.page = (opts && opts.page) || path.join(__dirname, 'view.html');
    this.port = 0;
    this.srv = null;
    this.ready = new Promise((resolve, reject) => {
      this.srv = http.createServer((req, res) => this.handle(req, res));
      this.srv.on('error', reject);
      this.srv.listen(0, '127.0.0.1', () => { this.port = this.srv.address().port; resolve(this.port); });
    });
  }
  stop() { if (this.srv) { this.srv.close(); this.srv = null; } }
  url(program, part) { return `http://127.0.0.1:${this.port}/${encodeURIComponent(program)}/view.html?part=${part || 'cube'}`; }
  handle(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const parts = u.pathname.split('/').filter(Boolean);
    const program = decodeURIComponent(parts[0] || '');
    const file = path.basename(decodeURIComponent(parts[1] || 'view.html'));
    if (file === 'index.json') {
      // One merged map is served; per-program maps are build inputs.
      const { CODEBASE, mergeMaps } = require('./map-merge.js');
      if (program !== CODEBASE) { res.writeHead(404); res.end('not found: index.json is served only under codebase'); return; }
      const doc = mergeMaps(this.maps);
      if (!doc.symbols.length) { res.writeHead(404); res.end('not found: no src map'); return; }
      const body = Buffer.from(JSON.stringify(doc));
      res.writeHead(200, { 'content-type': TYPES['.json'], 'content-length': body.length, 'cache-control': 'no-store' });
      res.end(body); return;
    }
    // Only the page and the two scripts it loads; the folder also holds the plugin and its settings.
    const target = file === 'view.html' ? this.page : SERVED.has(file) ? path.join(this.dir, file) : null;
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end('not found: ' + file); return; }

    let body = fs.readFileSync(target);
    const transparent = !!(this.transparent && this.transparent());
    if (path.extname(target) === '.html') {
      let inject = '';
      try { inject += themeCss(this.theme && this.theme()); } catch (e) { /* theme is cosmetic */ }
      if (u.searchParams.get('part') === 'cube') inject += (transparent ? CUBE_TRANSPARENT : CUBE_ONLY) + PICK_BRIDGE;
      if (inject) body = Buffer.from(body.toString('utf8').replace('</head>', inject + '</head>'), 'utf8');
    } else if (file === 'cube.js' && this.theme && !transparent) {
      let clear = null;
      try { clear = clearOf(this.theme()); } catch (e) { clear = null; }
      if (clear) body = Buffer.from(body.toString('utf8').replace(CLEAR, clear), 'utf8');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  }
}

module.exports = { MapServer, repoRoot, themeCss, mergeSrc };
