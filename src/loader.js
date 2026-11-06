// glTF / GLB 読み込み（three.js GLTFLoader）→ ENU 三角形群
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildModel } from './model.js';

function makeLoader(manager) {
  const loader = new GLTFLoader(manager);
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/** File の配列（.gltf + .bin + テクスチャの複数選択に対応） */
export async function loadFromFiles(files) {
  files = [...files];
  const main = files.find((f) => /\.glb$/i.test(f.name)) || files.find((f) => /\.gltf$/i.test(f.name));
  if (!main) throw new Error('.glb または .gltf ファイルを選択してください');
  const urls = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]);
    return urls.get(name) ?? url;
  });
  try {
    const gltf = await makeLoader(manager).loadAsync(urls.get(main.name));
    return { gltf, name: main.name };
  } finally {
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 5000);
  }
}

export async function loadFromUrl(url) {
  const gltf = await makeLoader().loadAsync(url);
  return { gltf, name: url.split('/').pop() };
}

/** テクスチャの平均色（sRGB 0..1）。取得できなければ null */
function textureAverage(tex) {
  const img = tex?.image;
  if (!img || !img.width) return null;
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 16;
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let q = 0; q < d.length; q += 4) { if (d[q + 3] < 10) continue; r += d[q]; gg += d[q + 1]; b += d[q + 2]; n++; }
    return n ? [r / n / 255, gg / n / 255, b / n / 255] : null;
  } catch {
    return null;
  }
}

/**
 * glTF シーン → 解析用モデル
 * @param {{upAxis:'y'|'z', scale:number, groundOffset:number}} opt
 */
export function sceneToModel(scene, opt) {
  scene.updateMatrixWorld(true);
  // glTF (Y-up, +Z=手前) → ENU: E=x, N=-z, U=y
  const conv = opt.upAxis === 'z' ? new THREE.Matrix4() : new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  const S = new THREE.Matrix4().makeScale(opt.scale, opt.scale, opt.scale);
  const matIndex = new Map();
  const materials = [];
  const matOf = (m) => {
    if (!m) m = { uuid: 'default', name: 'default', color: new THREE.Color(0xcccccc) };
    if (matIndex.has(m.uuid)) return matIndex.get(m.uuid);
    const c = m.color ? m.color.clone() : new THREE.Color(0xcccccc);
    let rgb = [0, 0, 0];
    ({ r: rgb[0], g: rgb[1], b: rgb[2] } = c.getRGB(new THREE.Color(), THREE.SRGBColorSpace));
    const tAvg = textureAverage(m.map);
    if (tAvg) rgb = rgb.map((v, q) => v * tAvg[q]);
    matIndex.set(m.uuid, materials.length);
    materials.push({ name: m.name || `material_${materials.length}`, color: rgb, textured: !!m.map });
    return materials.length - 1;
  };
  const meshes = [];
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (o.isSkinnedMesh) console.warn('SkinnedMesh はバインドポーズで処理します:', o.name);
    const M = new THREE.Matrix4().multiplyMatrices(S, conv).multiply(o.matrixWorld);
    const flip = M.determinant() < 0;
    const g = o.geometry;
    const pos = g.attributes.position;
    const index = g.index ? g.index.array : null;
    const count = index ? index.length : pos.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const gr of groups) {
      const end = Math.min(count, gr.start + gr.count);
      const tris = new Float32Array(Math.floor((end - gr.start) / 3) * 9);
      let w = 0;
      for (let q = gr.start; q + 2 < end; q += 3) {
        const ids = [q, q + 1, q + 2].map((x) => (index ? index[x] : x));
        if (flip) [ids[1], ids[2]] = [ids[2], ids[1]];
        for (const id of ids) {
          v.fromBufferAttribute(pos, id).applyMatrix4(M);
          tris[w++] = v.x; tris[w++] = v.y; tris[w++] = v.z;
        }
      }
      meshes.push({ tris, mat: matOf(mats[gr.materialIndex ?? 0] || mats[0]) });
    }
  });
  if (!meshes.length) throw new Error('三角形メッシュが見つかりません');
  return buildModel(meshes, materials, { groundOffset: opt.groundOffset });
}
