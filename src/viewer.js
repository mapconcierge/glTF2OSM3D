// 3D 比較ビューア（three.js）: 元モデル / 誤差ヒートマップ / OSM 復元形状 / 欠落・過剰ボクセル
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ShapeUtils } from 'three';

export const SHAPE_COLOURS = {
  flat: '#8da0cb', skillion: '#66c2a5', gabled: '#fc8d62', gabled_across: '#fc8d62', hipped: '#e78ac3',
  pyramidal: '#a6d854', round: '#ffd92f', dome: '#e5c494', cone: '#b3b3b3',
};
export const STEPPED_COLOUR = '#d95f02';

/** 誤差 → 色（0: 緑, tol: 黄, 2·tol 以上: 赤） */
export function errColour(e, tol, out = new THREE.Color()) {
  const t = Math.min(1, e / (2 * tol));
  if (t < 0.5) return out.setRGB(0.1 + 1.6 * t * 0.9, 0.6 + 0.2 * t, 0.3 - 0.5 * t, THREE.SRGBColorSpace);
  const u = (t - 0.5) * 2;
  return out.setRGB(0.95, 0.7 - 0.6 * u, 0.05, THREE.SRGBColorSpace);
}

export class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.localClippingEnabled = true;
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666655, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-50, -80, 120);
    this.scene.add(sun);
    this.groups = {};
    for (const k of ['original', 'error', 'recon', 'lost', 'added', 'ground']) {
      this.groups[k] = new THREE.Group();
      this.scene.add(this.groups[k]);
    }
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6);
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    loop();
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setVisible(key, on) { if (this.groups[key]) this.groups[key].visible = on; }
  setClip(z) { this.clipPlane.constant = z; }
  setBackground(dark) { this.scene.background = new THREE.Color(dark ? 0x1b1f24 : 0xf2f3f5); }

  clear(key) {
    const g = this.groups[key];
    for (const o of [...g.children]) {
      g.remove(o);
      o.traverse((x) => { x.geometry?.dispose?.(); if (x.material) [].concat(x.material).forEach((m) => m.dispose()); });
    }
  }

  mat(opts) { return new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, clippingPlanes: [this.clipPlane], side: THREE.DoubleSide, ...opts }); }

  /** 全表示の更新 */
  update(model, res, ev, { recolour = false } = {}) {
    for (const k of Object.keys(this.groups)) this.clear(k);
    this.buildOriginal(model);
    this.buildError(ev);
    this.buildRecon(res);
    this.buildDiff(res, ev);
    this.buildGround(model);
    if (!recolour) this.fit(model);
  }

  fit(model) {
    const b = model.bbox;
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.max[2]) / 2;
    const r = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    this.controls.target.set(cx, cy, cz);
    this.camera.position.set(cx - r * 1.1, cy - r * 1.5, cz + r * 0.9);
    this.camera.near = r / 500; this.camera.far = r * 50;
    this.camera.updateProjectionMatrix();
  }

  buildOriginal(model) {
    const { tris, triMat, materials } = model;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tris, 3));
    const col = new Float32Array(tris.length);
    const c = new THREE.Color();
    for (let t = 0; t < triMat.length; t++) {
      const m = materials[triMat[t]].color;
      c.setRGB(m[0], m[1], m[2], THREE.SRGBColorSpace);
      for (let v = 0; v < 3; v++) { col[t * 9 + v * 3] = c.r; col[t * 9 + v * 3 + 1] = c.g; col[t * 9 + v * 3 + 2] = c.b; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.groups.original.add(new THREE.Mesh(g, this.mat({ vertexColors: true, flatShading: true })));
  }

  buildError(ev) {
    const { pos, idx, err, triCat } = ev.mesh;
    const n = idx.length;
    const p = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const c = new THREE.Color();
    const grey = new THREE.Color(0x9a9a9a);
    for (let q = 0; q < n; q++) {
      const v = idx[q];
      p[q * 3] = pos[v * 3]; p[q * 3 + 1] = pos[v * 3 + 1]; p[q * 3 + 2] = pos[v * 3 + 2];
      const cat = triCat[(q / 3) | 0];
      if (cat >= 5) c.copy(grey); else errColour(err[v], ev.errTol, c);
      col[q * 3] = c.r; col[q * 3 + 1] = c.g; col[q * 3 + 2] = c.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.groups.error.add(new THREE.Mesh(g, this.mat({ vertexColors: true, flatShading: true })));
  }

  buildRecon(res) {
    const step = Math.max(res.grid.c * 2, 0.3);
    for (const p of res.parts) {
      const geo = partGeometry(p, step);
      const colour = p.origin === 'stepped' ? STEPPED_COLOUR : SHAPE_COLOURS[p.shape] || '#999';
      const mesh = new THREE.Mesh(geo, this.mat({ color: colour, transparent: true, opacity: 0.9, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      mesh.userData.part = p;
      this.groups.recon.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.6, clippingPlanes: [this.clipPlane] }));
      this.groups.recon.add(edges);
    }
  }

  buildDiff(res, ev) {
    const c = res.grid.c;
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const [key, segs, colour] of [['lost', ev.lostSeg, 0xe31a1c], ['added', ev.addSeg, 0x1f78b4]]) {
      if (!segs.length) continue;
      const m = new THREE.InstancedMesh(box, this.mat({ color: colour, transparent: true, opacity: 0.55, depthWrite: false }), segs.length);
      const M = new THREE.Matrix4();
      segs.forEach(([x, y, z0, z1], q) => { M.makeScale(c, c, z1 - z0).setPosition(x, y, (z0 + z1) / 2); m.setMatrixAt(q, M); });
      this.groups[key].add(m);
    }
  }

  buildGround(model) {
    const b = model.bbox;
    const r = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) * 1.6 + 10;
    const grid = new THREE.GridHelper(r, Math.round(r / 2), 0x888888, 0xcccccc);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true; grid.material.opacity = 0.5;
    this.groups.ground.add(grid);
    // 北矢印
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, r / 2 - 2, 0.05), 4, 0xd62728, 1.2, 0.8);
    this.groups.ground.add(arrow);
  }
}

