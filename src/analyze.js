// glTF メッシュ → OSM Simple 3D Buildings (building:part) 分解エンジン
// DOM 非依存（Node でもテスト可能）。
//
// 座標系: モデル局所座標 x=東, y=北, z=上 [m]、z=0 が地盤面。
//
// アルゴリズム概要
//  1. 水平グリッド（セルサイズ c）の各セル中心から鉛直レイを投射し、
//     三角形との交点（上向き面/下向き面）から「占有区間 [bottom, top]」を求める（2.5D ボクセル化）。
//  2. 底面高さ（量子化）が同じで隣接・z 区間が重なるサンプルを連結して「領域」を作る
//     → 領域ごとに min_height が決まる（ピロティ・キャンチレバー・ブリッジ対応）。
//  3. 各領域の上面を roof:shape プリセット（flat, skillion, gabled, hipped, pyramidal,
//     round, dome, cone）で最小二乗フィット。突出物（塔屋・煙突など）は外れ値として別パートに。
//     どれにも当てはまらない場合は「段状（レイヤーケーキ）」近似に分解。
//  4. 各パートのセル集合を輪郭追跡してポリゴン化し、Douglas-Peucker で簡略化。

const SHAPES = ['flat', 'skillion', 'gabled', 'gabled_across', 'hipped', 'pyramidal', 'round', 'dome', 'cone'];

export const DEFAULT_OPTIONS = {
  cellSize: 0, // 0 = 自動
  vStep: 0.5, // 区間結合の閾値（これより狭い隙間は埋める）[m]
  stepHeight: 1.0, // 曲面・傾斜底面を段状近似する際の段の高さ [m]
  roofTol: 0.35, // 屋根フィット許容 RMS [m]
  minPartArea: 0.5, // これ未満の領域は省略 [m²]
  simplify: 0.75, // 簡略化許容値（セルサイズ倍率）
  mergeEaves: true, // 薄い張り出し（軒の出等）を隣接パートへ併合
  thinMax: 1.0, // 「薄い」とみなす厚さ [m]
};

export function autoCellSize(model) {
  const b = model.bbox;
  const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
  return Math.min(2, Math.max(0.1, Math.round((ext / 200) * 100) / 100));
}

