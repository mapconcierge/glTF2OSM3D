import './style.css';
import { loadFromFiles, loadFromUrl, sceneToModel } from './loader.js';
import { analyze, autoCellSize, DEFAULT_OPTIONS } from './analyze.js';
import { evaluate } from './evaluate.js';
import { assignColours } from './colours.js';
import { buildOsm, partTags } from './osm.js';
import { Viewer, SHAPE_COLOURS, STEPPED_COLOUR, buildMapObjects } from './viewer.js';
import { NavaraMap } from './navaraMap.js';

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;
// 青山学院大学 相模原キャンパス ウェスレー・チャペル（OSM way 99028196 の外形に合わせて位置・向きを推定）
const AGU_CHAPEL_PLACE = { lon: 139.4018359, lat: 35.5664521, heading: 51.5 };
const SAMPLES = [
  {
    file: 'wesley_chapel_agu_sagamihara.glb', label: 'ウェスレー・チャペル（青山学院大学 相模原キャンパス, LOD3）', place: AGU_CHAPEL_PLACE,
    credit: 'This work is based on "<a href="https://sketchfab.com/3d-models/wesley-chapel-agu-sagamihara-campus-lod3-e85177e3f4ed4f66a96d55f007abebe7" target="_blank" rel="noopener">Wesley Chapel, AGU Sagamihara Campus (LOD3)</a>" by <a href="https://sketchfab.com/ibukilego" target="_blank" rel="noopener">ibukilego</a>, licensed under <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>',
  },
  { file: 'house_gabled.glb', label: '合成: 切妻屋根の住宅（煙突・軒の出あり）' },
  { file: 'complex_tower.glb', label: '合成: 複合ビル（塔・ドーム・ヴォールト・円錐台・キャンチレバー・アーチ門）' },
  { file: 'curved_tower.glb', label: '合成: 自由曲面タワー（回転体）' },
];

const st = { gltf: null, name: '', model: null, res: null, ev: null, osm: null };
const place = { ...AGU_CHAPEL_PLACE };

// ---------------- 初期化 ----------------
const viewer = new Viewer($('viewer'));
const mapView = new NavaraMap($('map'), { center: [place.lon, place.lat], onPick: (lng, lat) => setPlace(lng, lat) });
window.__map = mapView; // デバッグ用
const darkMq = matchMedia('(prefers-color-scheme: dark)');
viewer.setBackground(darkMq.matches);
darkMq.addEventListener('change', (e) => viewer.setBackground(e.matches));

$('sample').innerHTML = '<option value="">— サンプルを選択 —</option>' + SAMPLES.map((x) => `<option value="${x.file}">${x.label}</option>`).join('');
$('stepHeight').value = DEFAULT_OPTIONS.stepHeight;
$('roofTol').value = DEFAULT_OPTIONS.roofTol;
$('minPartArea').value = DEFAULT_OPTIONS.minPartArea;
syncPlaceInputs();

// ---------------- 入力 ----------------
$('file').addEventListener('change', (e) => e.target.files.length && loadFiles(e.target.files));
$('sample').addEventListener('change', async (e) => {
  if (!e.target.value) return;
  const smp = SAMPLES.find((x) => x.file === e.target.value);
  await guard(async () => {
    const r = await loadFromUrl(BASE + 'samples/' + smp.file);
    // 実在建物のサンプルは既知の位置・向きへ配置
    if (smp.place) { place.heading = smp.place.heading; setPlace(smp.place.lon, smp.place.lat); }
    setGltf({ ...r, credit: smp.credit });
  });
});
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('hover'); }));
document.addEventListener('drop', (e) => { drop.classList.remove('hover'); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });

async function loadFiles(files) { await guard(async () => setGltf(await loadFromFiles(files))); }

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
function setPlace(lon, lat) {
  place.lon = lon; place.lat = lat;
  syncPlaceInputs();
  mapView.setMarker(lon, lat);
  refreshGeo();
}
function syncPlaceInputs() {
  $('lon').value = place.lon.toFixed(7);
  $('lat').value = place.lat.toFixed(7);
  $('heading').value = place.heading;
  $('headingVal').textContent = `${place.heading}°`;
}
$('lon').addEventListener('change', () => { setPlace(+$('lon').value, place.lat); mapView.flyTo(place.lon, place.lat); });
$('lat').addEventListener('change', () => { setPlace(place.lon, +$('lat').value); mapView.flyTo(place.lon, place.lat); });
$('heading').addEventListener('input', () => { place.heading = +$('heading').value; $('headingVal').textContent = `${place.heading}°`; refreshGeo(); });
['osmName', 'buildingType', 'optColours', 'optLevels', 'floorHeight'].forEach((id) => $(id).addEventListener('change', refreshGeo));

// ---------------- 地図設定 ----------------
$('baseMap').addEventListener('change', () => { $('xyzRow').hidden = $('baseMap').value !== 'xyz'; if ($('baseMap').value !== 'xyz') mapView.setBase($('baseMap').value); });
$('xyzApply').addEventListener('click', () => mapView.setBase('xyz', $('xyzUrl').value.trim()));
$('terrain').addEventListener('change', () => mapView.setTerrain($('terrain').checked));
for (const [id, key] of [['mapRecon', 'recon'], ['mapOriginal', 'original'], ['mapDiff', 'diff']]) {
  $(id).addEventListener('change', () => mapView.setObjectVisible(key, $(id).checked));
}

// ---------------- 3D ビュー ----------------
const VIEW_TOGGLES = { vOriginal: 'original', vError: 'error', vRecon: 'recon', vLost: 'lost', vAdded: 'added' };
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
    st.res = analyze(st.model, opts);
    assignColours(st.model, st.res);
    st.ev = evaluate(st.model, st.res, { errTol: +$('errTol').value || 0.5 });
    viewer.update(st.model, st.res, st.ev, { recolour: !reloadModel });
    $('clip').value = 100; $('clip').dispatchEvent(new Event('input'));
    renderReport();
    const objs = buildMapObjects(st.model, st.res, st.ev);
    mapView.setObject('recon', objs.recon, { visible: $('mapRecon').checked });
    mapView.setObject('original', objs.original, { visible: $('mapOriginal').checked });
    mapView.setObject('diff', objs.diff, { visible: $('mapDiff').checked });
    refreshGeo();
    if (reloadModel) mapView.flyTo(place.lon, place.lat);
    status(`変換完了（${((performance.now() - t0) / 1000).toFixed(2)} 秒）`);
  });
}

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
  $('report').innerHTML = `
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