/** パート（ポリゴン + min_height + 屋根関数）→ 立体メッシュ */
export function partGeometry(p, step) {
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  const zTop = (x, y) => p.roofZ(x, y);
  for (const poly of p.polygons) {
    // 壁: 辺を step 間隔で分割し、上端は屋根高さに合わせる（切妻の妻壁などを再現）
    for (const ring of [poly.outer, ...poly.holes]) {
      for (let q = 0; q < ring.length; q++) {
        const a = ring[q], b = ring[(q + 1) % ring.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(1, Math.ceil(len / step));
        for (let s = 0; s < n; s++) {
          const x0 = a[0] + ((b[0] - a[0]) * s) / n, y0 = a[1] + ((b[1] - a[1]) * s) / n;
          const x1 = a[0] + ((b[0] - a[0]) * (s + 1)) / n, y1 = a[1] + ((b[1] - a[1]) * (s + 1)) / n;
          const t0 = zTop(x0, y0), t1 = zTop(x1, y1);
          tri([x0, y0, p.B], [x1, y1, p.B], [x1, y1, t1]);
          tri([x0, y0, p.B], [x1, y1, t1], [x0, y0, t0]);
        }
      }
    }
    // 屋根・底面: 三角形分割し、屋根は細分化して屋根関数で高さ付け
    const contour = poly.outer.map(([x, y]) => new THREE.Vector2(x, y));
    const holes = poly.holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
    const all = contour.concat(...holes);
    const faces = ShapeUtils.triangulateShape(contour, holes);
    const flat = p.shape === 'flat';
    for (const [i, j, k] of faces) {
      const A = [all[i].x, all[i].y], Bv = [all[j].x, all[j].y], C = [all[k].x, all[k].y];
      tri([C[0], C[1], p.B], [Bv[0], Bv[1], p.B], [A[0], A[1], p.B]);
      if (flat) tri([A[0], A[1], p.H], [Bv[0], Bv[1], p.H], [C[0], C[1], p.H]);
      else subdivideRoof(A, Bv, C, step, zTop, tri, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function subdivideRoof(a, b, c, step, z, tri, depth) {
  const L = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  if (L > step && depth < 6) {
    const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2], ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
    subdivideRoof(a, ab, ca, step, z, tri, depth + 1); subdivideRoof(ab, b, bc, step, z, tri, depth + 1);
    subdivideRoof(ca, bc, c, step, z, tri, depth + 1); subdivideRoof(ab, bc, ca, step, z, tri, depth + 1);
    return;
  }
  tri([a[0], a[1], z(a[0], a[1])], [b[0], b[1], z(b[0], b[1])], [c[0], c[1], z(c[0], c[1])]);
}
