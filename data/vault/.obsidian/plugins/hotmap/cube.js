// Hotness cube: the flat treemap wrapped inside itself in 3D, drawn with WebGPU.
// The root cube is the whole program. Every box splits into up to 8 children (2×2×2): one cut per axis,
// x then y then z. Each cut sorts the box's procedures by that axis's own key, most important first,
// and splits them into two runs of equal summed weight, the low side getting the important run. So
// each axis means one metric (position along x is rank in key x, and so on), while every box's volume
// is its weight share and a heavy procedure still gets a big box near the outside. Leaves are single
// procedures.
// The GPU draws one instance per leaf box — one procedure, nothing else: a face tinted by position
// and an outline in the same colour. Inner boxes only steer the layout and are never drawn.
// Peeling hides boxes one at a time; the default order is the outer levels, hottest first, and
// `peelOrder` reorders it to follow the caller's list. Marked groups and the hover/selection outline are a 2D
// overlay; picking is a CPU ray cast. `layout`, `instances` and the shader are plain data, so
// node checks them (cube.test.mjs, and the Dawn probe in the README).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HotCube = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Each corner names one term. `+` sits toward the corner that is best on every axis, which is
  // the low corner while the list runs best first (`bestLow`) and the high corner once the list is
  // flipped. The six side corners each name the one axis whose sign differs from the other two;
  // the name is the selected sort key.
  function cornerLabels(names, bestLow = true) {
    const axes = [0, 1, 2].map(i => String((names && names[i]) || 'xyz'[i]));
    const poles = bestLow ? ['best', 'worst'] : ['worst', 'best'];     // [low corner, high corner]
    const sign = low => (low === bestLow ? '+' : '-');
    const labels = [];
    for (let mask = 0; mask < 8; mask++) {
      const corner = [0, 1, 2].map(a => (mask & (1 << a)) ? 1 : -1);
      let text;
      if (mask === 0) text = poles[0];
      else if (mask === 7) text = poles[1];
      else {
        const low = [0, 1, 2].filter(a => corner[a] < 0);
        const odd = low.length === 1 ? low[0] : [0, 1, 2].find(a => corner[a] > 0);
        text = `${sign(corner[odd] < 0)}${axes[odd]}`;
      }
      labels.push({ mask, corner, text });
    }
    return labels;
  }

  // Sort ids by key[axis] (larger first, ties heavier first) and cut them into two runs of about equal
  // weight, the box along `axis` in the same ratio.
  function halve(box, ids, w, keys, axis) {
    const k0 = keys[axis];
    ids = ids.slice().sort((a, b) => k0[b] - k0[a] || w[b] - w[a] || a - b);
    let total = 0; for (const i of ids) total += w[i];
    let k = 0, acc = 0;
    while (k < ids.length - 1 && (k === 0 || acc + w[ids[k]] / 2 <= total / 2)) acc += w[ids[k++]];
    const frac = acc / total, a = { min: box.min.slice(), size: box.size.slice() }, b = { min: box.min.slice(), size: box.size.slice() };
    a.size[axis] = box.size[axis] * frac; b.min[axis] = box.min[axis] + a.size[axis]; b.size[axis] = box.size[axis] - a.size[axis];
    return [[a, ids.slice(0, k)], [b, ids.slice(k)]];
  }

  // items: [{ weight, keys: [x, y, z], ref }] (`hot` is accepted for weight; missing keys sort by weight
  // on every axis). Larger keys sit nearer the low corner (-1,-1,-1). `opts.total` is the mass the box
  // sizes are relative to: pass a larger total than the sum of the weights (the whole program's mass)
  // and the cube shrinks to that share, so a filtered view shows small boxes instead of refilling the
  // frame. Returns { levels, depth, cells, leaves, byRef, scale }. cell: { depth, order,
  // min:[x,y,z], size:[x,y,z], weight, count, item? (leaves) }; cells in the default peel order,
  // which `peelOrder` replaces with the caller's list order.
  function layout(items, opts) {
    const n = items.length, w = items.map(x => Math.max(1e-9, x.weight ?? x.hot));
    const keys = [0, 1, 2].map(a => items.map((x, i) => (x.keys ? x.keys[a] : w[i])));
    const all = items.map((_, i) => i);
    const cells = [], leaves = [], byRef = new Map();
    const sum = w.reduce((a, x) => a + x, 0);
    const scale = opts && opts.total > 0 ? Math.min(1, sum / opts.total) : 1;   // share of the whole mass
    let depth = 0;
    const stack = n ? [[{ min: [-scale, -scale, -scale], size: [2 * scale, 2 * scale, 2 * scale] }, all, 0]] : [];
    while (stack.length) {
      const [box, ids, d] = stack.pop();
      const cell = { depth: d, min: box.min, size: box.size, weight: 0, count: ids.length };
      for (const i of ids) cell.weight += w[i];
      cells.push(cell); depth = Math.max(depth, d);
      if (ids.length === 1) { cell.item = items[ids[0]]; leaves.push(cell); byRef.set(cell.item.ref, cell); continue; }
      let parts = [[box, ids]];
      for (let axis = 0; axis < 3; axis++) parts = parts.flatMap(([b, x]) => x.length > 1 ? halve(b, x, w, keys, axis) : [[b, x]]);
      for (const [b, x] of parts) stack.push([b, x, d + 1]);
    }
    // Peel order: outermost division first, and within a level the heaviest box first. `order` is the
    // box's position in that sequence; peeling k hides the first k boxes, one division at a time.
    cells.sort((a, b) => a.depth - b.depth || b.weight - a.weight);
    cells.forEach((c, i) => { c.order = i; });
    return { levels: depth + 1, depth, cells, leaves, byRef, scale };
  }

  // Rank layout: size follows the list. The first entry gets the largest box and every next one a
  // share 1/rank of that (a Zipf ladder), so important results are large and the tail scales down
  // smoothly instead of every level shrinking by the same ratio. Each axis follows its own `keys`
  // entry when given — the panel passes its three sort keys — so geometry stays aligned with the
  // search order; without keys the list order is the key on all three axes.
  // Items: [{ ref, keys? }] already in list order. Returns the same shape as `layout`.
  function layoutRank(items) {
    return layout(items.map((x, i) => ({ ref: x.ref, weight: 1 / (i + 1), keys: x.keys || [-i, -i, -i] })));
  }

  // Peel order from the caller's list — the sidebar's order. Every drawn box is a leaf, so each
  // step hides one and the slider walks the list row by row; leaves the list omits peel last.
  function peelOrder(model, refs) {
    const at = new Map(refs.map((ref, i) => [ref, i]));
    let next = refs.length;
    for (const c of model.leaves) c.order = at.has(c.item.ref) ? at.get(c.item.ref) : next++;
    return model;
  }

  // Node-mode positions: each leaf placed by its own three axis keys, not by its box centre. Every
  // axis is rank-normalised to [-1,1] with the largest key at -1, the same end the boxes put the
  // most important run, so the cloud is the values themselves. Ties share their average rank. The
  // positions are also written to `cell.dot` for picking and the overlay.
  function cloudPoints(model) {
    const leaves = model.leaves, n = leaves.length, out = new Float32Array(n * 3);
    const key = (c, a) => (c.item.keys ? c.item.keys[a] : (c.item.weight ?? 0));
    for (let a = 0; a < 3; a++) {
      const order = leaves.map((_, i) => i).sort((i, j) => key(leaves[i], a) - key(leaves[j], a) || i - j);
      for (let k = 0; k < n;) {
        let j = k;
        while (j + 1 < n && key(leaves[order[j + 1]], a) === key(leaves[order[k]], a)) j++;
        const t = n > 1 ? 1 - 2 * ((k + j) / 2) / (n - 1) : 0;
        for (let m = k; m <= j; m++) out[order[m] * 3 + a] = t;
        k = j + 1;
      }
    }
    for (let i = 0; i < n; i++) { leaves[i].dot = [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]; leaves[i].dotI = i; }
    return out;
  }

  // One relaxation step for node mode: 75% pull toward each point's own axis-value position, 25%
  // pull along the call edges, plus local repulsion so points do not stack. Mutates and returns
  // `pos` (n*3). The caller runs a fixed number of steps so the cloud glides into place.
  function stepCloud(pos, target, springs, opts) {
    const o = opts || {}, n = pos.length / 3;
    const k = o.step ?? 0.06, tw = o.target ?? 0.75, lw = o.link ?? 0.25;
    const rp = o.repulse ?? 0.0012, C = o.cells ?? 8, per = o.perCell ?? 10;
    for (let i = 0; i < n * 3; i++) pos[i] += (target[i] - pos[i]) * tw * k;
    if (springs) for (let s = 0; s < springs.length; s += 2) {
      const i = springs[s] * 3, j = springs[s + 1] * 3;
      for (let a = 0; a < 3; a++) { const d = (pos[j + a] - pos[i + a]) * lw * k * 0.5; pos[i + a] += d; pos[j + a] -= d; }
    }
    if (per > 0) {
      const cells = new Map(), ci = v => Math.max(0, Math.min(C - 1, Math.floor((v + 1) * 0.5 * C)));
      for (let i = 0; i < n; i++) {
        const key = ci(pos[i * 3]) + C * (ci(pos[i * 3 + 1]) + C * ci(pos[i * 3 + 2]));
        let b = cells.get(key); if (!b) cells.set(key, b = []);
        if (b.length < per) b.push(i);
      }
      for (const b of cells.values()) {
        for (let x = 0; x < b.length; x++) for (let y = x + 1; y < b.length; y++) {
          const i = b[x] * 3, j = b[y] * 3;
          const dx = pos[j] - pos[i], dy = pos[j + 1] - pos[i + 1], dz = pos[j + 2] - pos[i + 2], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1e-4) continue;
          const f = rp * k / Math.max(d2, 0.0025);
          pos[i] -= dx * f; pos[i + 1] -= dy * f; pos[i + 2] -= dz * f;
          pos[j] += dx * f; pos[j + 1] += dy * f; pos[j + 2] += dz * f;
        }
      }
    }
    for (let i = 0; i < n * 3; i++) pos[i] = Math.max(-1, Math.min(1, pos[i]));
    return pos;
  }

  const MAX_MARKED = 400;
  const EDGE_ALPHA = 0.25;   // outlines: the box's own colour at 25% opacity, the same on every level
  const LEAF_ALPHA = 0.06;   // one procedure

  // Hottest red through to coolest violet.
  // Colour is position: each axis drives one channel, full on the low (more-metric) side and dim on
  // the high side. x runs red to cyan, y green to magenta, z blue to yellow; the hottest corner is
  // white, the coldest near black.
  const channel = (lo, size) => 1 - 0.8 * ((lo + size / 2 + 1) / 2);
  const posRgb = c => [0, 1, 2].map(a => channel(c.min[a], c.size[a]));

  // One instance per leaf box — one procedure — 16 floats: min.xyz, depth | size.xyz, peel order |
  // face rgba | edge rgba.
  function instances(model) {
    const out = new Float32Array(model.leaves.length * 16);
    model.leaves.forEach((c, i) => {
      const o = i * 16, face = posRgb(c);
      out.set([c.min[0], c.min[1], c.min[2], c.depth, c.size[0], c.size[1], c.size[2], c.order,
        face[0], face[1], face[2], LEAF_ALPHA, face[0], face[1], face[2], EDGE_ALPHA], o);
    });
    return out;
  }

  // Instance order for the current camera: far boxes first, near ones last, so premultiplied alpha
  // stacks the way the eye expects and the front of the cube wins. `uniforms[8..10]` is the view's
  // z row, so a box's camera depth is that row dotted with its centre. Ceiling: one CPU sort and one
  // 16-float copy per drawn frame; fine at the tens of thousands of boxes a program produces, and it
  // only runs while something moves or the view redraws.
  function reorder(base, out, model, uniforms, order, depth) {
    const cells = model.leaves, n = cells.length;
    if (!n) return;
    const r0 = uniforms[8], r1 = uniforms[9], r2 = uniforms[10];
    for (let i = 0; i < n; i++) {
      const c = cells[i];
      depth[i] = r0 * (c.min[0] + c.size[0] / 2) + r1 * (c.min[1] + c.size[1] / 2) + r2 * (c.min[2] + c.size[2] / 2);
      order[i] = i;
    }
    order.sort((a, b) => depth[b] - depth[a]);
    for (let k = 0; k < n; k++) out.set(base.subarray(order[k] * 16, order[k] * 16 + 16), k * 16);
  }

  const SHADER = /* wgsl */ `
struct U { r0: vec4f, r1: vec4f, r2: vec4f, p: vec4f };   // rotation rows (r0.w = distance, r2.w = 2/viewport width); p = (2f/w, 2f/h, peelLo, peelHi)
@group(0) @binding(0) var<uniform> u: U;
struct I { @location(0) mn: vec4f, @location(1) sz: vec4f, @location(2) face: vec4f, @location(3) edge: vec4f, @location(4) corner: vec3f };
struct DI { @location(1) sz: vec4f, @location(6) at: vec3f };
struct O { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) uv: vec2f };
fn place(p: vec3f) -> vec4f {
  let q = vec3f(dot(u.r0.xyz, p), dot(u.r1.xyz, p), dot(u.r2.xyz, p) + u.r0.w);
  return vec4f(q.x * u.p.x, q.y * u.p.y, 0.5 * q.z, q.z);
}
const HIDDEN = vec4f(0.0, 0.0, 2.0, 1.0);                  // outside the clip volume
@vertex fn vs_face(i: I) -> O {
  var o: O;
  if (i.sz.w < u.p.z || i.sz.w >= u.p.w) { o.pos = HIDDEN; o.col = vec4f(0.0); return o; }
  o.pos = place(i.mn.xyz + i.corner * i.sz.xyz);
  o.col = vec4f(i.face.rgb * i.face.a, i.face.a);
  return o;
}
@vertex fn vs_edge(i: I) -> O {
  var o: O;
  if (i.sz.w < u.p.z || i.sz.w >= u.p.w) { o.pos = HIDDEN; o.col = vec4f(0.0); return o; }
  o.pos = place(i.mn.xyz + i.corner * i.sz.xyz);
  o.col = vec4f(i.edge.rgb * i.edge.a, i.edge.a);
  return o;
}
// Node mode: one round dot per procedure at its own axis values, a constant 2.6 px radius at any
// depth. Colour is position, using the same channel formula as the boxes.
@vertex fn vs_dot(i: DI, @location(5) corner: vec2f) -> O {
  var o: O;
  if (i.sz.w < u.p.z || i.sz.w >= u.p.w) { o.pos = HIDDEN; o.col = vec4f(0.0); return o; }
  let c = place(i.at);
  let rgb = vec3f(1.0) - 0.8 * ((i.at + vec3f(1.0)) * 0.5);
  let a = 0.95;
  o.pos = vec4f(c.xy + corner * 2.6 * u.r2.w * c.w, 0.5 * c.z, c.w);
  o.col = vec4f(rgb * a, a);
  o.uv = corner;
  return o;
}
@fragment fn fs(o: O) -> @location(0) vec4f { return o.col; }
// Round dots: drop the corners of the quad. uv is +-1 at the quad edge, so the unit disc is the dot.
@fragment fn fs_dot(o: O) -> @location(0) vec4f {
  if (dot(o.uv, o.uv) > 1.0) { discard; }
  return o.col;
}
`;

  const VERTS = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const FACES = [[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]];
  const EDGES = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
  const FACE_CORNERS = new Float32Array(FACES.flatMap(([a, b, c, d]) => [a, b, c, a, c, d].flatMap(i => VERTS[i])));
  const EDGE_CORNERS = new Float32Array(EDGES.flatMap(([a, b]) => [...VERTS[a], ...VERTS[b]]));
  const DOT_CORNERS = new Float32Array([-1,-1, 1,-1, 1,1, -1,-1, 1,1, -1,1]);

  // Both pipelines plus their buffers for a model; `draw(encoder, view, uniforms, cloud)` records one
  // frame, either the leaf boxes or the point cloud.
  function gpu(device, format, model) {
    const module = device.createShaderModule({ code: SHADER });
    const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const buffers = [
      { arrayStride: 64, stepMode: 'instance', attributes: [0, 1, 2, 3].map(l => ({ shaderLocation: l, offset: l * 16, format: 'float32x4' })) },
      { arrayStride: 12, stepMode: 'vertex', attributes: [{ shaderLocation: 4, offset: 0, format: 'float32x3' }] },
    ];
    const dotBuffers = [
      { arrayStride: 64, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 16, format: 'float32x4' }] },
      { arrayStride: 8, stepMode: 'vertex', attributes: [{ shaderLocation: 5, offset: 0, format: 'float32x2' }] },
      { arrayStride: 12, stepMode: 'instance', attributes: [{ shaderLocation: 6, offset: 0, format: 'float32x3' }] },
    ];
    const pipeline = (entry, topology, layout, frag = 'fs') => device.createRenderPipeline({ layout: 'auto', primitive: { topology },
      vertex: { module, entryPoint: entry, buffers: layout }, fragment: { module, entryPoint: frag, targets: [{ format, blend }] } });
    const face = pipeline('vs_face', 'triangle-list', buffers), edge = pipeline('vs_edge', 'line-list', buffers);
    const dot = pipeline('vs_dot', 'triangle-list', dotBuffers, 'fs_dot');
    const upload = (data, usage) => { const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, data); return b; };
    const base = instances(model), scratch = new Float32Array(base.length);
    // Boxes draw from `inst`, re-sorted by depth each frame; dots draw from `leafInst`, which stays
    // in leaf order to line up with `dotPos`.
    const inst = upload(base, GPUBufferUsage.VERTEX), leafInst = upload(base, GPUBufferUsage.VERTEX);
    const order = new Uint32Array(model.leaves.length), depth = new Float32Array(model.leaves.length);
    const faceCorners = upload(FACE_CORNERS, GPUBufferUsage.VERTEX), edgeCorners = upload(EDGE_CORNERS, GPUBufferUsage.VERTEX);
    const dotCorners = upload(DOT_CORNERS, GPUBufferUsage.VERTEX);
    const dotPos = upload(cloudPoints(model), GPUBufferUsage.VERTEX);
    const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const group = p => device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }] });
    const faceGroup = group(face), edgeGroup = group(edge), dotGroup = group(dot), count = model.leaves.length;
    return {
      draw(encoder, view, uniforms, cloud) {
        device.queue.writeBuffer(uniform, 0, uniforms);
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
        if (cloud) {
          pass.setVertexBuffer(0, leafInst); pass.setPipeline(dot); pass.setBindGroup(0, dotGroup);
          pass.setVertexBuffer(1, dotCorners); pass.setVertexBuffer(2, dotPos); pass.draw(6, count);
        } else {
          reorder(base, scratch, model, uniforms, order, depth); device.queue.writeBuffer(inst, 0, scratch);
          pass.setVertexBuffer(0, inst); pass.setPipeline(face); pass.setBindGroup(0, faceGroup); pass.setVertexBuffer(1, faceCorners); pass.draw(36, count);
          pass.setPipeline(edge); pass.setBindGroup(0, edgeGroup); pass.setVertexBuffer(1, edgeCorners); pass.draw(24, count);
        }
        pass.end();
      },
      // Re-read the peel order after a caller reordered the leaves; the box count never changes.
      rebase() { base.set(instances(model)); device.queue.writeBuffer(leafInst, 0, base); },
      // Move the dots: the node simulation writes its positions here each frame.
      positions(arr) { device.queue.writeBuffer(dotPos, 0, arr); },
      destroy() { for (const b of [inst, leafInst, faceCorners, edgeCorners, dotCorners, dotPos, uniform]) b.destroy(); },
    };
  }

  // 3×3 row-major rotation matrices.
  function mul(a, b) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return o;
  }
  function axisAngle([x, y, z], a) {
    const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  }

  // Diagonal turntable: the camera spins about the median of the three axes. The base orientation
  // puts the low corner (-1,-1,-1) — best on every axis — at screen up, so (1,1,1), worst on all
  // three, sits at the bottom and the three single-axis bests ring the top. The spin leaves that
  // corner fixed, so it stays up for every `theta`.
  const DIAGONAL = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  const TOP_BASE = (() => {
    const u = DIAGONAL.map(x => -x), ax = [-u[2], 0, u[0]];      // u × [0,1,0]
    const n = Math.hypot(...ax);
    return axisAngle(ax.map(x => x / n), Math.acos(u[1]));
  })();
  const diagonalView = theta => mul(TOP_BASE, axisAngle(DIAGONAL, theta));

  // Interactive view on a WebGPU canvas with a 2D overlay canvas above it (pointer events go to
  // `canvas`). hooks: { onHover(leaf|null), onPick(leaf|null) }. Resolves to null without WebGPU.
  async function view(canvas, overlay, hooks) {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter(); if (!adapter) return null;
    const device = await adapter.requestDevice(), context = canvas.getContext('webgpu'), format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });
    const ctx = overlay.getContext('2d');
    // Peel is a window over the peel order: everything before `peelLo` is hidden from the top of
    // the list and everything from `peelHi` on is hidden from the bottom, so either end can be
    // peeled alone.
    let axisNames = ['hotness', 'callers', 'tests'], cornerText = cornerLabels(axisNames);
    let model = null, scene = null, marks = [], peelLo = 0, peelHi = Infinity, hover = null, picked = null, queued = false, dots = false;
    const hidden = c => c.order < peelLo || c.order >= peelHi;
    // Node mode relaxes the cloud like a graph view: 75% pull toward each point's own axis-value
    // position, 25% pull along call edges, plus local repulsion so points do not stack. It runs for
    // a fixed number of frames, so entering node mode or rearranging glides instead of snapping.
    const SIM = { target: 0.75, link: 0.25, step: 0.06, repulse: 0.0012, cells: 8, perCell: 10, frames: 180 };
    let pos = null, target = null, springs = null, simOn = false, simFrames = 0;
    const dotAt = c => (pos && c.dotI != null) ? [pos[c.dotI * 3], pos[c.dotI * 3 + 1], pos[c.dotI * 3 + 2]] : c.dot;
    // Orientation is a single turntable angle: the cube spins about the median of its three axes,
    // with the low corner (-1,-1,-1) — best on every axis — pinned at the top and (1,1,1), worst on
    // all three, at the bottom. A rotation about that diagonal leaves the corner fixed, so only the
    // base orientation places it and `theta` is the whole camera state. Release keeps spinning with
    // the drag's angular velocity, decaying like Apple's scroll momentum (0.998 per ms, ~2 s to rest).
    let theta = -0.6, R = diagonalView(theta), dist = 4.2, distTarget = 4.2;
    const orient = () => { R = diagonalView(theta); };
    let omega = 0, last = 0, drag = null, moved = false, samples = [];
    const DECEL = 0.998, MIN_SPIN = 2e-5;
    const rot = p => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + dist];
    const unrot = v => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
    const screen = () => { const w = canvas.clientWidth, h = canvas.clientHeight; return { w, h, f: Math.min(w, h) * 0.95, cx: w / 2, cy: h / 2 }; };
    
    function draw() {
      queued = false;
      const { w, h, f, cx, cy } = screen(), dpr = devicePixelRatio || 1;
      for (const c of [canvas, overlay]) if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      if (!scene) return;
      const encoder = device.createCommandEncoder();
      scene.draw(encoder, context.getCurrentTexture().createView(), new Float32Array([R[0], R[1], R[2], dist, R[3], R[4], R[5], 0, R[6], R[7], R[8], 2 / w, 2 * f / w, 2 * f / h, peelLo, peelHi]), dots);
      device.queue.submit([encoder.finish()]);
      // Overlay: marked groups (callers, callees, a package, a cycle), then hover and selection.
      const proj = q => [cx + q[0] * f / q[2], cy - q[1] * f / q[2]], fg = getComputedStyle(overlay).color;
      const outline = (c, color, width) => {
        if (!c || hidden(c)) return;
        if (dots) {
          // Node mode has no boxes: ring the dot at its own axis values.
          const at3 = dotAt(c); if (!at3) return;
          const p = proj(rot(at3));
          ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.stroke();
          return;
        }
        const ps = VERTS.map(v => proj(rot([c.min[0] + v[0] * c.size[0], c.min[1] + v[1] * c.size[1], c.min[2] + v[2] * c.size[2]])));
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
        for (const [a, b] of EDGES) { ctx.moveTo(...ps[a]); ctx.lineTo(...ps[b]); } ctx.stroke();
      };
      for (const [cells, color] of marks) { let drawn = 0; for (const c of cells) { if (drawn >= MAX_MARKED) break; if (!hidden(c)) { outline(c, color, 1.25); drawn++; } } }
      outline(picked, fg, 2.5); if (hover !== picked) outline(hover, '#c8ff00', 2.5);
      // A corner names one term: best at the top pole, worst at the bottom, the odd axis and sign
      // on the six sides. Labels stay centered on their points, so they never jump sides at the
      // midpoint. Side labels draw far to near; the poles draw last so they stay readable.
      ctx.textBaseline = 'middle';
      const pole = l => (l.mask === 0 || l.mask === 7) ? 1 : 0;
      const places = cornerText.map(l => { const q = rot(l.corner); return { ...l, p: proj(q), z: q[2] }; })
        .sort((a, b) => pole(a) - pole(b) || b.z - a.z);
      const placed = [];
      for (const l of places) {
        const top = l.mask === 0, bottom = l.mask === 7;
        const dx = l.p[0] - cx, dy = l.p[1] - cy, len = Math.hypot(dx, dy) || 1;
        let x = l.p[0], y = l.p[1];
        if (top) y -= 18; else if (bottom) y += 18; else { x += dx / len * 20; y += dy / len * 20; }
        ctx.font = top || bottom ? '600 12px system-ui,sans-serif' : '10px system-ui,sans-serif';
        const pad = 4, labelW = ctx.measureText(l.text).width + pad * 2, labelH = (top || bottom ? 15 : 13) + pad * 2;
        let bx, by;
        for (let attempt = 0; attempt < 4; attempt++) {
          bx = x - labelW / 2;
          by = y - labelH / 2;
          bx = Math.max(4, Math.min(w - labelW - 4, bx));
          by = Math.max(4, Math.min(h - labelH - 4, by));
          if (!placed.some(r => bx < r.x + r.w && bx + labelW > r.x && by < r.y + r.h && by + labelH > r.y)) break;
          if (top || bottom) y += top ? -12 : 12; else { x += dx / len * 12; y += dy / len * 12; }
        }
        ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.fillRect(bx, by, labelW, labelH);
        ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.fillText(l.text, bx + pad, by + labelH / 2);
        ctx.beginPath(); ctx.arc(l.p[0], l.p[1], top || bottom ? 3 : 1.8, 0, 7); ctx.fill();
        placed.push({ x: bx, y: by, w: labelW, h: labelH });
      }
    }
    const redraw = () => { if (last || queued) return; queued = true; requestAnimationFrame(draw); };
    function tick(now) {
      const dt = Math.min(64, now - (last || now)); last = now;
      if (!drag && Math.abs(omega) > MIN_SPIN) { theta += omega * dt; orient(); omega *= DECEL ** dt; } else if (!drag) omega = 0;
      dist += (distTarget - dist) * (1 - Math.exp(-dt / 90)); if (Math.abs(distTarget - dist) < 1e-4) dist = distTarget;
      if (simOn) { stepSim(); if (scene) scene.positions(pos); if (--simFrames <= 0) simOn = false; }
      draw();
      if (drag || Math.abs(omega) > MIN_SPIN || dist !== distTarget || simOn) requestAnimationFrame(tick); else last = 0;
    }
    const animate = () => { if (!last) { last = performance.now(); requestAnimationFrame(tick); } };

    // Start the cloud from the current box centres (or wherever it already is) and let it settle.
    function restartSim() {
      simOn = false;
      if (!dots || !model) return;
      const n = model.leaves.length;
      target = cloudPoints(model);
      if (!pos || pos.length !== n * 3) {
        pos = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const c = model.leaves[i];
          pos[i * 3] = c.min[0] + c.size[0] / 2;
          pos[i * 3 + 1] = c.min[1] + c.size[1] / 2;
          pos[i * 3 + 2] = c.min[2] + c.size[2] / 2;
        }
      }
      if (scene) scene.positions(pos);
      simFrames = SIM.frames; simOn = true;
      animate();
    }
    function stepSim() { stepCloud(pos, target, springs, SIM); }

    // Pick: the nearest visible leaf the pointer's ray enters (slab test in model space).
    function at(x, y) {
      if (!model) return null;
      const { f, cx, cy } = screen();
      if (dots) {
        // Node mode picks the nearest dot on screen, not a box along the ray.
        if (!pos) return null;
        let best = null, bestD = 81;
        for (let i = 0; i < model.leaves.length; i++) {
          const c = model.leaves[i];
          if (hidden(c)) continue;
          const q = rot([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]); if (q[2] <= 0.01) continue;
          const d = (cx + q[0] * f / q[2] - x) ** 2 + (cy - q[1] * f / q[2] - y) ** 2;
          if (d < bestD) { bestD = d; best = c; }
        }
        return best;
      }
      const o = unrot([0, 0, -dist]), d = unrot([(x - cx) / f, -(y - cy) / f, 1]);
      let best = null, bestT = Infinity;
      for (const c of model.leaves) {
        if (hidden(c)) continue;
        let t0 = 0, t1 = bestT;
        for (let a = 0; a < 3 && t0 <= t1; a++) {
          const inv = 1 / d[a]; let ta = (c.min[a] - o[a]) * inv, tb = (c.min[a] + c.size[a] - o[a]) * inv;
          if (ta > tb) [ta, tb] = [tb, ta]; t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (t0 <= t1) { best = c; bestT = t0; }
      }
      return best;
    }
    // Pixels to radians: a drag across the short side of the view turns the cube 180°.
    const perPixel = () => Math.PI / Math.max(1, Math.min(canvas.clientWidth, canvas.clientHeight));
    canvas.addEventListener('pointerdown', e => { drag = [e.clientX, e.clientY]; moved = false; omega = 0; samples = [[performance.now(), 0, 0]]; canvas.setPointerCapture(e.pointerId); animate(); });
    canvas.addEventListener('pointermove', e => {
      if (drag) {
        const dx = e.clientX - drag[0], dy = e.clientY - drag[1];
        if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        if (moved) {
          const k = perPixel(); theta += dx * k; orient(); drag = [e.clientX, e.clientY];
          const now = performance.now(); samples.push([now, dx, dy]); while (samples.length > 2 && now - samples[0][0] > 100) samples.shift();
          return;
        }
      }
      const c = at(e.offsetX, e.offsetY); if (c !== hover) { hover = c; redraw(); hooks.onHover(c); }
    });
    canvas.addEventListener('pointerup', e => {
      if (!drag) return;
      if (moved) {
        // Fling: the average angular velocity over the last 100 ms, none if the pointer rested.
        const now = performance.now(), recent = samples.filter(x => now - x[0] <= 100 && (x[1] || x[2]));
        if (recent.length && now - samples[samples.length - 1][0] < 60) {
          const span = Math.max(16, now - recent[0][0]), k = perPixel();
          omega = recent.reduce((a, x) => a + x[1], 0) * k / span;
        }
      } else { picked = at(e.offsetX, e.offsetY); hooks.onPick(picked); redraw(); }
      drag = null;
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      distTarget = Math.max(1.6, Math.min(12, distTarget * Math.exp(d * 0.0015))); animate();
    }, { passive: false });
    return {
      set(m) {
        if (scene) scene.destroy();
        model = m; scene = gpu(device, format, m); peelLo = 0; peelHi = Infinity; hover = picked = null; marks = [];
        pos = null; target = null;
        if (dots) restartSim();
        redraw();
      },
      // Call edges for node mode's relational pull: [[refA, refB], ...].
      links(pairs) {
        springs = null;
        if (model && Array.isArray(pairs)) {
          const at = new Map(model.leaves.map((c, i) => [c.item.ref, i]));
          const out = [];
          for (const [a, b] of pairs) {
            const i = at.get(a), j = at.get(b);
            if (i != null && j != null && i !== j) out.push(i, j);
          }
          springs = Int32Array.from(out);
        }
        if (dots) restartSim();
      },
      // Peel order follows the caller's list (the sidebar): one box per step, in that order.
      order(refs) {
        if (!model || !Array.isArray(refs)) return;
        peelOrder(model, refs);
        if (scene) scene.rebase();
        const end = model.leaves.length;
        peelLo = Math.max(0, Math.min(peelLo, end));
        peelHi = Math.max(peelLo, Math.min(peelHi, end));
        if (picked && hidden(picked)) picked = null;
        redraw();
      },
      // Hide everything below `lo` and from `hi` on in peel order: one handle peels the top of the
      // list, the other the bottom. 0..leaves is the whole range, and lo <= hi always.
      peelRange(lo, hi) {
        if (!model) return;
        const end = model.leaves.length;
        lo = Math.max(0, Math.min(Math.round(lo), end));
        hi = Math.max(lo, Math.min(Math.round(hi), end));
        if (lo === peelLo && hi === peelHi) return;
        peelLo = lo; peelHi = hi; if (picked && hidden(picked)) picked = null; redraw();
      },
      // Select the procedure `ref`; widens the window to its box when that is hidden. Returns its leaf.
      select(ref) {
        const c = model && model.byRef.get(ref); if (!c) return null;
        picked = c;
        if (hidden(c)) { peelLo = Math.min(peelLo, c.order); peelHi = Math.max(peelHi, c.order + 1); }
        redraw(); return c;
      },
      // Outline groups of procedures: [[refs, cssColor], ...]; the biggest boxes of each group first.
      mark(groups) {
        const vol = c => c.size[0] * c.size[1] * c.size[2];
        marks = model ? groups.map(([refs, color]) => [refs.map(r => model.byRef.get(r)).filter(Boolean).sort((a, b) => vol(b) - vol(a)), color]) : [];
        redraw();
      },
      // Hover outline driven from outside the canvas (the sidebar list).
      hover(ref) { const c = ref && model ? model.byRef.get(ref) || null : null; if (c !== hover) { hover = c; redraw(); } },
      // The corner text follows the panel's three selected sort keys and its best/worst direction,
      // so the poles and every side sign flip with the list.
      axis(names, bestLow = true) {
        if (Array.isArray(names) && names.length === 3) {
          axisNames = names.slice(0, 3);
          cornerText = cornerLabels(axisNames, bestLow);
        }
        redraw();
      },
      // Draw the leaf boxes, or the point cloud: one dot per procedure at its own axis values, with
      // call edges pulling neighbours together. Toggling glides the points from where they are.
      cloud(on) { dots = !!on; restartSim(); redraw(); },
      get peeled() { return [peelLo, peelHi]; },
      clear() { picked = null; marks = []; redraw(); },
      draw: redraw,
    };
  }

  return { layout, layoutRank, peelOrder, cloudPoints, stepCloud, instances, gpu, view, SHADER, reorder, diagonalView, cornerLabels, DIAGONAL };
});
