import './style.css';
import { Group as THREE_Group } from 'three';
import { loadFromFiles, loadFromUrl, sceneToModel } from './loader.js';
import { analyze, autoCellSize, voxelize, polygonize, DEFAULT_OPTIONS } from './analyze.js';
import { evaluate, compareVolumes } from './evaluate.js';
import { simplifyModel, meshesToModel, SIMPLIFY_DEFAULTS } from './simplify.js';
import { exportGlb } from './exportGlb.js';
import { assignColours } from './colours.js';
import { buildOsm, partTags } from './osm.js';
import { Viewer, SHAPE_COLOURS, STEPPED_COLOUR, buildMapObjects, buildHighlight } from './viewer.js';
import { NavaraMap } from './navaraMap.js';
import { localToLngLat, lngLatToLocal } from './geo.js';

const $ = (id) => document.getElementById(id);
$('appVersion').textContent = `v${__APP_VERSION__}`;
const BASE = import.meta.env.BASE_URL;
// 青山学院大学 相模原キャンパス ウェスレー・チャペル（OSM way 99028196 の外形に合わせて位置・向きを推定）
const AGU_CHAPEL_PLACE = { lon: 139.4018359, lat: 35.5664521, heading: 51.5 };
const SAMPLES = [
  {
    file: 'wesley_chapel_agu_sagamihara.glb', label: 'ウェスレー・チャペル（青山学院大学 相模原キャンパス, LOD3）', place: AGU_CHAPEL_PLACE,
    credit: 'This work is based on "<a href="https://sketchfab.com/3d-models/wesley-chapel-agu-sagamihara-campus-lod3-e85177e3f4ed4f66a96d55f007abebe7" target="_blank" rel="noopener">Wesley Chapel, AGU Sagamihara Campus (LOD3)</a>" by <a href="https://sketchfab.com/ibukilego" target="_blank" rel="noopener">ibukilego</a>, licensed under <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>',
  },
  {
    file: 'media_center_agu_sagamihara.glb', label: 'B棟 メディアセンター（青山学院大学 相模原キャンパス, LOD2-3）',
    // OSM relation 4537816「B棟」の外形に合わせて推定（外形内一致率 90%、逆向き 71%）
    place: { lon: 139.4029083, lat: 35.5663779, heading: 320 },
    credit: 'This work is based on "<a href="https://sketchfab.com/3d-models/media-center-agu-sagamihara-campus-lod2-3-0b462fbe088e4616857ef30ecab54a06" target="_blank" rel="noopener">Media Center, AGU Sagamihara Campus (LOD2-3)</a>" by <a href="https://sketchfab.com/ibukilego" target="_blank" rel="noopener">ibukilego</a>, licensed under <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>',
  },
  { file: 'house_gabled.glb', label: '合成: 切妻屋根の住宅（煙突・軒の出あり）' },
  { file: 'complex_tower.glb', label: '合成: 複合ビル（塔・ドーム・ヴォールト・円錐台・キャンチレバー・アーチ門）' },
  { file: 'curved_tower.glb', label: '合成: 自由曲面タワー（回転体）' },
];

// resAll = 変換結果（全パート）、res = 手動削除を反映した結果。gen は変換のたびに増える世代番号（アンドゥ履歴の照合用）
const st = { gltf: null, name: '', model: null, resAll: null, res: null, ev: null, osm: null, deleted: new Set(), gen: 0, sel: null };
const place = { ...AGU_CHAPEL_PLACE, dz: 0 };

// ---------------- 初期化 ----------------
const viewer = new Viewer($('viewer'));
const mapView = new NavaraMap($('map'), { center: [place.lon, place.lat] });
window.__map = mapView; // デバッグ用
window.__viewer = viewer; // デバッグ用
const darkMq = matchMedia('(prefers-color-scheme: dark)');
viewer.setBackground(darkMq.matches);
darkMq.addEventListener('change', (e) => viewer.setBackground(e.matches));

$('sample').innerHTML = '<option value="">— サンプルを選択 —</option>' + SAMPLES.map((x) => `<option value="${x.file}">${x.label}</option>`).join('');
$('stepHeight').value = DEFAULT_OPTIONS.stepHeight;
$('roofTol').value = DEFAULT_OPTIONS.roofTol;
$('minPartArea').value = DEFAULT_OPTIONS.minPartArea;
syncPlaceInputs();

// ---------------- カメラ連動（3D ビュー ⇔ 地図）と自動回転 ----------------
const cam = { playing: true, master: 'viewer' };
function setPlaying(on) {
  cam.playing = on;
  if (on) cam.master = 'viewer';
  viewer.controls.autoRotate = on;
  for (const b of document.querySelectorAll('.playBtn')) {
    b.textContent = on ? '⏸ 一時停止' : '▶ 自動回転';
    b.setAttribute('aria-pressed', String(on));
  }
}
document.querySelectorAll('.playBtn').forEach((b) => b.addEventListener('click', () => setPlaying(!cam.playing)));
// 手動操作が始まったら自動回転を止め、操作した側を基準（master）にする
viewer.controls.addEventListener('start', () => { cam.master = 'viewer'; if (cam.playing) setPlaying(false); });
for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
  $('map').addEventListener(ev, (e) => {
    if (e.target instanceof Element && e.target.closest('.playBtn, .editHead')) return; // ボタン・凡例上の操作はカメラ操作ではない
    cam.master = 'map'; if (cam.playing) setPlaying(false);
  }, { capture: true, passive: true });
}
viewer.onFrame = () => {
  if (!st.model) return;
  mapView.followOrbit = cam.master === 'viewer';
  if (cam.master === 'viewer') mapView.setOrbit(viewer.getOrbit());
  else {
    const r = mapView.readOrbit();
    if (r) viewer.applyCamera(r.pos, r.dir);
  }
};
setPlaying(true);
// 画角を地図（Navara）のカメラに合わせ、上下の見え方を揃える
mapView.ready.then((v) => { const f = v?.camera?.fov; if (f) { viewer.camera.fov = f; viewer.camera.updateProjectionMatrix(); } });

