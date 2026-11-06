// 2 段パイプライン（単純化 → OSM 変換）の Node テスト
//   node scripts/test-simplify.mjs model.glb
import { NodeIO } from '@gltf-transform/core';
import { buildModel } from '../src/model.js';
import { analyze, voxelize } from '../src/analyze.js';
import { evaluate, compareVolumes } from '../src/evaluate.js';
import { simplifyModel, meshesToModel } from '../src/simplify.js';

const doc = await new NodeIO().read(process.argv[2]);
const root = doc.getRoot();
const mats = root.listMaterials();
const meshes = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const W = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const pos = prim.getAttribute('POSITION').getArray();
    const idx = prim.getIndices()?.getArray() ?? Array.from({ length: pos.length / 3 }, (_, q) => q);
    const tris = new Float32Array(idx.length * 3);
    for (let q = 0; q < idx.length; q++) {
      const x = pos[idx[q] * 3], y = pos[idx[q] * 3 + 1], z = pos[idx[q] * 3 + 2];
      tris[q * 3] = W[0] * x + W[4] * y + W[8] * z + W[12];
      tris[q * 3 + 1] = -(W[2] * x + W[6] * y + W[10] * z + W[14]);
      tris[q * 3 + 2] = W[1] * x + W[5] * y + W[9] * z + W[13];
    }
    meshes.push({ tris, mat: Math.max(0, mats.indexOf(prim.getMaterial())) });
  }
}
const model = buildModel(meshes, mats.map((m) => ({ name: m.getName(), color: [0.8, 0.8, 0.8] })));
let t0 = performance.now();
const simp = simplifyModel(model, {});
const disp = meshesToModel(simp.display, model.materials);
const plain = meshesToModel(simp.plain, model.materials);
console.log(`simplify ${(performance.now() - t0).toFixed(0)} ms regions=${simp.regions.length} tris ${model.stats.triangles} -> display ${disp.stats.triangles} / plain ${plain.stats.triangles}`, simp.stats);
// ステージ1の体積比較（元モデル基準）
const ref = voxelize(model, { cellSize: 0, vStep: 0.5 });
const v1 = compareVolumes(ref.cellIv, voxelize(disp, { vStep: 0.5 }, ref.grid).cellIv, ref.grid);
console.log('stage1 IoU', v1.iou.toFixed(3), 'lost', v1.lost.toFixed(1), 'added', v1.added.toFixed(1));
// ステージ2
t0 = performance.now();
const res = analyze(plain, {});
const origIv = voxelize(model, { vStep: res.options.vStep }, res.grid).cellIv;
const ev = evaluate(model, res, { origIv });
const shapes = {};
for (const p of res.parts) { const k = p.origin === 'stepped' ? 'stepped' : p.shape; shapes[k] = (shapes[k] || 0) + 1; }
console.log(`stage2 ${(performance.now() - t0).toFixed(0)} ms parts=${res.parts.length}`, JSON.stringify(shapes), `IoU(vs original)=${ev.iou.toFixed(3)} lost=${ev.lost.toFixed(1)} added=${ev.added.toFixed(1)}`);
const direct = analyze(model, {});
const ds = {};
for (const p of direct.parts) { const k = p.origin === 'stepped' ? 'stepped' : p.shape; ds[k] = (ds[k] || 0) + 1; }
console.log(`direct (no simplify) parts=${direct.parts.length}`, JSON.stringify(ds));
