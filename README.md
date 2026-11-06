# glTF2OSM3D

glTF の建物モデル（1 棟）を、OpenStreetMap の [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings)（S3DB）タグによる `.osm` に変換し、**OSM では表現できない部分を説明つきで可視化する** ブラウザツールです。

Converts a single glTF building model into an OpenStreetMap `.osm` file using Simple 3D Buildings tagging (`building:part`, `height`, `min_height`, `roof:shape`, …), and visualises — with explanations — which parts of the geometry cannot be represented in OSM.

**デモ / Demo:** https://mapconcierge.github.io/glTF2OSM3D/

## 概要

- glTF/GLB を読み込み、地図上の任意の位置・向きに配置
- メッシュを `building:part` の集合に自動分解し、`.osm`（JOSM で開ける API 0.6 形式）と GeoJSON を出力
- 元モデルと OSM 表現の差分を定量化（体積 IoU、欠落/過剰体積、表面誤差）し、3D ビューで可視化
  - **誤差ヒートマップ**: 元モデルの各面が OSM 形状からどれだけ離れているか（緑→黄→赤）
  - **OSM 復元**: タグから再構成した形状（roof:shape ごとに色分け、段状近似はオレンジ）
  - **欠落 / 過剰ボクセル**: glTF にあって OSM にない体積（赤）、その逆（青）
  - 断面スライダーで内部も確認可能
- 「OSM で表現できない／近似した要素」を自動検出して日本語で説明（曲面・テーパー壁、下向きの傾斜面、軒の出、小要素、地下部分、テクスチャなど）

### 2 段パイプライン（v0.3〜）

細かすぎる glTF をそのまま OSM タグに変換すると、細部ごとにパートや段状近似が増えて OSM データとして扱いにくくなります。そこで次の 2 段で処理します（「単純化」はオフにもできます）。

1. **ステージ1: 単純化（マスモデル化）** — Mapbox の 3D 建物表現（押し出し＋角や上端の丸め）を参考に、必要最低限の形と見栄えを両立する軽量メッシュを生成（`src/simplify.js`）
   - 薄い部材（手すり・ルーバー・薄い庇）の除去、鉛直方向の小さな隙間の充填
   - 平面のモルフォロジー（オープニング→クロージング）で細部サイズ未満の突起・切欠きを除去
   - 高さ場のメディアンフィルタで煙突・十字架・窓枠などの小さな凹凸を除去、ほぼ水平な面は同じ高さへスナップ
   - 段差（minmod 制限付き勾配で斜面と区別）で領域分割し、斜面は roof:shape プリセットを当てはめて平面・円錐等のきれいな屋根面に（当てはまらない斜面は平坦部／斜面部に再分割、それでも合わなければ高さ場の曲面）
   - 外形を Douglas–Peucker で簡略化し、角を円弧で丸める（半径既定 0.6 m）。陸屋根の上端エッジも 1/4 円で丸める（既定 0.3 m）
   - 単純化モデルは `.glb` でダウンロード可能（頂点統合済み）
2. **ステージ2: OSM 3D タグ化** — 単純化モデル（既定では角丸め前の形）を下記アルゴリズムで building:part に変換

誤差評価（一致度 IoU・欠落/過剰体積・誤差ヒートマップ）は**常に元の glTF を基準**にした最終結果です。ステージ1 単体の一致度も表示します。

| サンプル | 三角形（元 → 単純化） | パート数（直接 → 2 段） | IoU（直接 → 2 段） |
|---|---|---|---|
| ウェスレー・チャペル | 26,347 → 10,464 | 46（段状 12）→ 16（段状 2） | 96.9% → 93.9% |
| 複合ビル（合成） | 2,844 → 5,612 | 19 → 17 | 99.4% → 95.9% |
| 自由曲面タワー（合成） | 5,376 → 2,886 | 36 → 1 | 98.1% → 81.4% |

チャペルの単純化 GLB は 1,137 kB → 421 kB。合成モデルはもともと三角形が少ないため、角丸めで三角形が増えることがあります。

### 変換アルゴリズム（ステージ2）

