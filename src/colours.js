// glTF マテリアル色（baseColorFactor × テクスチャ平均色）→ building:colour / roof:colour
// テクスチャの模様そのものは OSM では表現できないため、平均色のみを用いる。

const hex = (rgb) => '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');

export function assignColours(model, res) {
  const { tris, triMat, materials } = model;
  const { grid } = res;
  const { nx, c, x0, y0 } = grid;
  // 屋根色: 各パートのセル上面ヒット三角形のマテリアル最頻値
  for (const p of res.parts) {
    const count = new Map();
    for (const s of p.samples) {
      if (Math.abs(s.t - p.roofZ(s.x, s.y)) > 1.0) continue; // 外れ値（塔屋など）は除外
      const m = triMat[s.topTri];
      count.set(m, (count.get(m) || 0) + 1);
    }
    const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) p.roofColour = hex(materials[best[0]].color);
  }
  // 壁色: 鉛直に近い三角形を面積重み付きで近傍パートへ割当
  const cellParts = new Map();
  res.parts.forEach((p) => { for (const s of p.samples) { const a = cellParts.get(s.k) || []; a.push(p); cellParts.set(s.k, a); } });
  const acc = new Map(); // part -> Map(mat->area)
  const total = new Map();
  for (let t = 0; t < tris.length / 9; t++) {
    const p = t * 9;
    const ux = tris[p + 3] - tris[p], uy = tris[p + 4] - tris[p + 1], uz = tris[p + 5] - tris[p + 2];
    const vx = tris[p + 6] - tris[p], vy = tris[p + 7] - tris[p + 1], vz = tris[p + 8] - tris[p + 2];
    const nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
    const len = Math.hypot(nxv, nyv, nzv);
    if (len < 1e-12 || Math.abs(nzv / len) > 0.3) continue;
    const area = len / 2, m = triMat[t];
    total.set(m, (total.get(m) || 0) + area);
    const gx = (tris[p] + tris[p + 3] + tris[p + 6]) / 3, gy = (tris[p + 1] + tris[p + 4] + tris[p + 7]) / 3, gz = (tris[p + 2] + tris[p + 5] + tris[p + 8]) / 3;
    const i = Math.floor((gx - x0) / c), j = Math.floor((gy - y0) / c);
    let found = null;
    for (let dj = -1; dj <= 1 && !found; dj++) for (let di = -1; di <= 1 && !found; di++) {
      for (const pp of cellParts.get((j + dj) * nx + (i + di)) || []) if (gz >= pp.B - 0.1 && gz <= pp.E + 0.1) { found = pp; break; }
    }
    if (!found) continue;
    const a = acc.get(found) || new Map();
    a.set(m, (a.get(m) || 0) + area);
    acc.set(found, a);
  }
  for (const [p, a] of acc) {
    const best = [...a.entries()].sort((x, y) => y[1] - x[1])[0];
    if (best) p.wallColour = hex(materials[best[0]].color);
  }
  const tb = [...total.entries()].sort((x, y) => y[1] - x[1])[0];
  if (tb) res.wallColour = hex(materials[tb[0]].color);
}
