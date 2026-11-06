// ステージ1: glTF メッシュの単純化（マスモデル化）
// Mapbox の 3D 建物表現（押し出し＋角や上端の丸め）を参考に、
// 「必要最低限の建物形状」と「角を少し丸めた見栄え」を両立する軽量メッシュを生成する。DOM 非依存。
//
// 手順
//  1. 2.5D ボクセル化（analyze.js の voxelize）: セルごとの占有区間
//  2. 薄い部材の除去・鉛直方向の小さな隙間の充填 → 下層（地面側の柱）と上層（浮いた部分）の 2 層に整理
//  3. 平面のモルフォロジー（オープニング→クロージング）で、細部サイズ未満の突起・切欠きを除去
//  4. 高さ場のメディアンフィルタで煙突・十字架・窓枠などの小さな凹凸を除去（平面・稜線は保たれる）
//  5. ほぼ水平な部分を高さの段（プラトー）へスナップ → 陸屋根を平らに
//  6. 高さの段差で領域分割し、各領域の外形を簡略化（Douglas-Peucker）＋角を円弧で丸める
//  7. 押し出し＋屋根面（平坦 or 高さ場から補間した曲面）でメッシュ化。陸屋根は上端エッジも丸める
import { Vector2, ShapeUtils } from 'three';
import { voxelize, polygonize, signedArea, fitSurface } from './analyze.js';

export const SIMPLIFY_DEFAULTS = {
  detail: 1.0, // 除去する細部の大きさ [m]（平面・高さとも）
  heightTol: 0.4, // 同じ高さとみなす許容差 [m]（陸屋根のスナップ）
  jumpTol: 0.8, // これ以上の高さの段差で領域を分ける [m]
  minThickness: 0.3, // これより薄い部材（手すり・ルーバー・薄い庇）は除去 [m]
  gap: 1.0, // これより狭い鉛直方向の隙間は埋める [m]
  minArea: 2.0, // これより小さい領域は除去 [m²]
  cornerRadius: 0.6, // 平面の角の丸め半径 [m]
  edgeRadius: 0.3, // 陸屋根の上端エッジの丸め半径 [m]（Mapbox の edge radius に相当）
  cellSize: 0, // 0 = 自動
};