1. **2.5D ボクセル化**: 水平グリッドの各セルから鉛直レイを投射し、面の向き（上向き/下向き）から占有区間 `[底, 頂]` を求める（重なったメッシュ、底の無いメッシュにも対応）
2. **領域分割**: 底面高さが同じで隣接するセルを連結 → パートごとの `min_height`（キャンチレバー・ピロティ・アーチ）
3. **屋根フィット**: 各領域の上面を `flat / skillion / gabled / hipped / pyramidal / round / dome / cone` に最小二乗フィット（最小外接矩形で棟方向を決定）。塔屋・煙突などの突出物は外れ値として別パートに分離
4. **段状近似**: どのプリセットにも当てはまらない曲面・傾斜壁は、高さ方向のひな壇状パートに分解
5. **ポリゴン化**: セル集合の輪郭を追跡し Douglas–Peucker で簡略化。穴や分離形状は `type=multipolygon`
6. **評価**: 簡略化後のポリゴンとタグから形状を復元し、元メッシュと比較

### OSM（S3DB）で表現できない主なもの

| 要素 | 理由 | 本ツールの扱い |
|---|---|---|
| 曲面壁・傾いた壁（テーパー） | building:part は鉛直押し出しのみ | 段状パートで近似 |
| プリセット外の屋根（複合屋根・ドーマー・自由曲面） | roof:shape は定型のみ、1 パート 1 屋根 | 突出物分離 or 段状近似 |
| 下向きの傾斜面・曲面（アーチ、斜め天井） | min_height は水平な底面のみ | 底面高さ別のパートで段状近似 |
| 軒の出・庇 | 確立したタグがない | 隣接パートに併合（壁を延長）または浮いた薄いパート |
| 地下部分 | height/min_height は地上の高さ | 切り捨て |
| テクスチャ・細部（窓、手すり等） | 色タグ・解析解像度の限界 | 平均色を `building:colour` / `roof:colour` に |

## 使い方

### サンプル