// ---------------- 入力 ----------------
$('file').addEventListener('change', (e) => e.target.files.length && loadFiles(e.target.files));
$('sample').addEventListener('change', async (e) => {
  if (!e.target.value) return;
  const smp = SAMPLES.find((x) => x.file === e.target.value);
  await guard(async () => {
    const r = await loadFromUrl(BASE + 'samples/' + smp.file);
    // 実在建物のサンプルは既知の位置・向きへ配置
    if (smp.place) { place.heading = smp.place.heading; place.dz = 0; setPlace(smp.place.lon, smp.place.lat); }
    clearHistory(); // 別モデルの配置へは戻さない
    setGltf({ ...r, credit: smp.credit });
  });
});
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('hover'); }));
document.addEventListener('drop', (e) => { drop.classList.remove('hover'); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });

async function loadFiles(files) { await guard(async () => { setGltf(await loadFromFiles(files)); clearHistory(); }); }

function setGltf({ gltf, name, credit }) {
  st.gltf = gltf;
  st.name = name;
  $('modelName').textContent = name;
  // モデルのクレジット（CC BY 等）。glTF の asset.extras（Sketchfab 形式）からも取得
  const ex = gltf.asset?.extras || {};
  const auto = ex.title && ex.license ? `"${esc(ex.title)}" by ${esc(ex.author || '?')} — ${esc(ex.license)}${ex.source ? ` (${esc(ex.source)})` : ''}` : '';
  $('credit').innerHTML = credit || auto;
  $('credit').hidden = !(credit || auto);
  $('cellSize').value = '';
  if (!$('osmName').value) $('osmName').placeholder = name.replace(/\.(glb|gltf)$/i, '');
  convert(true);
}

['upAxis', 'scale', 'groundOffset'].forEach((id) => $(id).addEventListener('change', () => st.gltf && convert(true)));
$('convert').addEventListener('click', () => convert(false));

// ---------------- 配置 ----------------
// 配置 = { lon, lat（WGS84, EPSG:4326）, heading（度, 時計回り）, dz（地表からの表示上の高さオフセット m） }
function fmtDeg(v) { return `${+v.toFixed(1)}°`; } // 関数宣言（初期化時の syncPlaceInputs から先に呼ばれるため）
function normDeg(v) { return Math.round((((v % 360) + 360) % 360) * 1000) / 1000; }
let anchor = { lon: place.lon, lat: place.lat }; // キー移動の累計表示の基準（クリック・数値入力・サンプル読込で更新）

function setPlace(lon, lat) {
  place.lon = lon; place.lat = lat;
  anchor = { lon, lat };
  syncPlaceInputs();
  mapView.setMarker(lon, lat);
  mapView.refreshGround();
  refreshGeo();
}
function syncPlaceInputs() {
  $('lon').value = place.lon.toFixed(7);
  $('lat').value = place.lat.toFixed(7);
  $('heading').value = place.heading;
  $('headingVal').textContent = fmtDeg(place.heading);
  $('dz').value = +place.dz.toFixed(2);
}

// ---------------- 配置のアンドゥ / リドゥ（Ctrl/⌘+Z、Ctrl/⌘+Shift+Z・Ctrl+Y） ----------------
// 同じ種類の操作が短時間に続く場合（キーリピート・スライダーのドラッグ）は 1 回分としてまとめる
const history = { undo: [], redo: [], lastKind: '', lastTime: 0 };
const snap = () => ({ lon: place.lon, lat: place.lat, heading: place.heading, dz: place.dz, gen: st.gen, deleted: [...st.deleted] });
function recordUndo(kind) {
  const now = performance.now();
  if (kind && kind === history.lastKind && now - history.lastTime < 800) { history.lastTime = now; return; }
  history.undo.push(snap());
  if (history.undo.length > 200) history.undo.shift();
  history.redo.length = 0;
  history.lastKind = kind; history.lastTime = now;
}
function clearHistory() { history.undo.length = history.redo.length = 0; history.lastKind = ''; }
function restore(from, to, label) {
  const s = from.pop();
  if (!s) { showToast(label === '元に戻す' ? '元に戻せる操作はありません' : 'やり直せる操作はありません'); return; }
  to.push(snap());
  history.lastKind = '';
  const { deleted, gen, ...pl } = s;
  Object.assign(place, pl);
  applyPlacement(true);
  // 同じ変換結果（世代）の履歴なら、パートの手動削除も復元
  if (gen === st.gen && (deleted.length !== st.deleted.size || deleted.some((id) => !st.deleted.has(id)))) {
    st.deleted = new Set(deleted);
    if (st.sel != null && st.deleted.has(st.sel.id)) st.sel = null;
    rebuildAfterEdit();
    showToast(`${label}: パートの削除（削除中 ${st.deleted.size} 件）`);
    return;
  }
  showToast(`${label}: 経度 ${place.lon.toFixed(7)}・緯度 ${place.lat.toFixed(7)}・向き ${fmtDeg(place.heading)}・高さ ${place.dz >= 0 ? '+' : '−'}${Math.abs(place.dz).toFixed(2)} m`);
}

