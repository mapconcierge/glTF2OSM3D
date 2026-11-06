// 局所座標 (モデル座標: x=東, y=北, z=上, 単位 m) ⇔ WGS84 (EPSG:4326) 変換
// 建物1棟規模（数百 m 以内）を想定した局所接平面近似。
// 子午線曲率半径 M と卯酉線曲率半径 N を GRS80/WGS84 楕円体で計算する。

const A = 6378137.0;
const E2 = 0.00669438002290; // GRS80 (WGS84 とは実用上同一)
const D2R = Math.PI / 180;

/**
 * モデル局所座標 → [lon, lat]
 * @param {number} x 東方向 (m, 回転前)
 * @param {number} y 北方向 (m, 回転前)
 * @param {{lon:number, lat:number, heading:number}} place heading は時計回り(度)
 */
export function localToLngLat(x, y, place) {
  const h = place.heading * D2R;
  const e = x * Math.cos(h) + y * Math.sin(h);
  const n = -x * Math.sin(h) + y * Math.cos(h);
  const phi = place.lat * D2R;
  const s = Math.sin(phi);
  const w = Math.sqrt(1 - E2 * s * s);
  const M = (A * (1 - E2)) / (w * w * w);
  const N = A / w;
  return [place.lon + e / (N * Math.cos(phi)) / D2R, place.lat + n / M / D2R];
}

/** 局所座標系での方位角(度, 北=0 時計回り) を地理方位角へ */
export function localAzimuthToGeo(az, place) {
  return (((az + place.heading) % 360) + 360) % 360;
}
