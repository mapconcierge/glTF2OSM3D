// Navara（MapLibre ファミリーの 3D 地球儀エンジン, @navaramap/three）による配置用地図
// - OSM 復元形状（roof:shape を含む）と元 glTF を three.js オブジェクトとして経緯度・方位で地形上に配置
// - 背景: OSM 標準（既定）/ 任意 XYZ / OpenFreeMap（MapLibre スタイルプラグイン, experimental。
//   v0.2.1 では道路等が描画されず建物も隠れるため既定にしていない）
// - 地形: Mapterhorn 標高タイル（terrarium, 512px）
// 注意: Navara は地球儀表示のみで、Web メルカトル（2D）投影モードは提供されていない（v0.2.1 時点）。
import * as THREE from 'three';
import ThreeView, { MeshDesc, TERRARIUM_ELEVATION_DECODER, vector3ToGeodetic } from '@navaramap/three';
import { localToLngLat, lngLatToLocal } from './geo.js';
import { DefaultPlugin } from '@navaramap/three-default-plugin';
import { MapLibreStylePlugin } from '@navaramap/maplibre-style';

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles/liberty';
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAPTERHORN = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';

/** 任意の three.js Object3D をそのまま載せるメッシュ記述子 */
class Object3DMeshDesc extends MeshDesc {
  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.config = config;
  }
  // Navara は返したオブジェクトの行列を geodetic 配置で上書きするため、ENU→WUN 変換は子要素側に持たせる。
  // 再配置のたびに破棄されても元データが壊れないよう clone（ジオメトリ・マテリアルは共有）を返す。
  createMesh() { const root = new THREE.Group(); root.add(this.config.object3d.object.clone()); return root; }
  getPassKey() { return this.config.object3d.transparent ? 'transparent' : 'opaque'; }
}

// ENU（x=東, y=北, z=上）→ Navara の geodetic 局所系 WUN（x=西, y=上, z=北）
const ENU_TO_WUN = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

