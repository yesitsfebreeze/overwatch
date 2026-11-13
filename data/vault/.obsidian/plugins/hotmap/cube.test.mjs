// Self-check for cube.js, the 3D treemap: every procedure gets exactly one leaf box, leaf volume
// is proportional to hotness, leaves tile the root cube, children lie inside their parent, the
// hottest procedure gets the biggest box, and a 75k-procedure layout stays fast.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('./cube.js');
const vol = c => c.size[0] * c.size[1] * c.size[2];
// Every corner names one term: best at the all-low corner, worst at the all-high corner, and the
// one odd axis with its sign on the six sides. The value name is the selected sort key.
{
  const labels = C.cornerLabels(['hotness', 'callers', 'tests']);
  const expected = [
    [0, [-1, -1, -1], 'best'],
    [1, [1, -1, -1], '-hotness'],
    [2, [-1, 1, -1], '-callers'],
    [3, [1, 1, -1], '+tests'],
    [4, [-1, -1, 1], '-tests'],
    [5, [1, -1, 1], '+callers'],
    [6, [-1, 1, 1], '+hotness'],
    [7, [1, 1, 1], 'worst'],
  ];
  assert.equal(labels.length, 8, 'one label per cube corner');
  const byMask = new Map(labels.map(l => [l.mask, l]));
  for (const [mask, corner, text] of expected) {
    const label = byMask.get(mask);
    assert.ok(label, `corner ${mask} has a label`);
    assert.deepEqual(label.corner, corner, `corner ${mask} coordinates`);
    assert.equal(label.text, text, `corner ${mask} names one term`);
  }
  assert.ok(labels.every(l => !l.text.includes(' · ')), 'one term per label');
  // The panel/view axis update feeds the new keys back through cornerLabels.
  const changed = C.cornerLabels(['PageRank', 'callees', 'name']);
  assert.equal(changed[1].text, '-PageRank', 'the selected key names the side corner');
  assert.equal(changed[0].text, 'best', 'poles stay best whatever the keys');
  assert.equal(changed[7].text, 'worst', 'poles stay worst whatever the keys');
}
// Flipped to worst first, the low corner holds the worst row, so the poles and every side sign
// flip with it.
{
  const labels = C.cornerLabels(['hotness', 'callers', 'tests'], false);
  const byMask = new Map(labels.map(l => [l.mask, l]));
  assert.equal(byMask.get(0).text, 'worst', 'low corner is worst once the list is flipped');
  assert.equal(byMask.get(7).text, 'best', 'high corner is best once the list is flipped');
  assert.equal(byMask.get(1).text, '+hotness', 'side signs flip with the poles');
  assert.equal(byMask.get(3).text, '-tests', 'the odd axis keeps its name, the sign flips');
  assert.equal(byMask.get(5).text, '-callers', 'every side corner flips');
}
function check(n, seed) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const items = Array.from({ length: n }, (_, i) => ({ hot: 1 + Math.floor(rnd() ** 4 * 5000), callers: 0, callees: 0, ref: i }));
  const t0 = performance.now(); const m = C.layout(items); const ms = performance.now() - t0;
  const total = items.reduce((a, x) => a + x.hot, 0);
  assert.equal(m.leaves.length, n, 'one leaf per procedure');
  assert.equal(new Set(m.leaves.map(c => c.item)).size, n);
  let sum = 0, worst = 1;
  for (const c of m.leaves) {
    sum += vol(c);
    assert.ok(Math.abs(vol(c) - c.item.hot / total * 8) < 1e-9 + 1e-6 * vol(c), 'volume ∝ hotness');
    for (let a = 0; a < 3; a++) assert.ok(c.min[a] >= -1 - 1e-9 && c.min[a] + c.size[a] <= 1 + 1e-9, 'inside the root');
    if (vol(c) > 1e-4) worst = Math.max(worst, Math.max(...c.size) / Math.min(...c.size));
  }
  assert.ok(Math.abs(sum - 8) < 1e-6, 'leaves tile the cube');
  const hottest = m.leaves.reduce((a, b) => (b.item.hot > a.item.hot ? b : a));
  assert.ok(Math.max(...m.leaves.map(vol)) - vol(hottest) < 1e-12, 'hottest procedure is the biggest box');
  assert.equal(m.cells[0].depth, 0); assert.equal(m.cells[0].count, n);
  return { n, levels: m.levels, boxes: m.cells.length, worstAspect: worst.toFixed(1), ms: ms.toFixed(1) };
}
// Each axis follows its own key: with three independent keys, a leaf's position along each axis
// tracks its rank in that axis's key (larger keys nearer -1) and not the other two.
{
  let s = 7; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const items = Array.from({ length: 4000 }, (_, i) => ({ weight: 1, keys: [rnd(), rnd(), rnd()], ref: i }));
  const m = C.layout(items);
  const corr = (xs, ys) => { const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    let sxy = 0, sxx = 0, syy = 0; xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; }); return sxy / Math.sqrt(sxx * syy); };
  for (let a = 0; a < 3; a++) for (let k = 0; k < 3; k++) {
    const r = corr(m.leaves.map(c => c.min[a] + c.size[a] / 2), m.leaves.map(c => c.item.keys[k]));
    if (a === k) assert.ok(r < -0.9, `axis ${a} follows key ${k}: r=${r.toFixed(2)}`);
    else assert.ok(Math.abs(r) < 0.1, `axis ${a} ignores key ${k}: r=${r.toFixed(2)}`);
  }
}
assert.equal(C.instances(C.layout([{ hot: 1, ref: 0 }, { hot: 3, ref: 1 }])).length, 2 * 16, 'one instance per procedure, no inner boxes');
// Peel follows the caller's list: one leaf per step, in list order; omitted leaves peel last.
{
  const m = C.layout([{ hot: 3, ref: 'a' }, { hot: 2, ref: 'b' }, { hot: 1, ref: 'c' }]);
  C.peelOrder(m, ['c', 'a']);
  assert.equal(m.byRef.get('c').order, 0, 'first list row peels first');
  assert.equal(m.byRef.get('a').order, 1, 'next row peels next');
  assert.equal(m.byRef.get('b').order, 2, 'a leaf the list omits peels last');
  assert.ok(m.leaves.every(c => c.order < m.leaves.length), 'the slider end hides every leaf');
}
// Node mode places every leaf by its own axis keys, not by its box centre: the largest key sits at
// -1, the smallest at +1, and ties share their average rank.
{
  const m = C.layout([
    { ref: 'a', weight: 1, keys: [3, 0, 5] },
    { ref: 'b', weight: 1, keys: [1, 0, 5] },
    { ref: 'c', weight: 1, keys: [2, 1, 5] },
  ]);
  const p = C.cloudPoints(m), at = ref => {
    const i = m.leaves.findIndex(c => c.item.ref === ref);
    return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  };
  assert.deepEqual(at('a'), [-1, 0.5, 0], 'largest x key at the -1 end, y tie at the average rank');
  assert.deepEqual(at('b'), [1, 0.5, 0], 'smallest x key at the +1 end');
  assert.deepEqual(at('c'), [0, -1, 0], 'middle x key centred, largest y key at -1');
  assert.ok(m.leaves.every(c => Array.isArray(c.dot) && c.dot.length === 3), 'each leaf keeps its dot position');
  assert.ok(p.every(v => v >= -1 && v <= 1), 'every position sits inside the cube');
}
// Node-mode relaxation: a point glides to its own value position, stays inside the cube, and a
// call edge pulls its ends together.
{
  const t = new Float32Array([-1, 0, 0, 1, 0, 0]);
  const p = new Float32Array(6);
  for (let i = 0; i < 200; i++) C.stepCloud(p, t, null, { perCell: 0 });
  assert.ok(Math.abs(p[0] + 1) < 0.02 && Math.abs(p[1]) < 0.02, 'the point glides to its value position');
  assert.ok(Math.abs(p[3] - 1) < 0.02, 'every point reaches its own value position');
  assert.ok(p.every(v => v >= -1 && v <= 1), 'points stay inside the cube');
  const q = new Float32Array([-1, 0, 0, 1, 0, 0]);
  const before = q[3] - q[0];
  for (let i = 0; i < 200; i++) C.stepCloud(q, t, Int32Array.from([0, 1]), { perCell: 0 });
  assert.ok(q[3] - q[0] < before, 'a call edge pulls its ends together');
}
// opts.total makes box sizes a share of the whole mass: the same items measured against twice their
// total occupy (1/2)³ of the volume, shrunk about the origin rather than refilling the frame.
{
  const items = [{ hot: 1, ref: 0 }, { hot: 3, ref: 1 }];
  const full = C.layout(items), part = C.layout(items, { total: 8 });
  assert.equal(full.scale, 1);
  assert.equal(part.scale, 0.5);
  assert.deepEqual(part.cells[0].min, [-0.5, -0.5, -0.5], 'root shrinks about the origin');
  const sum = m => m.leaves.reduce((s, c) => s + vol(c), 0);
  assert.ok(Math.abs(sum(part) / sum(full) - 0.125) < 1e-9, 'volume follows share³');
}
// Instances reach the GPU far first: with the view looking down -z, camera depth is the box centre's
// z, so reorder must emit non-increasing depth and the near boxes end up on top.
{
  const cells = [
    { min: [0, 0, -1], size: [1, 1, 1], depth: 0, order: 0 },
    { min: [0, 0, 0.5], size: [1, 1, 1], depth: 0, order: 1 },
    { min: [0, 0, 0], size: [1, 1, 1], depth: 0, order: 2 },
  ];
  const m = { cells, leaves: cells, levels: 1 };
  const base = C.instances(m), out = new Float32Array(base.length);
  const order = new Uint32Array(cells.length), depth = new Float32Array(cells.length);
  C.reorder(base, out, m, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]), order, depth);
  const cz = i => out[i * 16 + 2] + out[i * 16 + 5] / 2;
  assert.deepEqual([0, 1, 2].map(cz), [1, 0.5, -0.5], 'far boxes first, near last');
}
// The diagonal turntable keeps the low corner up: the base orientation maps (-1,-1,-1) to +y and the
// spin leaves it fixed, so (1,1,1), worst on all three axes, stays down for every theta.
{
  const s = 1 / Math.sqrt(3), u = [-s, -s, -s];
  const apply = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  for (const t of [0, 0.7, 2.4, -1.3]) {
    const up = apply(C.diagonalView(t), u);
    assert.ok(Math.abs(up[0]) < 1e-9 && Math.abs(up[1] - 1) < 1e-9 && Math.abs(up[2]) < 1e-9, `corner up at theta ${t}: ${up.map(x => x.toFixed(3))}`);
    const down = apply(C.diagonalView(t), u.map(x => -x));
    assert.ok(Math.abs(down[1] + 1) < 1e-9, `opposite corner down at theta ${t}`);
  }
}
// Rank layout: size is list order. The first entry is the biggest leaf, each next one a 1/rank
// share, and given keys the three axes follow them so the cube stays aligned with the search order.
{
  const items = ['a', 'b', 'c', 'd'].map(ref => ({ ref }));
  const m = C.layoutRank(items);
  const vol = c => c.size[0] * c.size[1] * c.size[2];
  assert.equal(m.leaves.length, 4, 'one leaf per item');
  const first = m.leaves.find(c => c.item.ref === 'a');
  const sum = m.leaves.reduce((s, c) => s + vol(c), 0);
  assert.ok(Math.abs(vol(first) / sum - 1 / (1 + 1 / 2 + 1 / 3 + 1 / 4)) < 1e-9, 'first entry takes 1/rank of the volume');
  const top = m.leaves.slice().sort((x, y) => vol(y) - vol(x));
  assert.equal(top[0].item.ref, 'a', 'the first entry is the biggest leaf');
  for (let i = 1; i < top.length; i++) assert.ok(vol(top[i - 1]) > vol(top[i]), 'sizes scale down with rank');
  // Axis keys steer the three axes: layoutRank passes them to layout unchanged.
  const keyed = ['a', 'b', 'c', 'd'].map((ref, i) => ({ ref, keys: [i, 3 - i, i % 2] }));
  const direct = C.layout(keyed.map((x, i) => ({ ref: x.ref, weight: 1 / (i + 1), keys: x.keys })));
  const cells = model => new Map(model.leaves.map(c => [c.item.ref, c]));
  const got = cells(C.layoutRank(keyed)), want = cells(direct);
  for (const ref of ['a', 'b', 'c', 'd']) assert.deepEqual(got.get(ref).min, want.get(ref).min, `axis keys passed through for ${ref}`);
  assert.ok(vol(got.get('a')) > vol(got.get('d')), 'size still follows list rank');
}
console.log('cube: ok', check(1, 1), check(15, 2), check(6000, 3), check(75000, 4));