/** place の変更を入力欄・地図・.osm に反映（地表高の再取得と .osm 再生成はキーリピート中に連発しないよう間引く） */
let groundTimer = 0, geoTimer = 0;
function applyPlacement(moved) {
  syncPlaceInputs();
  if (moved) mapView.setMarker(place.lon, place.lat);
  mapView.setPlacement(place);
  clearTimeout(groundTimer);
  if (moved) groundTimer = setTimeout(() => mapView.refreshGround(), 300);
  clearTimeout(geoTimer);
  geoTimer = setTimeout(refreshGeo, 150);
}

const toast = Object.assign(document.createElement('div'), { className: 'nudgeToast' });
$('map').append(toast);
let toastTimer = 0;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('on'), 1600);
}

// ---------------- キーボード操作（エディットビュー） ----------------
// 矢印キー = 水平移動（画面の向き基準。↑ = 視線方向）、U / D = 上下、R = 時計回り / L = 反時計回りに回転。
// Shift = 大きく、⌘(Meta) / Ctrl = 細かく。
const NUDGE = { normal: 0.5, coarse: 5, fine: 0.05 }; // m
const ROTATE = { normal: 1, coarse: 15, fine: 0.1 }; // 度
// 地図をクリックしたらサイドバー入力欄のフォーカスを外し、すぐキー操作できるようにする
$('map').addEventListener('pointerdown', () => { const a = document.activeElement; if (a instanceof HTMLElement && a !== document.body && !$('map').contains(a)) a.blur(); }, { capture: true });
window.addEventListener('keydown', (ev) => {
  const t = ev.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return; // 入力欄では通常の編集（ネイティブのアンドゥ含む）
  if (ev.altKey || !st.model) return;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const mod = ev.metaKey || ev.ctrlKey;

  if (mod && (k === 'z' || k === 'y')) {
    ev.preventDefault(); ev.stopPropagation();
    if (k === 'y' || ev.shiftKey) restore(history.redo, history.undo, 'やり直し');
    else restore(history.undo, history.redo, '元に戻す');
    return;
  }

  if ((k === 'Delete' || k === 'Backspace') && st.sel) { ev.preventDefault(); ev.stopPropagation(); deleteSelected(); return; }
  if (k === 'Escape' && st.sel) { ev.preventDefault(); selectPart(null); return; }

  const dirs = { ArrowUp: [0, 1, 0], ArrowDown: [0, -1, 0], ArrowRight: [1, 0, 0], ArrowLeft: [-1, 0, 0], u: [0, 0, 1], d: [0, 0, -1] };
  const d = dirs[k];
  const rot = k === 'r' ? 1 : k === 'l' ? -1 : 0; // R = 時計回り、L = 反時計回り
  if (!d && !rot) return;
  ev.preventDefault(); ev.stopPropagation();
  const tbl = rot ? ROTATE : NUDGE;
  const step = mod ? tbl.fine : ev.shiftKey ? tbl.coarse : tbl.normal;

  if (rot) {
    recordUndo('rotate');
    place.heading = normDeg(place.heading + rot * step);
    applyPlacement(false);
    showToast(`回転 ${rot > 0 ? '+' : '−'}${step}°（${rot > 0 ? '時計回り' : '反時計回り'}） ｜ 向き ${fmtDeg(place.heading)}`);
    return;
  }
  if (d[2]) {
    recordUndo('dz');
    place.dz = Math.round((place.dz + d[2] * step) * 1000) / 1000;
  } else {
    recordUndo('move');
    // 画面上方向の地理方位 = 検証ビューの視線方位（モデル系）+ 配置の向き
    const az = ((viewer.getOrbit().heading + place.heading) * Math.PI) / 180;
    const fwd = d[1] * step, right = d[0] * step;
    const de = fwd * Math.sin(az) + right * Math.cos(az);
    const dn = fwd * Math.cos(az) - right * Math.sin(az);
    [place.lon, place.lat] = localToLngLat(de, dn, { lon: place.lon, lat: place.lat, heading: 0 });
  }
  applyPlacement(!d[2]);
  const [ae, an] = lngLatToLocal(place.lon, place.lat, { ...anchor, heading: 0 });
  const sg = (v) => (Math.abs(v) < 0.005 ? '±' : v > 0 ? '+' : '−') + Math.abs(v).toFixed(2);
  showToast(`移動 ${step} m ｜ 累計 東 ${sg(ae)} m・北 ${sg(an)} m ｜ 高さ ${sg(place.dz)} m`);
}, { capture: true });