export function analyze(model, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const c = o.cellSize > 0 ? o.cellSize : autoCellSize(model);
  const { tris } = model;
  const nT = tris.length / 9;
  const b = model.bbox;
  const x0 = b.min[0] - c;
  const y0 = b.min[1] - c;
  const nx = Math.ceil((b.max[0] - b.min[0]) / c) + 3;
  const ny = Math.ceil((b.max[1] - b.min[1]) / c) + 3;
  const grid = { c, x0, y0, nx, ny };
  const jx = c * 0.000123457; // 辺上の二重ヒットを避ける微小ずらし
  const jy = c * 0.0000789123;
  const cx = (i) => x0 + (i + 0.5) * c + jx;
  const cy = (j) => y0 + (j + 0.5) * c + jy;
  grid.cx = cx;
  grid.cy = cy;

  // ---- 1. レイキャスト（三角形ラスタライズ） ----
  const hits = new Array(nx * ny);
  for (let t = 0; t < nT; t++) {
    const p = t * 9;
    const ax = tris[p], ay = tris[p + 1], az = tris[p + 2];
    const bx = tris[p + 3], by = tris[p + 4], bz = tris[p + 5];
    const qx = tris[p + 6], qy = tris[p + 7], qz = tris[p + 8];
    const area2 = (bx - ax) * (qy - ay) - (qx - ax) * (by - ay);
    if (Math.abs(area2) < 1e-12) continue; // 鉛直面はヒットしない
    const s = area2 > 0 ? 1 : -1; // +1: 上向き面 / -1: 下向き面
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, qx) - x0 - jx) / c - 0.5));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, qx) - x0 - jx) / c - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, qy) - y0 - jy) / c - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, qy) - y0 - jy) / c - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = cy(j);
      for (let i = i0; i <= i1; i++) {
        const px = cx(i);
        const w0 = ((bx - px) * (qy - py) - (qx - px) * (by - py)) / area2;
        const w1 = ((qx - px) * (ay - py) - (ax - px) * (qy - py)) / area2;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue; // 微小ずらしにより辺上ヒットはほぼ生じない
        const z = w0 * az + w1 * bz + w2 * qz;
        const k = j * nx + i;
        (hits[k] || (hits[k] = [])).push(z, s, t);
      }
    }
  }

  // ---- 区間化 ----
  const cellIv = new Array(nx * ny); // [{b,t,topTri}]
  let belowGround = 0;
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k];
    if (!h) continue;
    const n = h.length / 3;
    // 同一高さでは入口(下向き面)を先に処理（重なった別メッシュの継ぎ目で区間が途切れないように）
    const order = Array.from({ length: n }, (_, q) => q).sort((p1, p2) => h[p1 * 3] - h[p2 * 3] || h[p1 * 3 + 1] - h[p2 * 3 + 1]);
    const ivs = [];
    let depth = 0, start = 0, last = null;
    for (const q of order) {
      const z = h[q * 3], s = h[q * 3 + 1], tri = h[q * 3 + 2];
      if (s < 0) {
        if (depth === 0) start = z;
        depth++;
      } else if (depth > 0) {
        depth--;
        if (depth === 0) { ivs.push({ b: start, t: z, topTri: tri }); last = z; }
      } else {
        // 入口のない出口（底面の無い開いたメッシュ等）: 直前の境界（なければ最下点）から
        const from = last ?? Math.min(0, z);
        ivs.push({ b: from, t: z, topTri: tri });
        last = z;
      }
    }
    // 近接区間の結合
    ivs.sort((p1, p2) => p1.b - p2.b);
    const merged = [];
    for (const iv of ivs) {
      const m = merged[merged.length - 1];
      if (m && iv.b - m.t < o.vStep) {
        if (iv.t > m.t) { m.t = iv.t; m.topTri = iv.topTri; }
      } else merged.push({ ...iv });
    }
    const out = [];
    for (const iv of merged) {
      if (iv.b < 0) { belowGround += (Math.min(iv.t, 0) - iv.b) * c * c; iv.b = 0; }
      if (iv.t - iv.b > 0.02) out.push(iv);
    }
    if (out.length) cellIv[k] = out;
  }

  // ---- 2. サンプルと領域（底面高さ別の連結成分） ----
  const samples = [];
  const sampleByCell = new Array(nx * ny);
  for (let k = 0; k < cellIv.length; k++) {
    if (!cellIv[k]) continue;
    sampleByCell[k] = [];
    for (const iv of cellIv[k]) {
      const i = k % nx, j = (k / nx) | 0;
      const s = { id: samples.length, k, i, j, x: cx(i), y: cy(j), b: iv.b, t: iv.t, topTri: iv.topTri, qb: Math.round(iv.b / o.stepHeight) };
      samples.push(s);
      sampleByCell[k].push(s);
    }
  }
  const parent = samples.map((_, q) => q);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b2) => { a = find(a); b2 = find(b2); if (a !== b2) parent[a] = b2; };
  for (const s of samples) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      const i2 = s.i + di, j2 = s.j + dj;
      if (i2 >= nx || j2 >= ny) continue;
      const nb = sampleByCell[j2 * nx + i2];
      if (!nb) continue;
      for (const s2 of nb) {
        if (s2.qb === s.qb && Math.min(s.t, s2.t) - Math.max(s.b, s2.b) > 0) union(s.id, s2.id);
      }
    }
  }
  // 小さすぎる領域（曲面の底面などで細分化されたもの）は、z が重なる隣接領域のうち最大のものへ併合
  const minCells = Math.max(1, Math.ceil(o.minPartArea / (c * c)));
  for (let pass = 0; pass < 3; pass++) {
    const size = new Map();
    for (const s of samples) { const r = find(s.id); size.set(r, (size.get(r) || 0) + 1); }
    let merged = 0;
    for (const s of samples) {
      const r = find(s.id);
      if (size.get(r) >= minCells) continue;
      let best = null, bestSize = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const i2 = s.i + di, j2 = s.j + dj;
        if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
        for (const s2 of sampleByCell[j2 * nx + i2] || []) {
          const r2 = find(s2.id);
          if (r2 === r || Math.min(s.t, s2.t) - Math.max(s.b, s2.b) <= 0) continue;
          if (size.get(r2) > bestSize) { bestSize = size.get(r2); best = r2; }
        }
      }
      if (best !== null) { size.set(best, bestSize + size.get(r)); parent[r] = best; merged++; }
    }
    if (!merged) break;
  }
  // 薄い浮遊領域（軒の出・庇）: 隣接する、より低い底面の大きな領域へ併合（壁を軒先まで延長して近似）
  let eavesArea = 0;
  if (o.mergeEaves) {
    const regs = new Map();
    for (const s of samples) { const r = find(s.id); (regs.get(r) || regs.set(r, []).get(r)).push(s); }
    const info = new Map();
    for (const [r, ss] of regs) {
      const th = ss.map((s) => s.t - s.b).sort((a, b) => a - b);
      const cnt = new Map(); for (const s of ss) cnt.set(s.qb, (cnt.get(s.qb) || 0) + 1);
      info.set(r, { n: ss.length, thick: th[th.length >> 1], qb: [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0] });
    }
    for (const [r, ss] of regs) {
      const inf = info.get(r);
      if (inf.qb === 0 || inf.thick >= o.thinMax) continue;
      let best = null;
      for (const s of ss) for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const s2 of sampleByCell[(s.j + dj) * nx + s.i + di] || []) {
          const r2 = find(s2.id);
          if (r2 === find(r) || Math.min(s.t, s2.t) - Math.max(s.b, s2.b) <= 0) continue;
          const i2 = info.get(r2);
          if (i2 && i2.qb < inf.qb && i2.n > inf.n && (!best || i2.n > info.get(best).n)) best = r2;
        }
      }
      if (best !== null) { parent[find(r)] = best; eavesArea += ss.length * c * c; }
    }
  }
  const regionMap = new Map();
  for (const s of samples) {
    const r = find(s.id);
    if (!regionMap.has(r)) regionMap.set(r, []);
    regionMap.get(r).push(s);
  }

  // ---- 3. 分解 ----
  const ctx = { o, grid, parts: [], dropped: [], minCells, guard: 0 };
  const regions = [...regionMap.values()].sort((r1, r2) => r2.length - r1.length);
  for (const reg of regions) {
    // 同一セル重複の除去（併合で生じうる）: 厚い方を残す
    const seen = new Map();
    for (const s of reg) { const e = seen.get(s.k); if (!e || s.t - s.b > e.t - e.b) seen.set(s.k, s); }
    const uniq = [...seen.values()];
    // 最頻の底面量子化レベルで min_height を決める
    const cnt = new Map();
    for (const s of uniq) cnt.set(s.qb, (cnt.get(s.qb) || 0) + 1);
    const qb = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const major = uniq.filter((s) => s.qb === qb);
    const B = qb === 0 ? 0 : major.reduce((a, s) => a + s.b, 0) / major.length;
    decompose(uniq, B, 0, uniq.some((s) => Math.abs(s.b - B) > o.stepHeight * 0.75) ? 'soffit' : 'region', ctx);
  }

  // ---- 4. ポリゴン化 ----
  const tol = o.simplify * c;
  for (const p of ctx.parts) {
    p.polygons = polygonize(p.samples.map((s) => s.k), grid, tol);
    p.area = p.samples.length * c * c;
    p.bbox = ringsBBox(p.polygons);
  }
  ctx.parts = ctx.parts.filter((p) => p.polygons.length > 0);
  ctx.parts.forEach((p, q) => (p.id = q));
  const allCells = [];
  for (let k = 0; k < cellIv.length; k++) if (cellIv[k]) allCells.push(k);
  const outline = polygonize(allCells, grid, tol);

  return {
    options: o, grid, cellIv, samples, parts: ctx.parts, dropped: ctx.dropped, outline,
    belowGround, eavesArea, regionCount: regions.length,
    maxHeight: ctx.parts.reduce((a, p) => Math.max(a, p.H), 0),
  };
}