export function simplifyModel(model, options = {}) {
  const o = { ...SIMPLIFY_DEFAULTS, ...options };
  const vox = voxelize(model, { cellSize: o.cellSize, vStep: o.gap });
  const { grid, cellIv } = vox;
  const { nx, ny, c } = grid;
  const n = nx * ny;
  const { triMat } = model;

  // ---- 2. 2 層に整理 ----
  const L = [mkLayer(n), mkLayer(n)]; // 0: 地面側, 1: 浮いた上層
  let thinRemoved = 0;
  for (let k = 0; k < n; k++) {
    const ivs = (cellIv[k] || []).filter((iv) => {
      if (iv.t - iv.b < o.minThickness) { thinRemoved += (iv.t - iv.b) * c * c; return false; }
      return true;
    });
    if (!ivs.length) continue;
    const [first, ...rest] = ivs;
    put(L[0], k, first);
    if (rest.length) put(L[1], k, { b: rest[0].b, t: rest[rest.length - 1].t, topTri: rest[rest.length - 1].topTri });
  }

  const r = Math.max(1, Math.round(o.detail / 2 / c)); // フィルタ半径（セル）
  const minCells = Math.ceil(o.minArea / (c * c));
  const stats = { removedCells: 0, addedCells: 0, thinRemoved };
  for (const layer of L) {
    // ---- 3. 平面モルフォロジー ----
    const before = countMask(layer.mask);
    let m = layer.mask;
    m = dilate(erode(m, nx, ny, r), nx, ny, r); // opening: 細い突起を除去
    m = erode(dilate(m, nx, ny, r), nx, ny, r); // closing: 細い切欠き・隙間を充填
    for (let k = 0; k < n; k++) {
      if (layer.mask[k] && !m[k]) stats.removedCells++;
      if (!layer.mask[k] && m[k]) stats.addedCells++;
    }
    void before;
    // 新たに加わったセルの高さは近傍から補完
    inpaint(layer, m, nx, ny);
    layer.mask = m;
    // ---- 4. メディアンフィルタ ----
    layer.T = medianFilter(layer.T, m, nx, ny, r);
    layer.B = medianFilter(layer.B, m, nx, ny, r);
    // ---- 5. プラトーへのスナップ ----
    snapPlateaus(layer.T, m, nx, ny, c, o.heightTol);
    snapPlateaus(layer.B, m, nx, ny, c, o.heightTol);
    for (let k = 0; k < n; k++) if (m[k] && layer.B[k] < 0.3) layer.B[k] = 0;
  }

  // ---- 6. 領域分割 ----
  const regions = [];
  for (let li = 0; li < 2; li++) {
    const { mask, T, B } = L[li];
    const G = slopeLimitedGradient(T, mask, nx, ny);
    const seen = new Uint8Array(n);
    for (let k0 = 0; k0 < n; k0++) {
      if (!mask[k0] || seen[k0]) continue;
      const cells = [];
      const stack = [k0];
      seen[k0] = 1;
      while (stack.length) {
        const k = stack.pop();
        cells.push(k);
        const i = k % nx, j = (k / nx) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const i2 = i + di, j2 = j + dj;
          if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
          const k2 = j2 * nx + i2;
          if (!mask[k2] || seen[k2]) continue;
          if (Math.abs(B[k2] - B[k]) > o.jumpTol) continue;
          // 勾配（minmod 制限付き片側差分）で予測した高さ差との差で判定:
          // 連続した斜面（尖塔・屋根）は結合し、段差（壁の上端）は勾配が 0 と推定されるため分離される
          const pred = di !== 0 ? ((G[0][k] + G[0][k2]) / 2) * di : ((G[1][k] + G[1][k2]) / 2) * dj;
          if (Math.abs(T[k2] - T[k] - pred) > o.jumpTol) continue;
          seen[k2] = 1;
          stack.push(k2);
        }
      }
      if (cells.length < minCells) { stats.removedCells += cells.length; continue; }
      for (const sub of refineRegion(cells, L[li], G, grid, o, minCells)) regions.push(makeRegion(sub, li));
    }
  }
  function makeRegion(cells, li) {
    const { T, B } = L[li];
    const tops = cells.map((k) => T[k]).sort((a, b) => a - b);
    const bots = cells.map((k) => B[k]).sort((a, b) => a - b);
    const flat = tops[tops.length - 1] - tops[0] <= o.heightTol * 1.5;
    // 斜面: roof:shape プリセット（切妻・寄棟・方形・円錐・ドーム等）が当てはまれば解析的な屋根面を使う
    let fit = null;
    if (!flat) {
      const pts = cells.map((k) => ({ x: grid.cx(k % nx), y: grid.cy((k / nx) | 0), t: T[k] }));
      fit = fitSurface(pts, c, bots[bots.length >> 1], { roofTol: Math.max(0.6, 1.5 * o.heightTol), roofRel: 0.08, noCap: true });
    }
    return { fit, layer: li, cells, flat, level: tops[tops.length >> 1], base: bots[bots.length >> 1], topMat: modeOf(cells.map((k) => triMat[L[li].tri[k]])) };
  }
  // 低い領域は隣接する高い領域の下へ少し潜り込ませ、独立に簡略化した外形の間に隙間（スリット）が出ないようにする
  const regionOf = [new Int32Array(n).fill(-1), new Int32Array(n).fill(-1)];
  regions.forEach((rg, q) => { for (const k of rg.cells) regionOf[rg.layer][k] = q; });
  const owner = new Int32Array(n).fill(-1);
  regions.forEach((rg, q) => { if (rg.layer === 0) for (const k of rg.cells) owner[k] = q; });
  const tolPlan = Math.max(c, o.detail * 0.3);
  const pad = Math.ceil((tolPlan + o.cornerRadius) / c) + 1;
  regions.forEach((rg, q) => {
    rg.polyCells = rg.cells;
    if (rg.layer !== 0) return;
    const set = new Set(rg.cells);
    let front = rg.cells;
    for (let s = 0; s < pad; s++) {
      const next = [];
      for (const k of front) {
        const i = k % nx, j = (k / nx) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const k2 = (j + dj) * nx + i + di;
          const ow = owner[k2];
          if (ow < 0 || ow === q || set.has(k2)) continue;
          if (regions[ow].level <= rg.level) continue; // 自分より高い隣接領域の下にだけ広げる
          set.add(k2);
          next.push(k2);
        }
      }
      front = next;
    }
    rg.polyCells = [...set];
  });

  // ---- 7. メッシュ化 ----
  const wallMat = dominantWallMaterial(model);
  const sample = (rg, q) => (x, y) => sampleField(L[rg.layer], grid, x, y, regionOf[rg.layer], q);
  const build = (round) => {
    const meshes = []; // { tris: number[], mat }
    for (const [q, rg] of regions.entries()) {
      let polys = polygonize(rg.polyCells, grid, tolPlan);
      if (round && o.cornerRadius > 0) polys = polys.map((p) => ({ outer: roundRing(p.outer, o.cornerRadius), holes: p.holes.map((h) => roundRing(h, o.cornerRadius)) }));
      const lo = rg.base, hi = Math.max(...rg.cells.map((k) => L[rg.layer].T[k]));
      const zTop = rg.flat ? () => rg.level : rg.fit ? (x, y) => Math.min(hi, Math.max(lo, rg.fit.evalAt(x, y))) : sample(rg, q);
      const zBase = rg.base;
      const roofTris = [], wallTris = [];
      for (const p of polys) {
        extrudeWithRoof(p, zBase, zTop, rg.flat, round ? Math.min(o.edgeRadius, (rg.level - zBase) / 3) : 0, { minLen: Math.max(c, 0.3), maxLen: rg.fit ? Infinity : Math.max(2, 2 * o.detail), tol: o.heightTol }, roofTris, wallTris);
      }
      meshes.push({ tris: roofTris, mat: rg.topMat ?? wallMat ?? 0 });
      meshes.push({ tris: wallTris, mat: wallMat ?? rg.topMat ?? 0 });
    }
    return meshes;
  };
  return {
    options: o, grid, regions, stats,
    display: build(true), // 角・上端を丸めた表示用
    plain: build(false), // 丸めなし（OSM 変換用）
  };
}

