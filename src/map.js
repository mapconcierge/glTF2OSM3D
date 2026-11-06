// MapLibre GL JS: 配置用の地図（Globe/Mercator 切替、OpenFreeMap / OSM / 任意 XYZ、Mapterhorn 標高）
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// バンドル後は import.meta.url から worker を推定できないため、明示的に URL を与える
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(new URL(workerUrl, import.meta.url).href);

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles/liberty';
const OSM_STYLE = (tiles, attribution) => ({
  version: 8,
  sources: { base: { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom: 19, attribution } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
});
const MAPTERHORN = {
  type: 'raster-dem',
  // https://tiles.mapterhorn.com/tilejson.json より: terrarium, tileSize 512。
  // tilejson に maxzoom が無いため、z17 の 404 を避けるよう 16 に制限（日本域で z16 まで取得を確認）
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  encoding: 'terrarium',
  tileSize: 512,
  maxzoom: 16,
  attribution: "<a href='https://mapterhorn.com/attribution'>© Mapterhorn</a>",
};

export class MapView {
  constructor(el, { center, onPick }) {
    this.state = { base: 'openfreemap', xyz: '', projection: 'globe', terrain: true, hideBase3d: true };
    this.data = { parts: empty(), outline: empty(), err: empty() };
    this.map = new maplibregl.Map({
      container: el,
      style: OPENFREEMAP,
      center,
      zoom: 18,
      pitch: 55,
      bearing: -20,
      maxZoom: 22,
      maxPitch: 80,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.marker = new maplibregl.Marker({ draggable: true, color: '#d62728' }).setLngLat(center).addTo(this.map);
    this.marker.on('dragend', () => { const { lng, lat } = this.marker.getLngLat(); onPick(lng, lat); });
    this.map.on('click', (e) => { if (this.pickMode) { onPick(e.lngLat.lng, e.lngLat.lat); } });
    this.map.on('style.load', () => this.installLayers());
    this.pickMode = true;
  }

  setBase(base, xyz) {
    this.state.base = base;
    this.state.xyz = xyz || this.state.xyz;
    let style = OPENFREEMAP;
    if (base === 'osm') style = OSM_STYLE('https://tile.openstreetmap.org/{z}/{x}/{y}.png', '© OpenStreetMap contributors');
    if (base === 'xyz' && this.state.xyz) style = OSM_STYLE(this.state.xyz, 'custom tiles');
    this.map.setStyle(style);
  }

  setProjection(p) { this.state.projection = p; this.map.setProjection({ type: p }); }
  setTerrain(on) { this.state.terrain = on; this.applyTerrain(); }
  applyTerrain() {
    if (!this.map.getSource('mapterhorn')) this.map.addSource('mapterhorn', MAPTERHORN);
    this.map.setTerrain(this.state.terrain ? { source: 'mapterhorn', exaggeration: 1 } : null);
  }

  /** 背景スタイルの 3D 建物（fill-extrusion）の表示切替。配置先の既存建物と重なって見えにくくなるのを防ぐ */
  setHideBase3d(on) { this.state.hideBase3d = on; this.applyBase3d(); }
  applyBase3d() {
    for (const l of this.map.getStyle()?.layers || []) {
      if (l.type === 'fill-extrusion' && l.id !== 'parts-ext') this.map.setLayoutProperty(l.id, 'visibility', this.state.hideBase3d ? 'none' : 'visible');
    }
  }

  installLayers() {
    const m = this.map;
    this.applyBase3d();
    m.setProjection({ type: this.state.projection });
    this.applyTerrain();
    for (const [id, d] of Object.entries(this.data)) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: d });
    m.addLayer({
      id: 'err-fill', type: 'fill', source: 'err',
      paint: { 'fill-color': ['interpolate', ['linear'], ['get', 'e'], 0, '#ffffb2', 1, '#fd8d3c', 3, '#bd0026'], 'fill-opacity': 0.75 },
      layout: { visibility: this.visErr ? 'visible' : 'none' },
    });
    m.addLayer({ id: 'outline-line', type: 'line', source: 'outline', paint: { 'line-color': '#d62728', 'line-width': 2, 'line-dasharray': [2, 1] } });
    m.addLayer({
      id: 'parts-ext', type: 'fill-extrusion', source: 'parts',
      paint: {
        'fill-extrusion-color': ['get', '_colour'],
        'fill-extrusion-height': ['get', '_h'],
        'fill-extrusion-base': ['get', '_b'],
        'fill-extrusion-opacity': 0.9,
      },
      layout: { visibility: this.visParts === false ? 'none' : 'visible' },
    });
  }

  setData(key, fc) {
    this.data[key] = fc;
    this.map.getSource(key)?.setData(fc);
  }

  setLayerVisible(id, on) {
    if (id === 'err-fill') this.visErr = on;
    if (id === 'parts-ext') this.visParts = on;
    if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  setMarker(lng, lat) { this.marker.setLngLat([lng, lat]); }
  flyTo(lng, lat) { this.map.flyTo({ center: [lng, lat], zoom: Math.max(this.map.getZoom(), 17.5) }); }
}

function empty() { return { type: 'FeatureCollection', features: [] }; }
