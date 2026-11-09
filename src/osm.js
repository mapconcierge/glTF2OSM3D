// building:part 群 → OSM XML (.osm, API 0.6 形式) / GeoJSON
// タグは OSM Wiki「Simple 3D Buildings」に準拠:
//   building / building:part / height / min_height / roof:shape / roof:height /
//   roof:orientation / roof:direction / building:colour / roof:colour / building:levels / building:min_level
import { localToLngLat, localAzimuthToGeo } from './geo.js';

const r1 = (v) => (Math.round(v * 10) / 10).toString();

export function partTags(p, place, opt) {
  const t = {};
  t.height = r1(p.H);
  if (p.B > 0.05) t.min_height = r1(p.B);
  const shape = p.shape === 'gabled_across' ? 'gabled' : p.shape;
  t['roof:shape'] = shape;
  if (shape !== 'flat') t['roof:height'] = r1(p.H - p.E);
  if (p.shape === 'gabled_across') t['roof:orientation'] = 'across';
  else if (['gabled', 'hipped', 'round'].includes(p.shape) && p.obb.hu / p.obb.hv > 1.05) t['roof:orientation'] = 'along';
  if (shape === 'skillion' && p.fit.dirLocal !== undefined) t['roof:direction'] = Math.round(localAzimuthToGeo(p.fit.dirLocal, place)).toString();
  if (opt.colours) {
    if (p.wallColour) t['building:colour'] = p.wallColour;
    if (p.roofColour) t['roof:colour'] = p.roofColour;
  }
  if (opt.levels && opt.floorHeight > 0) {
    const lv = Math.max(1, Math.round((p.E - p.B) / opt.floorHeight));
    t['building:levels'] = String(lv);
    const ml = Math.round(p.B / opt.floorHeight);
    if (ml > 0) t['building:min_level'] = String(ml);
  }
  return t;
}

/**
 * @returns {{xml:string, geojson:object, stats:object}}
 */
export function buildOsm(res, place, opt) {
  const nodes = new Map(); // key -> {id, lat, lon}
  const ways = [];
  const rels = [];
  let nid = -1, wid = -1, rid = -1;
  const node = (x, y) => {
    const [lon, lat] = localToLngLat(x, y, place);
    const key = `${lat.toFixed(8)},${lon.toFixed(8)}`;
    let n = nodes.get(key);
    if (!n) { n = { id: nid--, lat, lon }; nodes.set(key, n); }
    return n;
  };
  const ringWay = (ring, tags) => {
    const refs = ring.map(([x, y]) => node(x, y).id);
    // 連続重複の除去
    const clean = refs.filter((r, q) => r !== refs[(q + 1) % refs.length]);
    if (clean.length < 3) return null;
    clean.push(clean[0]);
    const w = { id: wid--, refs: clean, tags: tags || {} };
    ways.push(w);
    return w;
  };
  const features = [];
  const toGeo = (polys) => ({
    type: 'MultiPolygon',
    coordinates: polys.map((p) => [p.outer, ...p.holes].map((r) => { const c = r.map(([x, y]) => localToLngLat(x, y, place)); c.push(c[0]); return c; })),
  });
  // 戻り値: この面（パート）を構成する OSM 要素 { ways: [way], rel: relation | null }（ソース表示用）
  const emitArea = (polys, tags) => {
    let el;
    if (polys.length === 1 && polys[0].holes.length === 0) {
      const w = ringWay(polys[0].outer, tags);
      el = { ways: w ? [w] : [], rel: null };
    } else {
      const members = [], ws = [];
      for (const p of polys) {
        const o = ringWay(p.outer);
        if (o) { members.push({ ref: o.id, role: 'outer' }); ws.push(o); }
        for (const h of p.holes) { const w = ringWay(h); if (w) { members.push({ ref: w.id, role: 'inner' }); ws.push(w); } }
      }
      const r = { id: rid--, members, tags: { type: 'multipolygon', ...tags } };
      rels.push(r);
      el = { ways: ws, rel: r };
    }
    features.push({ type: 'Feature', properties: { ...tags }, geometry: toGeo(polys) });
    return el;
  };
  const partElems = new Map(); // part.id -> 要素

  const parts = res.parts;
  const common = {};
  if (opt.name) common.name = opt.name;
  const bType = opt.buildingType || 'yes';

  if (parts.length === 1) {
    partElems.set(parts[0].id, emitArea(parts[0].polygons, { building: bType, ...common, ...partTags(parts[0], place, opt) }));
  } else {
    const maxH = Math.max(...parts.map((p) => p.H));
    const bt = { building: bType, ...common, height: r1(maxH) };
    if (opt.levels && opt.floorHeight > 0) bt['building:levels'] = String(Math.max(1, Math.round(Math.max(...parts.map((p) => p.E)) / opt.floorHeight)));
    if (opt.colours && res.wallColour) bt['building:colour'] = res.wallColour;
    emitArea(res.outline, bt);
    for (const p of parts) partElems.set(p.id, emitArea(p.polygons, { 'building:part': 'yes', ...partTags(p, place, opt) }));
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tagXml = (tags) => Object.entries(tags).map(([k, v]) => `    <tag k="${esc(k)}" v="${esc(v)}"/>`).join('\n');
  const nodeXml = (n) => `  <node id="${n.id}" visible="true" lat="${n.lat.toFixed(8)}" lon="${n.lon.toFixed(8)}"/>`;
  const wayXml = (L, w) => {
    L.push(`  <way id="${w.id}" visible="true">`);
    for (const r of w.refs) L.push(`    <nd ref="${r}"/>`);
    if (Object.keys(w.tags).length) L.push(tagXml(w.tags));
    L.push('  </way>');
  };
  const relXml = (L, r) => {
    L.push(`  <relation id="${r.id}" visible="true">`);
    for (const m of r.members) L.push(`    <member type="way" ref="${m.ref}" role="${m.role}"/>`);
    L.push(tagXml(r.tags));
    L.push('  </relation>');
  };
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<osm version="0.6" generator="glTF2OSM3D">'];
  L.push(`  <!-- glTF2OSM3D による自動変換。実在建物でない場合や輸入ガイドラインに従わない場合は OSM へアップロードしないこと -->`);
  for (const n of nodes.values()) L.push(nodeXml(n));
  for (const w of ways) wayXml(L, w);
  for (const r of rels) relXml(L, r);
  L.push('</osm>');
  const nodeById = new Map([...nodes.values()].map((n) => [n.id, n]));
  /** 1 パート（building:part）分の OSM XML 断片。タグを持つ要素を先頭に（relation → way → node の順） */
  const partSource = (id) => {
    const el = partElems.get(id);
    if (!el) return '';
    const S = [];
    if (el.rel) relXml(S, el.rel);
    for (const w of el.ways) wayXml(S, w);
    const seen = new Set();
    for (const w of el.ways) for (const r of w.refs) if (!seen.has(r)) { seen.add(r); S.push(nodeXml(nodeById.get(r))); }
    const head = `<!-- ${el.rel ? `relation ${el.rel.id}（multipolygon, way ${el.ways.length} 本）` : `way ${el.ways[0]?.id}`} / node ${seen.size} 個 -->`;
    return head + '\n' + S.join('\n') + '\n';
  };
  return {
    xml: L.join('\n') + '\n',
    geojson: { type: 'FeatureCollection', features },
    stats: { nodes: nodes.size, ways: ways.length, relations: rels.length },
    partSource,
  };
}