/**
 * 平坦でなく、屋根プリセットにも当てはまらない領域を「平坦部（高さ別）」と「斜面部」に再分割する。
 * 小さな断片は隣接する最大の断片へ併合。
 */
function refineRegion(cells, layer, G, grid, o, minCells) {
  const { T } = layer;
  const { nx, c } = grid;
  const tops = cells.map((k) => T[k]);
  if (Math.max(...tops) - Math.min(...tops) <= o.heightTol * 1.5) return [cells];
  const pts = cells.map((k) => ({ x: grid.cx(k % nx), y: grid.cy((k / nx) | 0), t: T[k] }));
  const bots = cells.map((k) => layer.B[k]).sort((a, b) => a - b);
  if (fitSurface(pts, c, bots[bots.length >> 1], { roofTol: Math.max(0.6, 1.5 * o.heightTol), roofRel: 0.08, noCap: true })) return [cells];
  const inSet = new Set(cells);
  const flatCell = (k) => Math.abs(G[0][k]) < 0.02 && Math.abs(G[1][k]) < 0.02;
  const label = new Map();
  const parts = [];
  for (const k0 of cells) {
    if (label.has(k0)) continue;
    const isFlat = flatCell(k0);
    const comp = [k0];
    label.set(k0, parts.length);
    for (let q = 0; q < comp.length; q++) {
      const k = comp[q];
      for (const k2 of [k + 1, k - 1, k + nx, k - nx]) {
        if (!inSet.has(k2) || label.has(k2) || flatCell(k2) !== isFlat) continue;
        if (isFlat && Math.abs(T[k2] - T[k0]) > o.heightTol) continue;
        label.set(k2, parts.length);
        comp.push(k2);
      }
    }
    parts.push(comp);
  }
  // 小断片の併合（隣接セル数が最大の大きい断片へ）
  const big = (q) => parts[q] && parts[q].length >= minCells;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    parts.forEach((comp, q) => {
      if (!comp || big(q)) return;
      const votes = new Map();
      for (const k of comp) for (const k2 of [k + 1, k - 1, k + nx, k - nx]) {
        const l2 = label.get(k2);
        if (l2 !== undefined && l2 !== q && parts[l2]) votes.set(l2, (votes.get(l2) || 0) + 1);
      }
      let best = -1, bv = 0;
      for (const [l2, v] of votes) if (big(l2) && v > bv) { bv = v; best = l2; }
      if (best < 0) for (const [l2, v] of votes) if (v > bv) { bv = v; best = l2; }
      if (best < 0) return;
      for (const k of comp) { label.set(k, best); parts[best].push(k); }
      parts[q] = null;
      changed = true;
    });
    if (!changed) break;
  }
  return parts.filter((p) => p && p.length);
}