// ------------------------------------------------------------
// 分解（再帰）
// ------------------------------------------------------------
function decompose(samps, B, depth, origin, ctx) {
  const { o } = ctx;
  if (++ctx.guard > 5000) { ctx.dropped.push({ samples: samps, B, reason: 'limit' }); return; }
  if (samps.length < ctx.minCells) { ctx.dropped.push({ samples: samps, B, reason: 'small' }); return; }
  const obb = orientedBox(samps, ctx.grid.c);
  const pts = samps;

  // (a) 全体フィット → (b) 上方向の外れ値（塔屋・煙突・塔など）を除外して再フィット
  const fit = bestFit(pts, obb, B, o);
  let model = fit, modelObb = obb;
  for (let it = 0; it < 4 && samps.length >= 16; it++) {
    const inl = pts.filter((s) => s.t - model.evalAt(s.x, s.y) <= 2 * o.roofTol);
    if (inl.length < 0.4 * pts.length || inl.length === pts.length) break;
    const out = pts.filter((s) => s.t - model.evalAt(s.x, s.y) > 2 * o.roofTol);
    if (model.ok && !components(out).some((cp) => cp.length >= ctx.minCells)) break; // 有意な突出物なし
    const io = orientedBox(inl, ctx.grid.c);
    const f2 = bestFit(inl, io, B, o);
    model = f2; modelObb = io;
    if (f2.ok) {
      const out2 = pts.filter((s) => s.t - f2.evalAt(s.x, s.y) > 2 * o.roofTol);
      if (pts.length - out2.length < 0.4 * pts.length) break;
      // パート本体は全セル（突出物の下にも屋根が続くとみなす）。突出物は地面(B)から立ち上がる別パート
      emit(samps, B, f2, modelObb, origin, ctx);
      for (const comp of components(out2)) decompose(comp, B, depth + 1, 'protrusion', ctx);
      return;
    }
  }
  if (fit.ok) { emit(samps, B, fit, obb, origin, ctx); return; }

  // (c) 段状（レイヤーケーキ）分解: 最下段の高さで全体をスラブ化し、それより高い部分を再帰処理
  const tops = pts.map((s) => s.t).sort((a, b) => a - b);
  const L = tops[Math.floor(tops.length * 0.02)];
  const band = pts.filter((s) => s.t <= L + o.stepHeight);
  const higher = pts.filter((s) => s.t > L + o.stepHeight);
  // 段に吸収したセルの上面がばらついている = 連続的な曲面/傾斜面を階段で近似している
  const varied = band.filter((s) => s.t - L > 0.25 * o.stepHeight).length > 0.1 * band.length;
  const slabTop = varied ? band.reduce((a, s) => a + s.t, 0) / band.length : L;
  if (slabTop - B >= 0.1) emit(samps, B, flatFit(slabTop), obb, varied ? 'stepped' : origin === 'stepped' ? 'tier' : origin, ctx);
  for (const comp of components(higher)) decompose(comp, Math.max(B, slabTop), depth + 1, 'tier', ctx);
}