// ---------------- エディットビュー: 面（パート）の選択・ソース表示・削除・画面中央へ再配置 ----------------
// クリック（ドラッグでない短い押下）で OSM 復元形状の面を選択。面は 1 つの OSM 要素（building:part）に対応する。
const press = { x: 0, y: 0, t: 0, on: false };
$('map').addEventListener('pointerdown', (e) => {
  press.on = e.button === 0 && !(e.target instanceof Element && e.target.closest('.editHead, .playBtn'));
  Object.assign(press, { x: e.clientX, y: e.clientY, t: performance.now() });
});
$('map').addEventListener('pointerup', (e) => {
  if (!press.on || !st.res) return;
  press.on = false;
  if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5 || performance.now() - press.t > 600) return; // ドラッグはカメラ操作
  if (!$('mapRecon').checked) { showToast('面を選択するには「地図に表示: OSM 復元」をオンにしてください'); return; }
  const hit = mapView.pick('recon', e.clientX, e.clientY);
  const id = hit?.object.userData.partId;
  if (id == null) { selectPart(null); return; }
  // 面の種類: 法線が上向き → 屋根面、ほぼ水平 → 壁面、下向き → 底面（min_height の下面）
  const nz = hit.normal.z;
  selectPart(id, nz > 0.3 ? '屋根面' : nz < -0.3 ? '底面' : '壁面');
});

function selectPart(id, face) {
  st.sel = id == null ? null : { id, face };
  updateSelection();
}

/** 選択状態を UI・強調表示・ソース表示に反映 */
function updateSelection() {
  const p = st.sel && st.res?.parts.find((q) => q.id === st.sel.id);
  if (st.sel && !p) st.sel = null;
  for (const id of ['btnSource', 'btnDelete', 'btnDeselect']) $(id).disabled = !p;
  $('selInfo').hidden = !p;
  if (!p) {
    $('srcPanel').hidden = true;
    $('btnSource').setAttribute('aria-pressed', 'false');
    mapView.setObjectVisible('select', false);
    return;
  }
  const t = partTags(p, place, osmOptions());
  const kv = ['roof:shape', 'height', 'min_height', 'roof:height'].filter((k) => t[k] != null).map((k) => `${k}=${t[k]}`).join(', ');
  $('selInfo').innerHTML = `選択中: <b>パート #${p.id}</b>（${esc(st.sel.face)}）<br><span class="muted">${esc(kv)}</span>`;
  if (!$('srcPanel').hidden) $('srcCode').textContent = st.osm?.partSource(p.id) || '';
  mapView.setObject('select', buildHighlight(p, st.res), { transparent: true, visible: true });
}

$('btnSource').addEventListener('click', () => {
  if (!st.sel) return;
  const show = $('srcPanel').hidden;
  $('srcPanel').hidden = !show;
  $('btnSource').setAttribute('aria-pressed', String(show));
  if (show) $('srcCode').textContent = st.osm?.partSource(st.sel.id) || '';
});
$('btnDeselect').addEventListener('click', () => selectPart(null));
$('btnDelete').addEventListener('click', () => deleteSelected());

function deleteSelected() {
  if (!st.sel || !st.res) return;
  if (st.res.parts.length <= 1) { showToast('最後の 1 パートは削除できません'); return; }
  const id = st.sel.id;
  recordUndo('');
  st.deleted.add(id);
  st.sel = null;
  rebuildAfterEdit();
  showToast(`パート #${id} を削除しました（Ctrl / ⌘ + Z で元に戻す）`);
}

/** 手動削除を反映した結果: 削除パートを除き、建物外形（building=*）も削除パートだけが占めていたセルを除いて作り直す */
function effectiveRes() {
  const all = st.resAll;
  if (!st.deleted.size) return all;
  const parts = all.parts.filter((p) => !st.deleted.has(p.id));
  const keep = new Set();
  for (const p of parts) for (const s of p.samples) keep.add(s.k);
  const gone = new Set();
  for (const p of all.parts) if (st.deleted.has(p.id)) for (const s of p.samples) if (!keep.has(s.k)) gone.add(s.k);
  const cells = [];
  for (let k = 0; k < all.cellIv.length; k++) if (all.cellIv[k] && !gone.has(k)) cells.push(k);
  return {
    ...all, parts,
    outline: polygonize(cells, all.grid, all.options.simplify * all.grid.c),
    maxHeight: parts.reduce((a, p) => Math.max(a, p.H), 0),
  };
}

/** パート削除（またはそのアンドゥ）後に評価・表示・.osm を更新 */
function rebuildAfterEdit() {
  st.res = effectiveRes();
  st.ev = evaluate(st.model, st.res, { errTol: +$('errTol').value || 0.5, origIv: st.origIv });
  viewer.update(st.model, st.res, st.ev, { recolour: true, simplified: st.simp?.display });
  $('clip').dispatchEvent(new Event('input'));
  renderReport();
  const objs = buildMapObjects(st.model, st.res, st.ev, st.simp?.display);
  mapView.setObject('recon', objs.recon);
  mapView.setObject('diff', objs.diff);
  refreshGeo();
  updateSelection();
}