/** セル単位の高さ差（x, y）。前後差分のうち絶対値の小さい方（符号が異なれば 0）＝ minmod 制限 */
function slopeLimitedGradient(T, m, nx, ny) {
  const gx = new Float32Array(T.length), gy = new Float32Array(T.length);
  const mm = (a, b) => (a * b <= 0 ? 0 : Math.abs(a) < Math.abs(b) ? a : b);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i;
    if (!m[k]) continue;
    const f = m[k + 1] ? T[k + 1] - T[k] : 0, bk = m[k - 1] ? T[k] - T[k - 1] : 0;
    const u = m[k + nx] ? T[k + nx] - T[k] : 0, d = m[k - nx] ? T[k] - T[k - nx] : 0;
    gx[k] = mm(f, bk);
    gy[k] = mm(u, d);
  }
  return [gx, gy];
}

function mkLayer(n) {
  return { mask: new Uint8Array(n), T: new Float32Array(n), B: new Float32Array(n), tri: new Int32Array(n).fill(-1) };
}
function put(layer, k, iv) { layer.mask[k] = 1; layer.T[k] = iv.t; layer.B[k] = iv.b; layer.tri[k] = iv.topTri; }
function countMask(m) { let s = 0; for (const v of m) s += v; return s; }
function modeOf(arr) {
  const m = new Map();
  for (const v of arr) if (v !== undefined && v >= 0) m.set(v, (m.get(v) || 0) + 1);
  let best, bc = -1;
  for (const [v, cnt] of m) if (cnt > bc) { bc = cnt; best = v; }
  return best;
}

// ---- 平面モルフォロジー（円形近似の構造要素） ----
function offsets(r) {
  const out = [];
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (di * di + dj * dj <= r * r + 0.5) out.push([di, dj]);
  return out;
}
function erode(m, nx, ny, r) {
  const off = offsets(r), out = new Uint8Array(m.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (!m[k]) continue;
    let ok = 1;
    for (const [di, dj] of off) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny || !m[j2 * nx + i2]) { ok = 0; break; }
    }
    out[k] = ok;
  }
  return out;
}
function dilate(m, nx, ny, r) {
  const off = offsets(r), out = new Uint8Array(m.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!m[j * nx + i]) continue;
    for (const [di, dj] of off) {
      const i2 = i + di, j2 = j + dj;
      if (i2 >= 0 && j2 >= 0 && i2 < nx && j2 < ny) out[j2 * nx + i2] = 1;
    }
  }
  return out;
}

/** 新規セルの T/B/tri を既存セルから反復的に補完 */
function inpaint(layer, m, nx, ny) {
  const known = layer.mask.slice();
  let todo = [];
  for (let k = 0; k < m.length; k++) if (m[k] && !known[k]) todo.push(k);
  for (let it = 0; it < 200 && todo.length; it++) {
    const rest = [];
    const fills = [];
    for (const k of todo) {
      const i = k % nx, j = (k / nx) | 0;
      let st = 0, sb = 0, cnt = 0, tri = -1;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const i2 = i + di, j2 = j + dj;
        if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
        const k2 = j2 * nx + i2;
        if (!known[k2]) continue;
        st += layer.T[k2]; sb += layer.B[k2]; cnt++; tri = layer.tri[k2];
      }
      if (cnt) fills.push([k, st / cnt, sb / cnt, tri]); else rest.push(k);
    }
    for (const [k, t, b, tri] of fills) { layer.T[k] = t; layer.B[k] = b; layer.tri[k] = tri; known[k] = 1; }
    todo = rest;
  }
}

function medianFilter(F, m, nx, ny, r) {
  const off = offsets(r), out = F.slice(), buf = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (!m[k]) continue;
    buf.length = 0;
    for (const [di, dj] of off) {
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
      const k2 = j2 * nx + i2;
      if (m[k2]) buf.push(F[k2]);
    }
    buf.sort((a, b) => a - b);
    out[k] = buf[buf.length >> 1];
  }
  return out;
}

