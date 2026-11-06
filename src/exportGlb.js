// 解析用モデル（ENU, z-up）→ GLB（glTF 2.0, Y-up）
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { modelGeometry } from './viewer.js';

export async function exportGlb(model, { title } = {}) {
  // 折り目法線を付けた後、位置・法線・色が同一の頂点を統合してインデックス化（データ量削減）
  const geom = mergeVertices(modelGeometry(model, true), 1e-4);
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
  mesh.name = 'simplified_building';
  // ENU (x=東, y=北, z=上) → glTF (x=東, y=上, z=南)
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  root.matrix.set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
  root.add(mesh);
  const scene = new THREE.Scene();
  scene.add(root);
  scene.userData = { title, generator: 'glTF2OSM3D simplify' };
  return new GLTFExporter().parseAsync(scene, { binary: true });
}
