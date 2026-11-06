// サンプル glTF (GLB) 生成スクリプト
//   node scripts/make-samples.mjs
// 建物は ENU (x=東, y=北, z=上, m) で作成し、glTF 規約 (Y-up, +Z が手前=南) に変換して書き出す。
import * as THREE from 'three';
import { Document, NodeIO } from '@gltf-transform/core';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../public/samples/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexToLinear = (h) => [0, 2, 4].map((o) => srgbToLinear(parseInt(h.slice(1 + o, 3 + o), 16) / 255));

/** ENU 座標の BufferGeometry をまとめて GLB に */
async function writeGlb(name, items) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene(name);
  for (const { geom, color, label } of items) {
    const g = geom.index ? geom : geom.clone();
    const pos = g.getAttribute('position');
    const n = pos.count;
    let idx = g.index ? Array.from(g.index.array) : Array.from({ length: n }, (_, q) => q);
    // 符号付き体積が負なら面の向きを反転（外向き法線を保証）
    let vol = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
      const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
      const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
      vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    if (vol < 0) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    // ENU -> glTF (x=E, y=U, z=-N)
    const p = new Float32Array(n * 3);
    for (let q = 0; q < n; q++) { p[q * 3] = pos.getX(q); p[q * 3 + 1] = pos.getZ(q); p[q * 3 + 2] = -pos.getY(q); }
    const posAcc = doc.createAccessor().setType('VEC3').setArray(p).setBuffer(buf);
    const idxAcc = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buf);
    const mat = doc.createMaterial(label).setBaseColorFactor([...hexToLinear(color), 1]).setRoughnessFactor(0.8).setMetallicFactor(0);
    const prim = doc.createPrimitive().setAttribute('POSITION', posAcc).setIndices(idxAcc).setMaterial(mat);
    const mesh = doc.createMesh(label).addPrimitive(prim);
    scene.addChild(doc.createNode(label).setMesh(mesh));
  }
  await new NodeIO().write(new URL(name, OUT).pathname, doc);
  console.log('wrote', name);
}

const box = (sx, sy, sz, x, y, z0) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z0 + sz / 2);
/** Y-up で作られた three のジオメトリを ENU (Z-up) へ */
const yUpToEnu = (g) => g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1));

// ---------- 1. 切妻屋根の住宅（ほぼ OSM で表現可能） ----------
{
  const walls = box(10, 7, 6, 0, 0, 0);
  // 切妻屋根（棟は東西方向、軒の出 0.4 m）: 南北断面の三角形を東西に押し出し
  const shape = new THREE.Shape([new THREE.Vector2(-3.9, 0), new THREE.Vector2(3.9, 0), new THREE.Vector2(0, 3.2)]);
  const roof = new THREE.ExtrudeGeometry(shape, { depth: 10.8, bevelEnabled: false });
  // shape (X=北, Y=上), 押し出し Z=東 → ENU
  roof.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, -5.4, 1, 0, 0, 0, 0, 1, 0, 5.8, 0, 0, 0, 1));
  const chimney = box(0.8, 0.8, 5.5, 2.5, 1.5, 5);
  await writeGlb('house_gabled.glb', [
    { geom: walls, color: '#e8dcc8', label: 'walls' },
    { geom: roof, color: '#8b3a2f', label: 'roof' },
    { geom: chimney, color: '#6d6d6d', label: 'chimney' },
  ]);
}

// ---------- 2. 複合ビル（表現可能な要素と不可能な要素の混在） ----------
{
  const items = [];
  items.push({ geom: box(30, 20, 8, 0, 0, 0), color: '#c9c3b8', label: 'podium' });
  items.push({ geom: box(12, 12, 40, 6, 0, 0), color: '#9fb6c8', label: 'tower' });
  // ドーム（閉じた半球）
  const dome = yUpToEnu(new THREE.SphereGeometry(5.5, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2)).translate(6, 0, 40);
  const disc = yUpToEnu(new THREE.CircleGeometry(5.5, 48).rotateX(Math.PI / 2)).translate(6, 0, 40);
  items.push({ geom: mergeClosed([dome, disc]), color: '#d4af37', label: 'dome' });
  // キャンチレバー（宙に浮いた張り出し）
  items.push({ geom: box(8, 6, 4, 16, 0, 16), color: '#7f9db0', label: 'cantilever' });
  // ヴォールト屋根（半円筒、南北軸）
  items.push({ geom: closedVault(4, 9).translate(-10, 5, 8), color: '#a0522d', label: 'vault' });
  // 円錐台（テーパー：鉛直押し出しでは表現不可）
  const frustum = yUpToEnu(new THREE.CylinderGeometry(2.5, 5, 14, 48)).translate(-8, -5, 8 + 7);
  items.push({ geom: frustum, color: '#b5a642', label: 'frustum' });
  // アーチ門（下向きの曲面：min_height では表現不可）
  const sh = new THREE.Shape();
  sh.moveTo(-4, 0); sh.lineTo(-2.5, 0); sh.lineTo(-2.5, 3);
  for (let q = 1; q < 24; q++) { const a = Math.PI - (Math.PI * q) / 24; sh.lineTo(2.5 * Math.cos(a), 3 + 2.5 * Math.sin(a)); }
  sh.lineTo(2.5, 3); sh.lineTo(2.5, 0); sh.lineTo(4, 0); sh.lineTo(4, 9); sh.lineTo(-4, 9); sh.closePath();
  const gate = new THREE.ExtrudeGeometry(sh, { depth: 4, bevelEnabled: false });
  // (X=北, Y=上, Z=東) → ENU
  gate.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 15.5, 1, 0, 0, -6, 0, 1, 0, 0, 0, 0, 0, 1));
  items.push({ geom: gate, color: '#8e7f6f', label: 'arch_gate' });
  await writeGlb('complex_tower.glb', items);
}

// ---------- 3. 自由曲面タワー（回転体、壁が曲面） ----------
{
  const prof = [new THREE.Vector2(0, 0)];
  for (let q = 0; q <= 40; q++) { const z = q; prof.push(new THREE.Vector2(4 + 5 * Math.sin((Math.PI * z) / 44), z)); }
  prof.push(new THREE.Vector2(0, 40));
  const lathe = yUpToEnu(new THREE.LatheGeometry(prof, 64));
  await writeGlb('curved_tower.glb', [{ geom: mergeClosed([lathe]), color: '#5f8f7a', label: 'shell' }]);
}

/** 半円筒ヴォールト（両端閉じ）: 軸 = 北, 半径 r, 長さ L, 底面中心が原点 */
function closedVault(r, L) {
  const sh = new THREE.Shape();
  sh.moveTo(-r, 0);
  for (let q = 1; q < 48; q++) { const a = Math.PI - (Math.PI * q) / 48; sh.lineTo(r * Math.cos(a), r * Math.sin(a)); }
  sh.lineTo(r, 0); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: L, bevelEnabled: false, curveSegments: 48 });
  // (X=東, Y=上, Z=北) → ENU、北方向中央寄せ
  return g.applyMatrix4(new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, -L / 2, 0, 1, 0, 0, 0, 0, 0, 1));
}

function mergeClosed(geoms) {
  const ps = [];
  for (const g of geoms) {
    const ng = g.index ? g.toNonIndexed() : g;
    ps.push(...ng.getAttribute('position').array);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(ps, 3));
  return out;
}