// オブジェクト全体（モデル原点 = 底面中心）を、エディットビューの画面中央が指す地表の位置へ移動。地図カメラは動かさない
$('btnRecenter').addEventListener('click', () => {
  if (!st.model) return;
  const c = mapView.screenCenterLocal();
  if (!c) { showToast('画面中央が地表を向いていません（カメラを下向きにしてください）'); return; }
  if (cam.playing) setPlaying(false);
  cam.master = 'map';
  mapView.followOrbit = false;
  recordUndo('');
  const [lon, lat] = localToLngLat(c[0], c[1], place);
  setPlace(lon, lat);
  showToast(`画面中央へ再配置: 経度 ${lon.toFixed(7)}・緯度 ${lat.toFixed(7)}（WGS84）`);
});

$('lon').addEventListener('change', () => { cam.master = 'viewer'; recordUndo(''); setPlace(+$('lon').value, place.lat); });
$('lat').addEventListener('change', () => { cam.master = 'viewer'; recordUndo(''); setPlace(place.lon, +$('lat').value); });
$('heading').addEventListener('input', () => { recordUndo('slider'); place.heading = +$('heading').value; $('headingVal').textContent = fmtDeg(place.heading); refreshGeo(); });
$('dz').addEventListener('change', () => { recordUndo(''); place.dz = +$('dz').value || 0; mapView.setPlacement(place); });
['osmName', 'buildingType', 'optColours', 'optLevels', 'floorHeight'].forEach((id) => $(id).addEventListener('change', refreshGeo));

// ---------------- 地図設定 ----------------
$('baseMap').addEventListener('change', () => { $('xyzRow').hidden = $('baseMap').value !== 'xyz'; if ($('baseMap').value !== 'xyz') mapView.setBase($('baseMap').value); });
$('xyzApply').addEventListener('click', () => mapView.setBase('xyz', $('xyzUrl').value.trim()));
$('terrain').addEventListener('change', () => mapView.setTerrain($('terrain').checked));
for (const [id, key] of [['mapRecon', 'recon'], ['mapOriginal', 'original'], ['mapDiff', 'diff'], ['mapSimplified', 'simplified']]) {
  $(id).addEventListener('change', () => mapView.setObjectVisible(key, $(id).checked));
}

// ---------------- 3D ビュー ----------------
const VIEW_TOGGLES = { vOriginal: 'original', vSimplified: 'simplified', vError: 'error', vRecon: 'recon', vLost: 'lost', vAdded: 'added' };
for (const [id, key] of Object.entries(VIEW_TOGGLES)) {
  $(id).addEventListener('change', () => viewer.setVisible(key, $(id).checked));
  viewer.setVisible(key, $(id).checked);
}
$('clip').addEventListener('input', () => {
  const max = st.model ? st.model.bbox.max[2] : 100;
  const z = (+$('clip').value / 100) * max * 1.001;
  viewer.setClip(+$('clip').value >= 100 ? 1e6 : z);
  $('clipVal').textContent = +$('clip').value >= 100 ? 'なし' : `${z.toFixed(1)} m`;
});

// ---------------- 変換 ----------------
async function convert(reloadModel) {
  if (!st.gltf) return;
  await guard(async () => {
    status('変換中…');
    await new Promise((r) => setTimeout(r, 20));
    const t0 = performance.now();
    if (reloadModel || !st.model) {
      st.model = sceneToModel(st.gltf.scene, { upAxis: $('upAxis').value, scale: +$('scale').value || 1, groundOffset: +$('groundOffset').value || 0 });
      if (!st.model.stats.valid) throw new Error('座標に NaN/Infinity が含まれています');
      $('cellSize').placeholder = `自動 (${autoCellSize(st.model)} m)`;
    }
    const opts = {
      cellSize: +$('cellSize').value || 0,
      stepHeight: +$('stepHeight').value || DEFAULT_OPTIONS.stepHeight,
      roofTol: +$('roofTol').value || DEFAULT_OPTIONS.roofTol,
      minPartArea: +$('minPartArea').value || DEFAULT_OPTIONS.minPartArea,
      mergeEaves: $('mergeEaves').checked,
    };
    // ---- ステージ1: 単純化（任意） ----
    let input = st.model;
    st.simp = null;
    if ($('simpOn').checked) {
      const t1 = performance.now();
      const so = {
        detail: num('sDetail', SIMPLIFY_DEFAULTS.detail), heightTol: num('sHeightTol', SIMPLIFY_DEFAULTS.heightTol),
        cornerRadius: num('sCorner', SIMPLIFY_DEFAULTS.cornerRadius, true), edgeRadius: num('sEdge', SIMPLIFY_DEFAULTS.edgeRadius, true),
        minThickness: num('sThin', SIMPLIFY_DEFAULTS.minThickness, true), cellSize: opts.cellSize,
      };
      const r = simplifyModel(st.model, so);
      st.simp = { r, display: meshesToModel(r.display, st.model.materials), plain: meshesToModel(r.plain, st.model.materials), ms: performance.now() - t1 };
      input = $('simpRoundOsm').checked ? st.simp.display : st.simp.plain;
    }
    // ---- ステージ2: OSM 3D タグ化（評価は常に元モデル基準） ----
    st.input = input;
    st.resAll = analyze(input, opts);
    assignColours(input, st.resAll);
    st.deleted = new Set(); st.gen++; st.sel = null; // パート番号が変わるため手動削除・選択はリセット
    st.res = st.resAll;
    const origIv = st.origIv = input === st.model ? undefined : voxelize(st.model, { vStep: st.res.options.vStep }, st.res.grid).cellIv;
    st.ev = evaluate(st.model, st.res, { errTol: +$('errTol').value || 0.5, origIv });
    if (st.simp) st.simp.cmp = compareVolumes(origIv, voxelize(st.simp.display, { vStep: st.res.options.vStep }, st.res.grid).cellIv, st.res.grid);
    viewer.update(st.model, st.res, st.ev, { recolour: !reloadModel, simplified: st.simp?.display });
    $('clip').value = 100; $('clip').dispatchEvent(new Event('input'));
    renderReport();
    const objs = buildMapObjects(st.model, st.res, st.ev, st.simp?.display);
    mapView.setObject('simplified', objs.simplified ?? new THREE_Group(), { visible: $('mapSimplified').checked });
    mapView.setObject('recon', objs.recon, { visible: $('mapRecon').checked });
    mapView.setObject('original', objs.original, { visible: $('mapOriginal').checked });
    mapView.setObject('diff', objs.diff, { visible: $('mapDiff').checked });
    refreshGeo();
    updateSelection();
    if (reloadModel) cam.master = 'viewer'; // 新しいモデルでは 3D ビューの初期カメラに地図を合わせる
    status(`変換完了（${((performance.now() - t0) / 1000).toFixed(2)} 秒）`);
  });
}