/** 勾配の小さいセルを、高さ差 tol 以内で連結したグループの中央値へ揃える */
function snapPlateaus(F, m, nx, ny, c, tol) {
  const n = F.length;
  const flat = new Uint8Array(n);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i;
    if (!m[k]) continue;
    let g = 0;
    for (const k2 of [k + 1, k - 1, k + nx, k - nx]) if (m[k2]) g = Math.max(g, Math.abs(F[k2] - F[k]) / c);
    flat[k] = g < 0.15 ? 1 : 0;
  }
  const seen = new Uint8Array(n);
  for (let k0 = 0; k0 < n; k0++) {
    if (!flat[k0] || seen[k0]) continue;
    const comp = [k0];
    seen[k0] = 1;
    for (let q = 0; q < comp.length; q++) {
      const k = comp[q];
      for (const k2 of [k + 1, k - 1, k + nx, k - nx]) {
        if (k2 < 0 || k2 >= n || !flat[k2] || seen[k2] || Math.abs(F[k2] - F[k0]) > tol) continue;
        seen[k2] = 1;
        comp.push(k2);
      }
    }
    const v = comp.map((k) => F[k]).sort((a, b) => a - b)[comp.length >> 1];
    for (const k of comp) F[k] = v;
  }
}

/** 層の高さ場を (x,y) で双線形補間（層外は最近傍の層内セル） */
function sampleField(layer, grid, x, y, regionOf, q) {
  const { c, x0, y0, nx, ny } = grid;
  const fx = (x - x0) / c - 0.5, fy = (y - y0) / c - 0.5;
  const i0 = Math.floor(fx), j0 = Math.floor(fy);
  let s = 0, w = 0;
  for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const i = i0 + di, j = j0 + dj;
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    const k = j * nx + i;
    if (!layer.mask[k] || regionOf[k] !== q) continue;
    const wt = (1 - Math.abs(fx - i)) * (1 - Math.abs(fy - j));
    s += wt * layer.T[k]; w += wt;
  }
  if (w > 1e-6) return s / w;
  // 近傍探索
  for (let rr = 1; rr < 6; rr++) {
    let best = null;
    for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      const i = Math.round(fx) + di, j = Math.round(fy) + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const k = j * nx + i;
      if (layer.mask[k] && regionOf[k] === q && (best === null || layer.T[k] > best)) best = layer.T[k];
    }
    if (best !== null) return best;
  }
  return 0;
}

function dominantWallMaterial(model) {
  const { tris, triMat } = model;
  const acc = new Map();
  for (let t = 0; t < triMat.length; t++) {
    const p = t * 9;
    const ux = tris[p + 3] - tris[p], uy = tris[p + 4] - tris[p + 1], uz = tris[p + 5] - tris[p + 2];
    const vx = tris[p + 6] - tris[p], vy = tris[p + 7] - tris[p + 1], vz = tris[p + 8] - tris[p + 2];
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    const len = Math.hypot(nxv, nyv, nzv);
    if (len < 1e-12 || Math.abs(nzv / len) > 0.3) continue;
    acc.set(triMat[t], (acc.get(triMat[t]) || 0) + len / 2);
  }
  return modeOfWeighted(acc);
}
function modeOfWeighted(acc) { let best, bw = -1; for (const [k, w] of acc) if (w > bw) { bw = w; best = k; } return best; }