export class NavaraMap {
  constructor(el, { center, onPick }) {
    this.el = el;
    this.onPick = onPick;
    this.state = { base: 'osm', xyz: '', terrain: true, photoreal: false };
    this.place = { lon: center[0], lat: center[1], heading: 0 };
    this.objects = {}; // key -> { object, transparent, visible }
    this.handles = {};
    this.pickMode = true;
    this.ready = this.create();
    new ResizeObserver(() => this.view?.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio)).observe(el);
  }

  async create(camera) {
    if (this.view) { try { this.view.dispose(); } catch (e) { console.warn(e); } this.el.querySelector('canvas.navara-canvas')?.remove(); this.handles = {}; }
    // v0.2.1 では canvas 未指定時に body 直下へ 100vw×100vh の要素を作るため、コンテナ内に自前の canvas を用意する
    const canvas = document.createElement('canvas');
    canvas.className = 'navara-canvas';
    this.el.appendChild(canvas);
    const view = new ThreeView({ canvas, disableAutoResize: true });
    const def = new DefaultPlugin();
    view.addPlugin(def);
    if (this.state.base === 'openfreemap') {
      // スタイル JSON の center/zoom/pitch でカメラが上書きされないよう、配置点に合わせて上書き
      view.addPlugin(new MapLibreStylePlugin(OPENFREEMAP, { overrides: { center: [this.place.lon, this.place.lat], zoom: 17, pitch: 55, bearing: 20 } }));
    }
    await view.init();
    view.registerMesh('object3d', Object3DMeshDesc); // v0.2.1 ではレジストリが init() で作られるため init 後に登録
    this.view = view;
    view.resize(this.el.clientWidth, this.el.clientHeight, window.devicePixelRatio);
    // フォトリアル（大気・雲）は無効にし、建物の比較が見やすいよう環境光＋太陽光のみ
    try { view.addLight({ ambient: { intensity: 1.4 } }); view.addLight({ sun: {} }); } catch (e) { console.warn('light', e); }
    if (this.state.photoreal) { try { def.addDefaultPhotorealScene(); } catch (e) { console.warn('photoreal scene', e); } }

    if (this.state.base !== 'openfreemap') {
      const url = this.state.base === 'xyz' && this.state.xyz ? this.state.xyz : OSM_TILES;
      const src = view.addSource({ type: 'raster-tile', url, maxZoom: 19 });
      view.addLayer({ type: 'raster', source: src });
    }
    this.applyTerrain();
    view.attribution?.add([
      { attribution: '© OpenStreetMap contributors', attributionUrl: 'https://www.openstreetmap.org/copyright' },
      ...(this.state.base === 'openfreemap' ? [{ attribution: 'OpenFreeMap © OpenMapTiles', attributionUrl: 'https://openfreemap.org/' }] : []),
      { attribution: '© Mapterhorn', attributionUrl: 'https://mapterhorn.com/attribution' },
    ]);
    view.on('click', (ev) => {
      if (!this.pickMode || !ev.map) return;
      const g = vector3ToGeodetic(new THREE.Vector3(ev.map.x, ev.map.y, ev.map.z));
      if (Number.isFinite(g.lng) && Number.isFinite(g.lat)) this.onPick(g.lng, g.lat);
    });
    for (const key of Object.keys(this.objects)) this.mount(key);
    this.lookAt(camera);
    return view;
  }

  applyTerrain() {
    const v = this.view;
    if (this.terrainLayer) { v.deleteLayerById(this.terrainLayer.id); this.terrainLayer = null; this.dem = null; }
    if (this.state.terrain) {
      const dem = this.dem = v.addSource({ type: 'raster-dem', url: MAPTERHORN, elevationDecoder: TERRARIUM_ELEVATION_DECODER(), tileSize: 512, maxZoom: 16 });
      this.terrainLayer = v.addLayer({ type: 'terrain', source: dem });
    } else {
      this.terrainLayer = v.addLayer({ type: 'terrain', ellipsoid: {} });
    }
  }

  // ---- MapView 互換 API ----
  async setBase(base, xyz) {
    this.state.base = base;
    if (xyz) this.state.xyz = xyz;
    await this.ready;
    this.ready = this.create(this.cameraState());
  }
  setProjection() { /* Navara は地球儀のみ */ }
  async setTerrain(on) { this.state.terrain = on; await this.ready; this.applyTerrain(); this.remountAll(); }
  setHideBase3d() { /* スタイル内の 3D 建物は MapLibre スタイルプラグイン側の対応範囲 */ }

  /** 配置（経緯度・方位）を更新 */
  setPlacement(place) {
    const p = this.place;
    if (p.lon === place.lon && p.lat === place.lat && p.heading === place.heading && (p.dz || 0) === (place.dz || 0)) return;
    this.place = { ...place };
    this.ready.then(() => {
      for (const [k, h] of Object.entries(this.handles)) {
        try { h.update({ geodetic: this.geodetic() }); } catch { this.mount(k); }
      }
      this.view.forceUpdate?.();
    });
  }

  geodetic() {
    return { lng: this.place.lon, lat: this.place.lat, height: this.place.dz || 0, heading: this.place.heading, heightReference: this.state.terrain ? 'terrain' : 'ellipsoid' };
  }

  /** three.js オブジェクト（モデル局所 ENU 座標）を登録・置換 */
  setObject(key, object, { transparent = false, visible } = {}) {
    const prev = this.objects[key];
    const wrapper = new THREE.Group();
    wrapper.matrixAutoUpdate = false;
    wrapper.matrix.copy(ENU_TO_WUN);
    wrapper.add(object);
    this.objects[key] = { object: wrapper, transparent, visible: visible ?? prev?.visible ?? true };
    this.ready.then(() => this.mount(key));
  }

  setObjectVisible(key, on) {
    if (!this.objects[key]) return;
    this.objects[key].visible = on;
    this.ready.then(() => this.mount(key));
  }

  remountAll() { this.ready.then(() => { for (const k of Object.keys(this.objects)) this.mount(k); }); }

  mount(key) {
    const v = this.view;
    if (!v) return;
    if (this.handles[key]) { try { this.handles[key].delete(); } catch { v.deleteMeshById(this.handles[key].id); } delete this.handles[key]; }
    const o = this.objects[key];
    if (!o || !o.visible) return;
    this.handles[key] = v.addMesh({
      object3d: { object: o.object, transparent: o.transparent },
      geodetic: this.geodetic(),
    });
    v.forceUpdate?.();
  }

  cameraState() {
    try { const c = this.view?.camera; return c ? { lng: c.lng, lat: c.lat, height: c.height, heading: c.heading, pitch: c.pitch, roll: 0 } : undefined; } catch { return undefined; }
  }

  /** 配置点の地表高（最詳細ズームの DEM をネットワークから取得。描画中の粗い LOD の値を使うとカメラ高がずれる） */
  async groundHeight(lng, lat) {
    if (!this.state.terrain || !this.dem) return 0;
    try {
      const [r] = await this.view.sampleTerrainMostDetailed(this.dem, [{ lng, lat }]);
      if (Number.isFinite(r?.height)) return r.height;
    } catch (e) { console.warn('sampleTerrainMostDetailed', e); }
    return this.view.sampleTerrainHeight({ lng, lat }) ?? 0;
  }

  /** 建物（地表高 h）を、方位 heading から距離 dist・俯角 pitch で見るカメラ位置 */
  cameraFor(lng, lat, h, { heading = 20, pitch = -30, dist = this.viewDistance || 160 } = {}) {
    const back = dist * Math.cos((pitch * Math.PI) / 180);
    const up = -dist * Math.sin((pitch * Math.PI) / 180);
    const hr = (heading * Math.PI) / 180;
    const dn = -back * Math.cos(hr), de = -back * Math.sin(hr);
    return {
      lng: lng + de / (111320 * Math.cos((lat * Math.PI) / 180)), lat: lat + dn / 110940,
      height: h + up, heading, pitch, roll: 0,
    };
  }

  async lookAt(camera) {
    if (camera && Number.isFinite(camera.lng)) { this.view.setCamera(camera); return; }
    this.view.setCamera(this.cameraFor(this.place.lon, this.place.lat, 300));
    const h = (this.groundH = await this.groundHeight(this.place.lon, this.place.lat));
    if (this.lastOrbit) this.setOrbit(this.lastOrbit, true);
    else this.view.setCamera(this.cameraFor(this.place.lon, this.place.lat, h + 15));
  }

  async flyTo(lng, lat) {
    await this.ready;
    const h = await this.groundHeight(lng, lat);
    this.view.flyTo(this.cameraFor(lng, lat, h + 15), { duration: 1.5 });
  }

  /** 配置点の地表高を取り直す（配置変更時） */
  async refreshGround() {
    await this.ready;
    this.groundH = await this.groundHeight(this.place.lon, this.place.lat);
    if (this.lastOrbit) this.setOrbit(this.lastOrbit, true);
  }

  /**
   * 3D ビューのオービット状態を地図カメラへ反映。
   * orbit = { target:[x,y,z]（モデル局所 ENU）, heading（モデル系の視線方位, 度）, pitch（度, 下向き負）, dist（m） }
   */
  setOrbit(orbit, force = false) {
    this.lastOrbit = orbit;
    if (!this.view || this.groundH === undefined) return;
    const [lng, lat] = localToLngLat(orbit.target[0], orbit.target[1], this.place);
    const heading = (((orbit.heading + this.place.heading) % 360) + 360) % 360;
    const cam = this.cameraFor(lng, lat, this.groundH + orbit.target[2], { heading, pitch: orbit.pitch, dist: orbit.dist });
    const key = [cam.lng.toFixed(8), cam.lat.toFixed(8), cam.height.toFixed(2), heading.toFixed(2), orbit.pitch.toFixed(2)].join();
    if (!force && key === this.lastCamKey) return;
    this.lastCamKey = key;
    this.view.setCamera(cam);
  }

  /** 地図カメラ → モデル局所 ENU のカメラ位置・視線（地図を手動操作したときに 3D ビューへ反映） */
  readOrbit() {
    if (!this.view || this.groundH === undefined) return null;
    const c = this.view.camera;
    const g = c.positionGeographic, ori = c.orientation;
    if (!g || !Number.isFinite(g.lng)) return null;
    const D = Math.PI / 180;
    const [x, y] = lngLatToLocal(g.lng, g.lat, this.place);
    const hm = (ori.heading - this.place.heading) * D, p = ori.pitch * D;
    return { pos: [x, y, g.height - this.groundH], dir: [Math.sin(hm) * Math.cos(p), Math.cos(hm) * Math.cos(p), Math.sin(p)] };
  }

  // MapLibre 版で使っていた API（GeoJSON レイヤ）は Navara では three.js オブジェクトで代替
  setData() {}
  setLayerVisible() {}
  setMarker() {}
}
