// OSM 表現（building:part 群）と元 glTF の差分評価。
//  - セル単位の体積比較（欠落 = glTF にあって OSM に無い / 過剰 = OSM にあって glTF に無い）
//  - 元メッシュ頂点ごとの「OSM 形状表面までの距離」（符号付き距離関数の近似）
//  - 面の向き別に、許容誤差を超える面積を集計し「表現不可能な要素」の説明に用いる
import { pointInPolygons, pointInRing } from './analyze.js';

export function evaluate(model, res, { errTol = 0.5, maxVerts = 250000 } = {}) {
  const { grid, cellIv, parts } = res;
  const { nx, ny, c, cx, cy } = grid;
  const cellA = c * c;

  // ---- セル体積比較（OSM 側は簡略化後ポリゴンで判定） ----
  const lostSeg = []; // [x, y, z0, z1]
  const addSeg = [];
  let vOrig = 0, vRec = 0, vInter = 0;
  const cellErr = new Map(); // k -> {lost, added}
  for (let j = 0; j < ny; j++) {
    const y = cy(j);
    for (let i = 0; i < nx; i++) {
      const x = cx(i);
      const k = j * nx + i;
      const rec = [];
      for (const p of parts) {
        const bb = p.bbox;
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        if (!pointInPolygons(x, y, p.polygons)) continue;
        const top = p.roofZ(x, y);
        if (top > p.B) rec.push([p.B, top]);
      }
      const orig = (cellIv[k] || []).map((iv) => [iv.b, iv.t]);
      if (!rec.length && !orig.length) continue;
      const R = mergeIv(rec), O = mergeIv(orig);
      const lo = O.reduce((a, v) => a + v[1] - v[0], 0);
      const lr = R.reduce((a, v) => a + v[1] - v[0], 0);
      const li = interLen(O, R);
      vOrig += lo * cellA; vRec += lr * cellA; vInter += li * cellA;
      const lost = lo - li, added = lr - li;
      if (lost > 0.05 || added > 0.05) {
        cellErr.set(k, { i, j, x, y, lost, added });
        for (const s of diffIv(O, R)) if (s[1] - s[0] > 0.05) lostSeg.push([x, y, s[0], s[1]]);
        for (const s of diffIv(R, O)) if (s[1] - s[0] > 0.05) addSeg.push([x, y, s[0], s[1]]);
      }
    }
  }

  // ---- 頂点ごとの距離誤差 ----
  const prepared = parts.map(preparePart);
  const mesh = subdivideMesh(model, Math.max(c * 3, 0.5), maxVerts);
  const { pos } = mesh;
  const nV = pos.length / 3;
  const err = new Float32Array(nV);
  for (let v = 0; v < nV; v++) err[v] = surfaceDistance(prepared, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);

  // ---- 面の向き別集計 ----
  const cats = {
    wall: { area: 0, bad: 0 }, roofFlat: { area: 0, bad: 0 }, roofSlope: { area: 0, bad: 0 },
    soffitFlat: { area: 0, bad: 0 }, soffitSlope: { area: 0, bad: 0 },
  };
  const triCat = new Uint8Array(mesh.idx.length / 3);
  const catNames = Object.keys(cats);
  let maxErr = 0;
  for (let t = 0; t < triCat.length; t++) {
    const a = mesh.idx[t * 3], b = mesh.idx[t * 3 + 1], d = mesh.idx[t * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[d * 3] - pos[a * 3], vy = pos[d * 3 + 1] - pos[a * 3 + 1], vz = pos[d * 3 + 2] - pos[a * 3 + 2];
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    const len = Math.hypot(nxv, nyv, nzv);
    if (len < 1e-12) continue;
    const area = len / 2, nz = nzv / len;
    const zc = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[d * 3 + 2]) / 3;
    if (zc < 0.01 && nz < -0.98) { triCat[t] = 6; continue; } // 地面に接する底面は評価対象外
    // 内部面（重なった別メッシュの内側など）: 法線方向に少し進んだ点が依然ソリッド内部なら外から見えない
    const gx = (pos[a * 3] + pos[b * 3] + pos[d * 3]) / 3, gy = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[d * 3 + 1]) / 3;
    const dl = c * 1.5;
    if (occupied(res, gx + (nxv / len) * dl, gy + (nyv / len) * dl, zc + nz * dl)) { triCat[t] = 5; continue; }
    let cat;
    if (Math.abs(nz) < 0.17) cat = 0;
    else if (nz >= 0.985) cat = 1;
    else if (nz > 0) cat = 2;
    else if (nz <= -0.985) cat = 3;
    else cat = 4;
    triCat[t] = cat;
    const e = (err[a] + err[b] + err[d]) / 3;
    maxErr = Math.max(maxErr, e);
    cats[catNames[cat]].area += area;
    if (e > errTol) cats[catNames[cat]].bad += area;
  }

  return {
    errTol, vOrig, vRec, vInter, iou: vInter / Math.max(1e-9, vOrig + vRec - vInter),
    lost: vOrig - vInter, added: vRec - vInter, lostSeg, addSeg, cellErr,
    mesh: { ...mesh, err, triCat }, cats, maxErr,
  };
}