function emit(samps, B, fit, obb, origin, ctx) {
  let E = Math.max(fit.E, B);
  const H = fit.shape === 'flat' ? fit.E : E + fit.h;
  if (H - B < 0.05) return;
  ctx.parts.push({
    samples: samps, B, H, E, shape: fit.shape, h: fit.shape === 'flat' ? 0 : H - E,
    rms: fit.rms, obb, origin, fit,
    roofZ: (x, y) => Math.max(B, Math.min(H, fit.evalAt(x, y))),
  });
}

function components(samps) {
  const seen = new Set();
  const comps = [];
  const key = (i, j) => `${i},${j}`;
  const byIJ = new Map(samps.map((s) => [key(s.i, s.j), s]));
  for (const s of samps) {
    if (seen.has(s.k)) continue;
    const comp = [];
    const stack = [s];
    seen.add(s.k);
    while (stack.length) {
      const a = stack.pop();
      comp.push(a);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = byIJ.get(key(a.i + di, a.j + dj));
        if (nb && !seen.has(nb.k)) { seen.add(nb.k); stack.push(nb); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// ------------------------------------------------------------
// 屋根フィット
// ------------------------------------------------------------
function flatFit(H) {
  return { shape: 'flat', E: H, h: 0, rms: 0, ok: true, evalAt: () => H };
}

/** 形状関数 f(u,v) ∈ [0,1]。u: 長辺方向, v: 短辺方向（OBB 中心原点） */
function shapeFn(shape, obb) {
  const { hu, hv } = obb;
  switch (shape) {
    case 'gabled': return (u, v) => Math.max(0, 1 - Math.abs(v) / hv);
    case 'gabled_across': return (u, v) => Math.max(0, 1 - Math.abs(u) / hu);
    case 'hipped': return (u, v) => Math.max(0, Math.min(1 - Math.abs(v) / hv, (hu - Math.abs(u)) / hv));
    case 'pyramidal': return (u, v) => Math.max(0, 1 - Math.max(Math.abs(u) / hu, Math.abs(v) / hv));
    case 'round': return (u, v) => Math.sqrt(Math.max(0, 1 - (v / hv) ** 2));
    case 'dome': return (u, v) => Math.sqrt(Math.max(0, 1 - (u / hu) ** 2 - (v / hv) ** 2));
    case 'cone': return (u, v) => Math.max(0, 1 - Math.sqrt((u / hu) ** 2 + (v / hv) ** 2));
    default: return null;
  }
}

function bestFit(pts, obb, B, o) {
  const n = pts.length;
  let mean = 0;
  for (const s of pts) mean += s.t;
  mean /= n;
  let ss = 0;
  for (const s of pts) ss += (s.t - mean) ** 2;
  const flatRms = Math.sqrt(ss / n);
  const flatTol = Math.min(o.roofTol, o.vStep * 0.5);
  const cands = [];
  const flat = { ...flatFit(mean), rms: flatRms, obb };
  cands.push(flat);
  if (flatRms <= flatTol) { flat.ok = true; flat.cands = cands; return flat; }

  // skillion: 平面フィット
  if (n >= 9) {
    const mx = pts.reduce((a, s) => a + s.x, 0) / n, my = pts.reduce((a, s) => a + s.y, 0) / n;
    let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
    for (const s of pts) {
      const dx = s.x - mx, dy = s.y - my, dz = s.t - mean;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * dz; syz += dy * dz;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) > 1e-9) {
      const p1 = (sxz * syy - syz * sxy) / det, p2 = (syz * sxx - sxz * sxy) / det;
      const plane = (x, y) => mean + p1 * (x - mx) + p2 * (y - my);
      let r = 0, lo = Infinity, hi = -Infinity;
      for (const s of pts) { const z = plane(s.x, s.y); r += (s.t - z) ** 2; lo = Math.min(lo, z); hi = Math.max(hi, z); }
      const dirLocal = ((Math.atan2(-p1, -p2) * 180) / Math.PI + 360) % 360; // 下り方向の方位角
      cands.push({ shape: 'skillion', E: lo, h: hi - lo, rms: Math.sqrt(r / n), evalAt: plane, dirLocal, obb });
    }
  }
  // その他プリセット: z = E + h·f(u,v) を線形最小二乗
  if (n >= 9) {
    const cos = Math.cos(obb.angle), sin = Math.sin(obb.angle);
    const uv = pts.map((s) => {
      const dx = s.x - obb.cx, dy = s.y - obb.cy;
      return [dx * cos + dy * sin, -dx * sin + dy * cos];
    });
    for (const shape of SHAPES.slice(2)) {
      const f = shapeFn(shape, obb);
      let sf = 0, sff = 0, sz = 0, sfz = 0;
      const fv = new Float64Array(n);
      for (let q = 0; q < n; q++) {
        const v = f(uv[q][0], uv[q][1]);
        fv[q] = v; sf += v; sff += v * v; sz += pts[q].t; sfz += v * pts[q].t;
      }
      const den = n * sff - sf * sf;
      if (Math.abs(den) < 1e-9) continue;
      const h = (n * sfz - sf * sz) / den;
      const E = (sz - h * sf) / n;
      if (h <= 0) continue;
      let r = 0;
      for (let q = 0; q < n; q++) r += (pts[q].t - E - h * fv[q]) ** 2;
      const evalAt = (x, y) => {
        const dx = x - obb.cx, dy = y - obb.cy;
        return E + h * f(dx * cos + dy * sin, -dx * sin + dy * cos);
      };
      cands.push({ shape, E, h, rms: Math.sqrt(r / n), evalAt, obb });
    }
  }
  // 単純な形状を優先（RMS が 10% 以内なら前の候補）
  let best = cands[0];
  for (const cd of cands) if (cd.rms < best.rms * 0.9) best = cd;
  best.cands = cands;
  const maxTop = pts.reduce((a, s) => Math.max(a, s.t), -Infinity);
  best.ok = best.rms <= o.roofTol && (best.shape === 'flat' || (best.h >= 0.3 && best.E >= B - o.roofTol && best.E + best.h <= maxTop + o.roofTol));
  return best;
}

// ------------------------------------------------------------
// 最小外接矩形 (OBB)
// ------------------------------------------------------------
export function orientedBox(samps, c) {
  const pts = [];
  const h = c / 2;
  for (const s of samps) pts.push([s.x - h, s.y - h], [s.x + h, s.y - h], [s.x + h, s.y + h], [s.x - h, s.y + h]);
  const hull = convexHull(pts);
  let best = null;
  for (let q = 0; q < hull.length; q++) {
    const a = hull[q], b = hull[(q + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of hull) {
      const u = p[0] * cos + p[1] * sin, v = -p[0] * sin + p[1] * cos;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area - 1e-9) best = { area, ang, u0, u1, v0, v1 };
  }
  let { ang, u0, u1, v0, v1 } = best;
  let hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const cx = uc * cos - vc * sin, cy = uc * sin + vc * cos;
  if (hv > hu) { [hu, hv] = [hv, hu]; ang += Math.PI / 2; }
  return { cx, cy, angle: ang, hu, hv };
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let k = p.length - 1; k >= 0; k--) { const q = p[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// ------------------------------------------------------------
// セル集合 → ポリゴン（外周 CCW / 穴 CW）
// ------------------------------------------------------------
export function polygonize(cellKeys, grid, tol) {
  const { nx, c, x0, y0 } = grid;
  const set = new Set(cellKeys);
  const W = nx + 1;
  const vid = (i, j) => j * W + i;
  const out = new Map(); // start vertex -> [edges]
  const edges = [];
  const add = (a, b) => { const e = { a, b, used: false }; edges.push(e); (out.get(a) || out.set(a, []).get(a)).push(e); };
  for (const k of set) {
    const i = k % nx, j = (k / nx) | 0;
    if (!set.has(k - nx) || j === 0) add(vid(i, j), vid(i + 1, j));
    if (!set.has(k + 1) || i === nx - 1) add(vid(i + 1, j), vid(i + 1, j + 1));
    if (!set.has(k + nx)) add(vid(i + 1, j + 1), vid(i, j + 1));
    if (!set.has(k - 1) || i === 0) add(vid(i, j + 1), vid(i, j));
  }
  const xyOf = (v) => [x0 + (v % W) * c, y0 + ((v / W) | 0) * c];
  const rings = [];
  for (const e0 of edges) {
    if (e0.used) continue;
    const ring = [];
    let e = e0;
    while (e && !e.used) {
      e.used = true;
      ring.push(e.a);
      const cand = (out.get(e.b) || []).filter((x) => !x.used);
      if (cand.length <= 1) e = cand[0];
      else {
        // ピンチ点: 左折を優先
        const [ax, ay] = xyOf(e.a), [bx, by] = xyOf(e.b);
        const dx = bx - ax, dy = by - ay;
        cand.sort((p, q) => turn(p) - turn(q));
        e = cand[0];
        function turn(x) { const [qx, qy] = xyOf(x.b); const ex = qx - bx, ey = qy - by; const cr = dx * ey - dy * ex; return cr > 0 ? 0 : cr === 0 ? 1 : 2; }
      }
    }
    if (ring.length >= 4) rings.push(ring.map(xyOf));
  }
  // 簡略化
  const simp = [];
  for (const r of rings) {
    let s = removeCollinear(r);
    if (tol > 0) s = simplifyRing(s, tol);
    if (s.length >= 3 && Math.abs(signedArea(s)) > 1e-6) simp.push(s);
  }
  const outers = simp.filter((r) => signedArea(r) > 0).map((r) => ({ outer: r, holes: [], area: signedArea(r) }));
  outers.sort((a, b) => a.area - b.area);
  for (const h of simp.filter((r) => signedArea(r) < 0)) {
    const host = outers.find((p) => pointInRing(h[0][0] + 1e-7, h[0][1] + 1e-7, p.outer) || pointInRing(centroid(h)[0], centroid(h)[1], p.outer));
    if (host) host.holes.push(h);
  }
  return outers.map(({ outer, holes }) => ({ outer, holes }));
}

function removeCollinear(r) {
  const out = [];
  const n = r.length;
  for (let q = 0; q < n; q++) {
    const a = r[(q - 1 + n) % n], b = r[q], d = r[(q + 1) % n];
    const cr = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(cr) > 1e-12) out.push(b);
  }
  return out;
}

function simplifyRing(r, tol) {
  if (r.length <= 4) return r;
  // 最遠点ペアで分割して開いたポリライン 2 本として DP
  let far = 0, fd = -1;
  for (let q = 1; q < r.length; q++) { const d = (r[q][0] - r[0][0]) ** 2 + (r[q][1] - r[0][1]) ** 2; if (d > fd) { fd = d; far = q; } }
  const a = dp(r.slice(0, far + 1), tol);
  const b = dp(r.slice(far).concat([r[0]]), tol);
  const res = a.slice(0, -1).concat(b.slice(0, -1));
  return res.length >= 3 ? res : r;
}

function dp(pts, tol) {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  let idx = -1, md = -1;
  for (let q = 1; q < pts.length - 1; q++) {
    const d = segDist(pts[q][0], pts[q][1], ax, ay, bx, by);
    if (d > md) { md = d; idx = q; }
  }
  if (md <= tol) return [pts[0], pts[pts.length - 1]];
  const l = dp(pts.slice(0, idx + 1), tol), r = dp(pts.slice(idx), tol);
  return l.slice(0, -1).concat(r);
}

export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

export function signedArea(r) {
  let a = 0;
  for (let q = 0; q < r.length; q++) { const p = r[q], n = r[(q + 1) % r.length]; a += p[0] * n[1] - n[0] * p[1]; }
  return a / 2;
}

function centroid(r) {
  let x = 0, y = 0;
  for (const p of r) { x += p[0]; y += p[1]; }
  return [x / r.length, y / r.length];
}

export function pointInRing(x, y, r) {
  let inside = false;
  for (let q = 0, p = r.length - 1; q < r.length; p = q++) {
    const xi = r[q][0], yi = r[q][1], xj = r[p][0], yj = r[p][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** パートのポリゴン群に点が含まれるか（偶奇規則） */
export function pointInPolygons(x, y, polys) {
  let inside = false;
  for (const p of polys) {
    if (pointInRing(x, y, p.outer)) inside = !inside;
    for (const h of p.holes) if (pointInRing(x, y, h)) inside = !inside;
  }
  return inside;
}

function ringsBBox(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [x0, y0, x1, y1];
}