// ---- 角の丸め（フィレット） ----
export function roundRing(ring, radius, segs = 3) {
  const n = ring.length;
  if (n < 3 || radius <= 0) return ring;
  const ccw = signedArea(ring) > 0;
  const out = [];
  for (let q = 0; q < n; q++) {
    const p0 = ring[(q - 1 + n) % n], p1 = ring[q], p2 = ring[(q + 1) % n];
    const ax = p0[0] - p1[0], ay = p0[1] - p1[1], bx = p2[0] - p1[0], by = p2[1] - p1[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const cosA = (ax * bx + ay * by) / (la * lb);
    const ang = Math.acos(Math.max(-1, Math.min(1, cosA))); // 内角（2 辺のなす角）
    if (ang > Math.PI * 0.9) { out.push(p1); continue; } // ほぼ直線
    // 接点までの距離 d = R / tan(ang/2)。隣接辺の 40% を上限
    let d = radius / Math.tan(ang / 2);
    d = Math.min(d, la * 0.4, lb * 0.4);
    const R = d * Math.tan(ang / 2);
    const t1 = [p1[0] + (ax / la) * d, p1[1] + (ay / la) * d];
    const t2 = [p1[0] + (bx / lb) * d, p1[1] + (by / lb) * d];
    // 円弧中心: 角の二等分線上、距離 R / sin(ang/2)
    const hx = ax / la + bx / lb, hy = ay / la + by / lb, hl = Math.hypot(hx, hy);
    if (hl < 1e-9 || R < 1e-3) { out.push(p1); continue; }
    const dc = R / Math.sin(ang / 2);
    const cx = p1[0] + (hx / hl) * dc, cy = p1[1] + (hy / hl) * dc;
    let a1 = Math.atan2(t1[1] - cy, t1[0] - cx), a2 = Math.atan2(t2[1] - cy, t2[0] - cx);
    // 進行方向（リングの向き）に沿って短い方の弧を補間
    let da = a2 - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    void ccw;
    for (let s = 0; s <= segs; s++) {
      const a = a1 + (da * s) / segs;
      out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    }
  }
  return out.length >= 3 ? out : ring;
}

/** ポリゴン内側へのオフセット（頂点ごとのマイター、小さな距離向け） */
function insetRing(ring, d) {
  // 外周 CCW・穴 CW の規約では、ソリッド側は常に進行方向の左
  const n = ring.length;
  const ccw = 1;
  return ring.map((p1, q) => {
    const p0 = ring[(q - 1 + n) % n], p2 = ring[(q + 1) % n];
    const e1 = norm([p1[0] - p0[0], p1[1] - p0[1]]), e2 = norm([p2[0] - p1[0], p2[1] - p1[1]]);
    // 左法線（CCW の内側）
    const n1 = [-e1[1] * ccw, e1[0] * ccw], n2 = [-e2[1] * ccw, e2[0] * ccw];
    const m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const cosh = Math.max(0.35, m[0] * n1[0] + m[1] * n1[1]);
    return [p1[0] + (m[0] * d) / cosh, p1[1] + (m[1] * d) / cosh];
  });
}
const norm = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/**
 * ポリゴン（外周＋穴）を zBase から屋根面 zTop(x,y) まで押し出す。
 * flat かつ edge>0 のとき、上端エッジを 1/4 円で丸める。
 */
function extrudeWithRoof(poly, zBase, zTop, flat, edge, step, roofOut, wallOut) {
  const tri = (out, a, b, d) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
  const rings = [poly.outer, ...poly.holes];
  const top = flat ? zTop(0, 0) : null;
  const useEdge = flat && edge > 0.02;
  const ES = 2; // 丸めの分割数
  // 壁
  for (const ring of rings) {
    const m = ring.length;
    // 丸め用の段: k=0 が壁上端（外周）、k=ES がオフセット済み天端
    const profile = useEdge ? Array.from({ length: ES + 1 }, (_, k) => {
      const a = (Math.PI / 2) * (k / ES);
      return { inset: edge * (1 - Math.cos(a)), z: top - edge + edge * Math.sin(a) };
    }) : null;
    const insets = useEdge ? profile.map((pf) => (pf.inset > 1e-6 ? insetRing(ring, pf.inset) : ring)) : null;
    for (let q = 0; q < m; q++) {
      const a = ring[q], b = ring[(q + 1) % m];
      if (flat) {
        const zt = useEdge ? top - edge : top;
        tri(wallOut, [a[0], a[1], zBase], [b[0], b[1], zBase], [b[0], b[1], zt]);
        tri(wallOut, [a[0], a[1], zBase], [b[0], b[1], zt], [a[0], a[1], zt]);
        if (useEdge) {
          for (let k = 0; k < ES; k++) {
            const A0 = insets[k][q], B0 = insets[k][(q + 1) % m], A1 = insets[k + 1][q], B1 = insets[k + 1][(q + 1) % m];
            const z0 = profile[k].z, z1 = profile[k + 1].z;
            tri(roofOut, [A0[0], A0[1], z0], [B0[0], B0[1], z0], [B1[0], B1[1], z1]);
            tri(roofOut, [A0[0], A0[1], z0], [B1[0], B1[1], z1], [A1[0], A1[1], z1]);
          }
        }
      } else {
        // 屋根高が直線補間から tol 以上ずれる所だけ辺を分割（適応分割）
        const pts = adaptiveEdge(a, b, zTop, step, 0);
        pts.push([b[0], b[1], Math.max(zBase, zTop(b[0], b[1]))]);
        for (let s = 0; s + 1 < pts.length; s++) {
          const [x0, y0, t0] = pts[s], [x1, y1, t1] = pts[s + 1];
          tri(wallOut, [x0, y0, zBase], [x1, y1, zBase], [x1, y1, t1]);
          tri(wallOut, [x0, y0, zBase], [x1, y1, t1], [x0, y0, t0]);
        }
      }
    }
  }
  // 屋根・底面
  const capPoly = useEdge ? { outer: insetRing(poly.outer, edge), holes: poly.holes.map((h) => insetRing(h, edge)) } : poly;
  const faces = triangulate(capPoly);
  const bottomFaces = useEdge ? triangulate(poly) : faces;
  for (const [A, Bv, C] of bottomFaces) tri(wallOut, [C[0], C[1], zBase], [Bv[0], Bv[1], zBase], [A[0], A[1], zBase]);
  for (const [A, Bv, C] of faces) {
    if (flat) tri(roofOut, [A[0], A[1], top], [Bv[0], Bv[1], top], [C[0], C[1], top]);
    else subdivide(A, Bv, C, step, (x, y) => Math.max(zBase, zTop(x, y)), roofOut, 0);
  }
}

/** 辺 a→b を、屋根高の直線補間誤差が tol を超える間だけ再帰分割（終点 b は含まない） */
function adaptiveEdge(a, b, z, step, depth) {
  const za = z(a[0], a[1]), zb = z(b[0], b[1]);
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const q1 = [a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], q3 = [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75];
  const err = Math.max(Math.abs(z(m[0], m[1]) - (za + zb) / 2), Math.abs(z(q1[0], q1[1]) - (0.75 * za + 0.25 * zb)), Math.abs(z(q3[0], q3[1]) - (0.25 * za + 0.75 * zb)));
  if (depth < 8 && L > step.minLen && err > step.tol) return adaptiveEdge(a, m, z, step, depth + 1).concat(adaptiveEdge(m, b, z, step, depth + 1));
  return [[a[0], a[1], za]];
}

/** 屋根面の適応細分化: 各辺中点・重心の高さ誤差が tol を超える三角形だけ 4 分割 */
function subdivide(a, b, c, step, z, out, depth) {
  const L = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(b[0] - c[0], b[1] - c[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  const za = z(a[0], a[1]), zb = z(b[0], b[1]), zc = z(c[0], c[1]);
  const err = Math.max(
    Math.abs(z((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) - (za + zb) / 2),
    Math.abs(z((b[0] + c[0]) / 2, (b[1] + c[1]) / 2) - (zb + zc) / 2),
    Math.abs(z((c[0] + a[0]) / 2, (c[1] + a[1]) / 2) - (zc + za) / 2),
    Math.abs(z((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3) - (za + zb + zc) / 3));
  if ((L > step.minLen && err > step.tol && depth < 8) || (L > step.maxLen && depth < 8)) {
    const ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], bc = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2], ca = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
    subdivide(a, ab, ca, step, z, out, depth + 1); subdivide(ab, b, bc, step, z, out, depth + 1);
    subdivide(ca, bc, c, step, z, out, depth + 1); subdivide(ab, bc, ca, step, z, out, depth + 1);
    return;
  }
  out.push(a[0], a[1], z(a[0], a[1]), b[0], b[1], z(b[0], b[1]), c[0], c[1], z(c[0], c[1]));
}

// ---- 穴あきポリゴンの三角形分割（three.js の ShapeUtils = earcut） ----
function triangulate(poly) {
  const contour = poly.outer.map(([x, y]) => new Vector2(x, y));
  const holes = poly.holes.map((h) => h.map(([x, y]) => new Vector2(x, y)));
  const all = contour.concat(...holes);
  return ShapeUtils.triangulateShape(contour, holes).map(([i, j, k]) => [[all[i].x, all[i].y], [all[j].x, all[j].y], [all[k].x, all[k].y]]);
}

/** 単純化結果のメッシュ群 → 解析用モデル（モデル局所座標のまま） */
export function meshesToModel(meshes, materials) {
  let n = 0;
  for (const m of meshes) n += m.tris.length;
  const tris = new Float32Array(n);
  const triMat = new Uint32Array(n / 9);
  let off = 0;
  for (const m of meshes) { tris.set(m.tris, off); triMat.fill(m.mat, off / 9, (off + m.tris.length) / 9); off += m.tris.length; }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let q = 0; q < tris.length; q += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], tris[q + a]); max[a] = Math.max(max[a], tris[q + a]); }
  return { tris, triMat, materials, bbox: { min, max }, stats: { meshes: meshes.length, triangles: n / 9, flipped: 0, valid: tris.every(Number.isFinite) } };
}