function num(id, def, allowZero = false) { const v = parseFloat($(id).value); return Number.isFinite(v) && (allowZero ? v >= 0 : v > 0) ? v : def; }

function osmOptions() {
  return {
    name: $('osmName').value.trim(), buildingType: $('buildingType').value.trim() || 'yes',
    colours: $('optColours').checked, levels: $('optLevels').checked, floorHeight: +$('floorHeight').value || 3,
  };
}

function refreshGeo() {
  if (!st.res) return;
  st.osm = buildOsm(st.res, place, osmOptions());
  $('osmPreview').textContent = st.osm.xml.length > 200000 ? st.osm.xml.slice(0, 200000) + '\n…（省略）' : st.osm.xml;
  $('osmStats').textContent = `node ${st.osm.stats.nodes} / way ${st.osm.stats.ways} / relation ${st.osm.stats.relations}`;
  mapView.setPlacement(place);
}

$('dlOsm').addEventListener('click', () => st.osm && download(st.osm.xml, baseName() + '.osm', 'application/xml'));
$('dlGeojson').addEventListener('click', () => st.osm && download(JSON.stringify(st.osm.geojson, null, 1), baseName() + '.geojson', 'application/geo+json'));
$('dlSimplified').addEventListener('click', async () => {
  if (!st.simp) { status('単純化が無効です（「1.5 単純化」を有効にして変換してください）', true); return; }
  const buf = await exportGlb(st.simp.display, { title: `${st.name} (simplified by glTF2OSM3D)` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
  a.download = baseName() + '_simplified.glb';
  a.click();
});
$('dlShot').addEventListener('click', () => { const a = document.createElement('a'); a.href = viewer.renderer.domElement.toDataURL('image/png'); a.download = baseName() + '_3d.png'; a.click(); });
const baseName = () => ($('osmName').value.trim() || st.name.replace(/\.(glb|gltf)$/i, '') || 'building').replace(/[^\w\-.　-鿿]/g, '_');
function download(text, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- レポート ----------------
const f1 = (v) => v.toLocaleString('ja-JP', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const f2 = (v) => v.toLocaleString('ja-JP', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const SHAPE_JA = { flat: '陸屋根 flat', skillion: '片流れ skillion', gabled: '切妻 gabled', gabled_across: '切妻 gabled (across)', hipped: '寄棟 hipped', pyramidal: '方形 pyramidal', round: 'ヴォールト round', dome: 'ドーム dome', cone: '円錐 cone' };

function renderReport() {
  const { model, res, ev } = st;
  const c = res.grid.c;
  const parts = res.parts;
  const stepped = parts.filter((p) => p.origin === 'stepped');
  const floating = parts.filter((p) => p.B > 0.05);
  const holed = parts.filter((p) => p.polygons.length > 1 || p.polygons.some((q) => q.holes.length));
  const droppedArea = res.dropped.reduce((a, d) => a + d.samples.length * c * c, 0);
  const soffitParts = parts.filter((p) => p.origin === 'soffit');
  const textured = model.materials.some((m) => m.textured);
  const cats = ev.cats;
  const shapeCount = {};
  for (const p of parts) { const k = p.origin === 'stepped' ? '段状近似 (flat)' : SHAPE_JA[p.shape]; shapeCount[k] = (shapeCount[k] || 0) + 1; }

  const issues = [];
  const add = (sev, title, qty, body) => issues.push({ sev, title, qty, body });
  if (st.deleted.size) add('mid', '手動で削除したパート', `${st.deleted.size} パート（#${[...st.deleted].sort((x, y) => x - y).join(', #')}）`,
    'エディットビューで選択して削除したパートは .osm / GeoJSON に出力されません。建物全体の外形（building=*）も、削除したパートだけが占めていた範囲を除いて作り直しています。一致度・欠落体積は削除後の形状で再計算しています。Ctrl / ⌘ + Z で元に戻せます（再変換するとリセット）。');
  if (stepped.length) add('high', '自由曲面・テーパー（傾いた壁）・プリセット外の屋根', `${stepped.length} パートに段状分解（段の高さ ≈ ${res.options.stepHeight} m）`,
    'Simple 3D Buildings の building:part は「水平な底面 (min_height) から鉛直に押し出した柱体 + roof:shape のプリセット屋根」しか表せません。連続的に変化する曲面や傾いた外壁は、高さ方向に分割した複数のパート（ひな壇状）で近似しました。3D ビューのオレンジ色のパートが該当します。段を細かくすると誤差は減りますがパート数が増え、OSM データとしての可読性・保守性が落ちます。');
  if (cats.wall.bad > 0.5) add('mid', '鉛直でない壁・壁面の凹凸', `${f1(cats.wall.bad)} m²（壁面の ${f1((100 * cats.wall.bad) / Math.max(1, cats.wall.area))}%）が許容誤差 ${ev.errTol} m 超`,
    '外壁はフットプリントの辺を鉛直に立ち上げたものとして描画されます。バルコニー、ルーバー、セットバックの小さな段差、傾斜・湾曲した壁はそのまま表現できません。誤差ヒートマップで赤い壁面が該当します。');
  if (cats.roofSlope.bad > 0.5) add('mid', 'roof:shape に一致しない傾斜面', `${f1(cats.roofSlope.bad)} m² が許容誤差超`,
    'roof:shape は flat / skillion / gabled / hipped / pyramidal / round / dome / cone などの定型のみで、屋根の高さ・向きもパートに 1 組です。複合屋根、ドーマー、勾配の違う屋根面、曲面屋根は近似になります。');
  if (cats.soffitSlope.bad > 0.5 || soffitParts.length) add('high', '下向きの傾斜面・曲面（アーチ、ピロティの斜め天井、庇裏など）', `${f1(cats.soffitSlope.area)} m²（うち ${f1(cats.soffitSlope.bad)} m² が許容誤差超）`,
    'min_height はパート全体で一定の「水平な底面」しか表せず、OSM には下面の形状（アーチやヴォールト天井）を表すタグがありません。底面の高さごとにパートを分けて段状に近似しています。誤差ヒートマップの下向き面と、赤い欠落ボクセルで確認できます。');
  if (res.eavesArea > 0) add('mid', '軒の出・庇（薄い張り出し）', `${f1(res.eavesArea)} m² を隣接パートへ併合`,
    '屋根だけが外壁より張り出した部分は、OSM では一般的に壁の輪郭（フットプリント）までしか描かれず、軒の出を表す確立したタグがありません。本ツールでは張り出しを隣接パートに含め、壁を軒先まで地面から延長して近似しています（青い過剰ボクセル）。「軒の出を併合」をオフにすると、浮いた薄いパート (min_height) として残せます。');
  if (floating.length) add('low', '浮いた部分（キャンチレバー・ブリッジ・上層の張り出し）', `${floating.length} パートで min_height > 0`,
    'min_height で表現できます（S3DB 準拠）。ただし一部のレンダラーは min_height を無視して地面から描画します。');
  if (holed.length) add('low', '中庭・吹き抜け（穴あき）や分離したフットプリント', `${holed.length} パートを multipolygon リレーションで出力`,
    'type=multipolygon + building:part=* で表現できますが、穴あき形状に切妻などの roof:shape を組み合わせた場合の描画はレンダラーにより異なります。');
  if (res.dropped.length) add('low', '小さすぎる要素の省略', `${res.dropped.length} 箇所・計 ${f2(droppedArea)} m²（最小パート面積 ${res.options.minPartArea} m² 未満）`,
    '煙突・アンテナ・手すりなど極小の要素は、ノイズとの区別とデータ量の観点から省略しました（赤い欠落ボクセル）。最小パート面積を小さくすると残せます。');
  if (res.belowGround > 0.01) add('low', '地盤面より下の部分', `${f1(res.belowGround)} m³ を切り捨て`,
    'OSM の height / min_height は地面からの高さで、地下部分の形状は表しません（building:levels:underground で階数のみ表現可）。');
  add('info', 'セルサイズ未満の凹凸', `解析解像度 ${c} m`,
    `窓・扉・マリオン・コーニスなど ${c} m 未満の凹凸は解析の段階で失われます（OSM の building:part としても表現対象外）。`);
  add('info', 'マテリアル・テクスチャ', res.noColour ? '全マテリアルが同一色（色情報なし）→ 色タグは出力しません' : textured ? 'テクスチャ付きマテリアルあり' : '単色マテリアル',
    'OSM で表せるのは building:colour / roof:colour（＋ building:material / roof:material の分類）のみで、テクスチャ画像やファサードの模様は表現できません。' + (textured ? '本ツールはテクスチャの平均色を色タグに用いています。' : ''));
  add('info', '内部構造・レンダラー依存性', '',
    '内部空間・床スラブ・階高の変化は表せず、building:levels は推定値です。roof:shape の解釈（棟の向き・寄棟の勾配など）は OSM2World / F4 Map / OSM Buildings 等のレンダラーごとに異なるため、本ツールの「OSM 復元」表示も 1 つの解釈です。');

  const sevLabel = { high: '表現不可（近似）', mid: '一部表現不可', low: '注意', info: '共通の制約' };
  const sp = st.simp;
  const fmtBytes = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${(b / 1e3).toFixed(0)} kB`);
  const stage1 = sp ? `
    <h3>ステージ1: 単純化（${(sp.ms / 1000).toFixed(2)} 秒）</h3>
    <table class="kv">
      <tr><th>三角形数</th><td>${model.stats.triangles.toLocaleString()} → <b>${sp.display.stats.triangles.toLocaleString()}</b>（丸めなし ${sp.plain.stats.triangles.toLocaleString()}）</td></tr>
      <tr><th>頂点データ概算</th><td>${fmtBytes(model.stats.triangles * 3 * 12)} → ${fmtBytes(sp.display.stats.triangles * 3 * 12)}</td></tr>
      <tr><th>マス（領域）数</th><td>${sp.r.regions.length}（平坦 ${sp.r.regions.filter((r) => r.flat).length} / 曲面・傾斜 ${sp.r.regions.filter((r) => !r.flat).length}）</td></tr>
      <tr><th>一致度 IoU</th><td><b>${(sp.cmp.iou * 100).toFixed(1)}%</b>（欠落 <span class="lost">${f1(sp.cmp.lost)} m³</span> / 過剰 <span class="added">${f1(sp.cmp.added)} m³</span>）</td></tr>
      <tr><th>除去した細部</th><td>平面 ${f1(sp.r.stats.removedCells * c * c)} m²（細部サイズ ${sp.r.options.detail} m 未満の突起・小領域）、薄い部材 ${f1(sp.r.stats.thinRemoved)} m³</td></tr>
    </table>
    <p class="muted">単純化モデル → ステージ2（OSM タグ化）${$('simpRoundOsm').checked ? '（角丸め形状を使用）' : '（角丸め前の形状を使用）'}。以下の一致度・誤差はすべて<b>元の glTF</b> を基準にした最終結果です。</p>
    <h3>ステージ2: OSM 3D タグ化</h3>` : '';
  $('report').innerHTML = stage1 + `
    <table class="kv">
      <tr><th>入力</th><td>${model.stats.meshes} メッシュ / ${model.stats.triangles.toLocaleString()} 三角形${model.stats.flipped ? `（${model.stats.flipped} メッシュの面の向きを反転）` : ''}</td></tr>
      <tr><th>範囲 (m)</th><td>${f1(model.bbox.max[0] - model.bbox.min[0])} × ${f1(model.bbox.max[1] - model.bbox.min[1])} × 高さ ${f1(model.bbox.max[2])}</td></tr>
      <tr><th>解析セル</th><td>${c} m（${res.grid.nx} × ${res.grid.ny}）</td></tr>
      <tr><th>パート数</th><td>${parts.length}：${Object.entries(shapeCount).map(([k, v]) => `${k} ${v}`).join('、')}</td></tr>
      <tr><th>体積</th><td>glTF ${f1(ev.vOrig)} m³ → OSM ${f1(ev.vRec)} m³</td></tr>
      <tr><th>一致度 IoU</th><td><b>${(ev.iou * 100).toFixed(1)}%</b>（欠落 <span class="lost">${f1(ev.lost)} m³</span> / 過剰 <span class="added">${f1(ev.added)} m³</span>）</td></tr>
      <tr><th>表面誤差</th><td>最大 ${f2(ev.maxErr)} m（許容 ${ev.errTol} m）</td></tr>
    </table>
    <h3>OSM で表現できない／近似した要素</h3>
    <ol class="issues">${issues.map((i) => `<li class="sev-${i.sev}"><div class="it"><span class="badge">${sevLabel[i.sev]}</span>${i.title}</div>${i.qty ? `<div class="qty">${i.qty}</div>` : ''}<p>${i.body}</p></li>`).join('')}</ol>
    <h3>パート一覧</h3>
    <div class="tablewrap"><table class="parts"><thead><tr><th>#</th><th>roof:shape</th><th>min_h</th><th>height</th><th>roof:h</th><th>面積</th><th>RMS</th></tr></thead>
    <tbody>${parts.map((p) => { const t = partTags(p, place, osmOptions()); return `<tr><td><span class="sw" style="background:${p.origin === 'stepped' ? STEPPED_COLOUR : SHAPE_COLOURS[p.shape]}"></span>${p.id}</td><td>${t['roof:shape']}${t['roof:orientation'] === 'across' ? ' (across)' : ''}${p.origin === 'stepped' ? ' <small>段</small>' : ''}</td><td>${t.min_height ?? 0}</td><td>${t.height}</td><td>${t['roof:height'] ?? ''}</td><td>${f1(p.area)}</td><td>${f2(p.rms)}</td></tr>`; }).join('')}</tbody></table></div>`;
}

// ---------------- 共通 ----------------
function esc(v) { return String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
function status(msg, err) { const s = $('status'); s.textContent = msg; s.className = err ? 'err' : ''; }
async function guard(fn) {
  try { await fn(); } catch (e) { console.error(e); status('エラー: ' + (e.message || e), true); }
}

// 起動時にサンプルを読み込む
$('sample').value = SAMPLES[0].file;
$('sample').dispatchEvent(new Event('change'));