/** 元モデルの占有判定（セル区間による） */
export function occupied(res, x, y, z) {
  const { nx, ny, c, x0, y0 } = res.grid;
  const i = Math.floor((x - x0) / c), j = Math.floor((y - y0) / c);
  if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
  const ivs = res.cellIv[j * nx + i];
  if (!ivs) return false;
  for (const iv of ivs) if (z > iv.b + 1e-3 && z < iv.t - 1e-3) return true;
  return false;
}

function mergeIv(list) {
  const s = list.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const v of s) {
    const m = out[out.length - 1];
    if (m && v[0] <= m[1]) m[1] = Math.max(m[1], v[1]);
    else out.push([v[0], v[1]]);
  }
  return out;
}

function interLen(A, B) {
  let q = 0, r = 0, s = 0;
  while (q < A.length && r < B.length) {
    const lo = Math.max(A[q][0], B[r][0]), hi = Math.min(A[q][1], B[r][1]);
    if (hi > lo) s += hi - lo;
    if (A[q][1] < B[r][1]) q++; else r++;
  }
  return s;
}

/** A \ B */
function diffIv(A, B) {
  const out = [];
  for (const [a0, a1] of A) {
    let cur = a0;
    for (const [b0, b1] of B) {
      if (b1 <= cur || b0 >= a1) continue;
      if (b0 > cur) out.push([cur, b0]);
      cur = Math.max(cur, b1);
      if (cur >= a1) break;
    }
    if (cur < a1) out.push([cur, a1]);
  }
  return out;
}

function preparePart(p) {
  const segs = [];
  const rings = [];
  for (const poly of p.polygons) for (const r of [poly.outer, ...poly.holes]) {
    rings.push(r);
    for (let q = 0; q < r.length; q++) { const a = r[q], b = r[(q + 1) % r.length]; segs.push(a[0], a[1], b[0], b[1]); }
  }
  return { p, segs: new Float64Array(segs), rings, bb: p.bbox };
}

/** 点から OSM 復元形状（パートの和集合）表面までの距離（近似 SDF の絶対値） */
export function surfaceDistance(prepared, x, y, z) {
  let best = Infinity;
  for (const pp of prepared) {
    const { bb, p } = pp;
    const lb = Math.max(bb[0] - x, x - bb[2], bb[1] - y, y - bb[3], p.B - z, z - p.H, 0);
    if (lb >= best) continue;
    let dmin = Infinity;
    const s = pp.segs;
    for (let q = 0; q < s.length; q += 4) {
      const ax = s[q], ay = s[q + 1], dx = s[q + 2] - ax, dy = s[q + 3] - ay;
      const L = dx * dx + dy * dy;
      let t = L > 0 ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - ax - t * dx, ey = y - ay - t * dy;
      const d2 = ex * ex + ey * ey;
      if (d2 < dmin) dmin = d2;
    }
    let inside = false;
    for (const r of pp.rings) if (pointInRing(x, y, r)) inside = !inside;
    const dxy = inside ? -Math.sqrt(dmin) : Math.sqrt(dmin);
    const top = p.roofZ(Math.min(Math.max(x, bb[0]), bb[2]), Math.min(Math.max(y, bb[1]), bb[3]));
    const d = Math.max(dxy, p.B - z, z - top);
    if (d < best) best = d;
  }
  return Math.abs(best);
}

/** 長い辺を持つ三角形を細分化（誤差ヒートマップを滑らかにするため） */
export function subdivideMesh(model, maxLen, maxVerts) {
  const { tris } = model;
  const nT = tris.length / 9;
  const pos = [];
  const idx = [];
  const triSrc = [];
  const map = new Map();
  const q = 1e4;
  const vert = (x, y, z) => {
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let v = map.get(key);
    if (v === undefined) { v = pos.length / 3; pos.push(x, y, z); map.set(key, v); }
    return v;
  };
  let budget = maxVerts;
  const rec = (a, b, d, src, depth) => {
    const la = dist(a, b), lb = dist(b, d), lc = dist(d, a);
    if (depth < 6 && Math.max(la, lb, lc) > maxLen && pos.length / 3 < budget) {
      const ab = mid(a, b), bd = mid(b, d), da = mid(d, a);
      rec(a, ab, da, src, depth + 1); rec(ab, b, bd, src, depth + 1); rec(da, bd, d, src, depth + 1); rec(ab, bd, da, src, depth + 1);
      return;
    }
    idx.push(vert(...a), vert(...b), vert(...d));
    triSrc.push(src);
  };
  for (let t = 0; t < nT; t++) {
    const p = t * 9;
    rec([tris[p], tris[p + 1], tris[p + 2]], [tris[p + 3], tris[p + 4], tris[p + 5]], [tris[p + 6], tris[p + 7], tris[p + 8]], t, 0);
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx), triSrc: new Uint32Array(triSrc) };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
