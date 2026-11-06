// Node 上での変換テスト（ブラウザ UI を介さずエンジンを検証）
//   node scripts/test-convert.mjs public/samples/complex_tower.glb [out.osm]
import { NodeIO } from '@gltf-transform/core';
import { writeFileSync } from 'node:fs';
import { buildModel } from '../src/model.js';
import { analyze } from '../src/analyze.js';
import { evaluate } from '../src/evaluate.js';
import { assignColours } from '../src/colours.js';
import { buildOsm } from '../src/osm.js';

const file = process.argv[2];
const doc = await new NodeIO().read(file);
const root = doc.getRoot();
const mats = root.listMaterials();
const lin2srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const materials = mats.map((m) => ({ name: m.getName(), color: m.getBaseColorFactor().slice(0, 3).map(lin2srgb) }));
const meshes = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const W = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const idx = prim.getIndices()?.getArray() ?? Array.from({ length: pos.length / 3 }, (_, q) => q);
    const tris = new Float32Array(idx.length * 3);
    for (let q = 0; q < idx.length; q++) {
      const x = pos[idx[q] * 3], y = pos[idx[q] * 3 + 1], z = pos[idx[q] * 3 + 2];
      const wx = W[0] * x + W[4] * y + W[8] * z + W[12], wy = W[1] * x + W[5] * y + W[9] * z + W[13], wz = W[2] * x + W[6] * y + W[10] * z + W[14];
      tris[q * 3] = wx; tris[q * 3 + 1] = -wz; tris[q * 3 + 2] = wy; // glTF Y-up → ENU
    }
    meshes.push({ tris, mat: Math.max(0, mats.indexOf(prim.getMaterial())) });
  }
}
const model = buildModel(meshes, materials);
console.log('model', model.stats, 'bbox', model.bbox.min.map((v) => v.toFixed(2)), model.bbox.max.map((v) => v.toFixed(2)));
let t0 = performance.now();
const res = analyze(model, {});
assignColours(model, res);
console.log(`analyze ${(performance.now() - t0).toFixed(0)} ms, cell=${res.grid.c} grid=${res.grid.nx}x${res.grid.ny} regions=${res.regionCount} parts=${res.parts.length} dropped=${res.dropped.length}`);
for (const p of res.parts) {
  console.log(`  part#${p.id} ${p.shape.padEnd(13)} B=${p.B.toFixed(2)} E=${p.E.toFixed(2)} H=${p.H.toFixed(2)} area=${p.area.toFixed(1)} rms=${p.rms.toFixed(3)} origin=${p.origin} rings=${p.polygons.map((q) => q.outer.length + '+' + q.holes.length).join(',')} wall=${p.wallColour} roof=${p.roofColour}`);
}
t0 = performance.now();
const ev = evaluate(model, res, { errTol: 0.5 });
console.log(`evaluate ${(performance.now() - t0).toFixed(0)} ms  Vorig=${ev.vOrig.toFixed(1)} Vrec=${ev.vRec.toFixed(1)} IoU=${ev.iou.toFixed(3)} lost=${ev.lost.toFixed(1)} added=${ev.added.toFixed(1)} maxErr=${ev.maxErr.toFixed(2)} verts=${ev.mesh.pos.length / 3}`);
for (const [k, v] of Object.entries(ev.cats)) console.log(`  ${k.padEnd(12)} area=${v.area.toFixed(1)} bad=${v.bad.toFixed(1)}`);
const osm = buildOsm(res, { lon: 139.7, lat: 35.66, heading: 0 }, { colours: true, levels: false, floorHeight: 3 });
console.log('osm', osm.stats);
if (process.argv[3]) writeFileSync(process.argv[3], osm.xml);
if (process.env.DBG) {
  const p = res.parts[+process.env.DBG];
  const ks = new Set(p.samples.map((s) => s.k));
  const { nx } = res.grid;
  let shown = 0;
  for (const s of p.samples) {
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k2 = (s.j + dj) * nx + s.i + di;
      if (!ks.has(k2) && res.cellIv[k2] && shown < 6) { shown++; console.log('nb missing', s.i + di, s.j + dj, JSON.stringify(res.cellIv[k2].map((v) => [v.b.toFixed(2), v.t.toFixed(2)])), 'self', s.b.toFixed(2), s.t.toFixed(2)); }
    }
  }
}
