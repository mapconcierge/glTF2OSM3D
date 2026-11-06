// メッシュ群 → 解析用モデル（DOM 非依存）
// 入力メッシュは ENU (x=東, y=北, z=上, m) に変換済みのワールド座標三角形。

/**
 * @param {{tris: Float32Array|number[], mat: number}[]} meshes  tris は 9 値/三角形
 * @param {{color:number[], name:string}[]} materials  color は sRGB 0..1
 * @param {{groundOffset?: number, center?: boolean}} opt
 */
export function buildModel(meshes, materials, opt = {}) {
  let n = 0;
  // 9 の倍数でない端数（不完全な三角形）は捨てる
  meshes = meshes.map((m) => ({ ...m, tris: m.tris.length % 9 ? m.tris.subarray(0, m.tris.length - (m.tris.length % 9)) : m.tris }));
  for (const m of meshes) n += m.tris.length;
  const tris = new Float32Array(n);
  const triMat = new Uint32Array(n / 9);
  let off = 0, flipped = 0;
  for (const m of meshes) {
    const t = m.tris;
    // メッシュ単位で符号付き体積を計算し、負なら面の向きを反転（内向き法線のモデル対策）
    let mx = 0, my = 0, mz = 0;
    for (let q = 0; q < t.length; q += 3) { mx += t[q]; my += t[q + 1]; mz += t[q + 2]; }
    const k = t.length / 3 || 1;
    mx /= k; my /= k; mz /= k;
    let vol = 0;
    for (let q = 0; q < t.length; q += 9) {
      const ax = t[q] - mx, ay = t[q + 1] - my, az = t[q + 2] - mz;
      const bx = t[q + 3] - mx, by = t[q + 4] - my, bz = t[q + 5] - mz;
      const cx = t[q + 6] - mx, cy = t[q + 7] - my, cz = t[q + 8] - mz;
      vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    const flip = vol < -1e-9;
    if (flip) flipped++;
    for (let q = 0; q < t.length; q += 9) {
      tris.set([t[q], t[q + 1], t[q + 2]], off);
      if (flip) { tris.set([t[q + 6], t[q + 7], t[q + 8]], off + 3); tris.set([t[q + 3], t[q + 4], t[q + 5]], off + 6); }
      else { tris.set([t[q + 3], t[q + 4], t[q + 5]], off + 3); tris.set([t[q + 6], t[q + 7], t[q + 8]], off + 6); }
      triMat[off / 9] = m.mat;
      off += 9;
    }
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let q = 0; q < tris.length; q += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], tris[q + a]); max[a] = Math.max(max[a], tris[q + a]); }
  // 原点 = バウンディングボックス底面中心、z=0 が地盤面
  const shift = [opt.center === false ? 0 : (min[0] + max[0]) / 2, opt.center === false ? 0 : (min[1] + max[1]) / 2, min[2] + (opt.groundOffset || 0)];
  for (let q = 0; q < tris.length; q += 3) for (let a = 0; a < 3; a++) tris[q + a] -= shift[a];
  for (let a = 0; a < 3; a++) { min[a] -= shift[a]; max[a] -= shift[a]; }
  const valid = tris.every(Number.isFinite);
  return { tris, triMat, materials, bbox: { min, max }, stats: { meshes: meshes.length, triangles: tris.length / 9, flipped, valid } };
}