| ファイル | 内容 |
|---|---|
| `wesley_chapel_agu_sagamihara.glb`（既定） | 青山学院大学 相模原キャンパス ウェスレー・チャペル（LOD3, 実在建物）。OSM の既存外形（[way 99028196](https://www.openstreetmap.org/way/99028196)）に合わせて位置 139.4018359, 35.5664521、向き 51.5° に自動配置 |
| `house_gabled.glb` | 合成: 切妻屋根の住宅（煙突・軒の出） |
| `complex_tower.glb` | 合成: 塔・ドーム・ヴォールト・円錐台・キャンチレバー・アーチ門 |
| `curved_tower.glb` | 合成: 自由曲面（回転体）のタワー |

チャペルの配置は、モデルの解析セルが OSM 外形の内側に入る割合が最大になる向き・中心を探索して求めました（一致率 97%、逆向き 76%）。

`sampledata/` には元データ（チャペル単体および相模原キャンパス全建物の glTF / GLB / USDZ / OBJ）を収録しています。

### Web 版
1. `.glb`（または `.gltf` + `.bin` + テクスチャ）をドロップ、もしくはサンプルを選択
2. 上方向軸（glTF 標準は Y-up）・縮尺（メートル換算）・地盤面オフセットを確認
3. 地図をクリック／マーカーをドラッグして配置、向きをスライダーで調整（初期位置は青山学院大学 相模原キャンパスのチャペル）
4. 結果パネルで「表現できない要素」と誤差を確認し、必要ならパラメータ（解析セル、段の高さ、屋根許容 RMS、最小パート面積）を調整して再変換
5. `.osm をダウンロード` → JOSM 等で確認

### ローカル開発
```bash
npm install
npm run dev      # 開発サーバー
npm run build    # dist/ へビルド（GitHub Pages は Actions で自動デプロイ）
npm test         # サンプル 3 件を Node 上で変換して統計を表示
npm run samples  # public/samples/*.glb を再生成
node scripts/test-convert.mjs path/to/model.glb out.osm   # CLI で変換
```

### 座標系
- モデル座標: glTF（Y-up, メートル）→ 局所 ENU（x=東, y=北, z=上）。原点はバウンディングボックス底面中心
- 出力: WGS84 経緯度（EPSG:4326）。配置点まわりの局所接平面近似（GRS80 楕円体の子午線/卯酉線曲率半径）で変換。建物 1 棟規模（数百 m 以内）を想定
- `height` / `min_height` は地盤面（モデル最下点＋オフセット）からの高さ [m]

### 地図
- 地図エンジン: [MapLibre Navara](https://github.com/maplibre/navara)（`@navaramap/three` v0.2.1, beta。Rust/WASM の GIS コア + three.js 描画の 3D 地球儀）
  - OSM タグから復元した形状（`roof:shape` による尖塔・ドーム・切妻などを含む）と元 glTF を、three.js オブジェクトとして経緯度・方位で地形上に配置
  - 初期版（MapLibre GL JS）では `fill-extrusion` が屋根形状を描けず LOD1 相当の押し出し表示だったため置き換えた（旧実装は git 履歴 `3741ea9` 以前を参照）
- 上の地図と下の 3D ビューはカメラ連動。起動時は建物の周りをゆっくり自動周回（約 2 分で 1 周）し、「⏸ 一時停止 / ▶ 自動回転」ボタン（地図右下・3D ビュー左上）で切替。どちらかを手で操作すると自動回転は止まり、操作した側のカメラにもう一方が追従する
- 背景: OSM 標準タイル（既定）/ 任意 XYZ タイル URL / OpenFreeMap（MapLibre スタイルプラグイン経由・実験的）
- 地形: [Mapterhorn](https://mapterhorn.com/) 標高タイル（terrarium, 512px, maxzoom 16）
- 既知の制約（Navara v0.2.1 時点）
  - 地球儀表示のみで、Web メルカトル（2D）投影への切替は未対応
  - OpenFreeMap（MapLibre スタイル）は道路等が描画されず、配置した建物も見えなくなるため既定にしていない
  - WASM・大気散乱テーブル等を含むため、初回読み込みが重い（数十 MB）

## 注意

- 生成データは自動変換の結果です。実在建物を OpenStreetMap にアップロードする場合は、[インポートガイドライン](https://wiki.openstreetmap.org/wiki/Import/Guidelines)、元モデルのライセンス、位置合わせを必ず確認してください
- `roof:shape` の解釈（棟の向き等）はレンダラー（OSM2World, F4 Map, OSM Buildings など）ごとに異なります。「OSM 復元」表示は本ツールによる 1 つの解釈です
- 街区全体の一括変換ではなく、建物 1 棟ずつの変換を想定しています

## データソース・ライセンス

- コード・合成サンプルモデル（`scripts/make-samples.mjs` で生成）: [CC0 1.0](LICENSE)
- ウェスレー・チャペル / 相模原キャンパス全建物モデル（`public/samples/wesley_chapel_agu_sagamihara.glb`, `sampledata/`）: [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
  - This work is based on "[Wesley Chapel, AGU Sagamihara Campus (LOD3)](https://sketchfab.com/3d-models/wesley-chapel-agu-sagamihara-campus-lod3-e85177e3f4ed4f66a96d55f007abebe7)" by [ibukilego](https://sketchfab.com/ibukilego) licensed under CC-BY-4.0
  - This work is based on "[All buildings, AGU Sagamihara Campus (LOD2-3)](https://sketchfab.com/3d-models/all-buildings-agu-sagamihara-campus-lod2-3-38d128441293472ba2e9fab6d8eae3d3)" by [ibukilego](https://sketchfab.com/ibukilego) licensed under CC-BY-4.0
- 初期配置の参照: OpenStreetMap の「C棟-チャペル」外形（© OpenStreetMap contributors, ODbL）
- 出力 `.osm` を OpenStreetMap に投稿した場合、そのデータは [ODbL](https://opendatacommons.org/licenses/odbl/) の下で提供されます
- 地図: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（OpenFreeMap 使用時は [OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles](https://openmaptiles.org/)）
- 標高: © [Mapterhorn](https://mapterhorn.com/attribution)
- ライブラリ: [MapLibre Navara](https://github.com/maplibre/navara)（MIT OR Apache-2.0）、[three.js](https://threejs.org/)（MIT）、[glTF Transform](https://gltf-transform.dev/)（MIT, サンプル生成のみ）

## 著者

古橋大地 / Taichi Furuhashi — 青山学院大学 地球社会共生学部 古橋研究室（Furuhashi Lab）

## 関連リンク

- [Simple 3D Buildings – OSM Wiki](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings)
- [Key:roof:shape – OSM Wiki](https://wiki.openstreetmap.org/wiki/Key:roof:shape)
- [glTF 2.0 Specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
