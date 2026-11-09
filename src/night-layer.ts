import { addProtocol, Map as MapLibreMap, RasterTileSource } from 'maplibre-gl';
import { SolarCalculator } from './utils/solar-calculator';

// Day/night as ONE continuous globe: NASA VIIRS city lights are faded in over the day imagery by the sun's elevation
// at every pixel, so the terminator is a soft twilight instead of a hard basemap swap. It is a normal MapLibre raster
// layer fed by a custom tile protocol (each night tile is made transparent where the sun is up), so it works with the
// globe, terrain and any pitch.

export const NIGHT_REFRESH_MS = 2 * 60 * 1000; // the sun moves ~0.5 deg in 2 min: re-render the tiles that often

const RAD = Math.PI / 180;
const tileUrl = (z: number, x: number, y: number) =>
  `https://gitc.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpg`;

// 0 = day, 1 = night, smooth through twilight: sun at +3 deg -> 0, sun at -12 deg (nautical twilight) -> 1
function nightness(sinElevation: number): number {
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD;
  const t = Math.max(0, Math.min(1, (3 - elevation) / 15));
  return t * t * (3 - 2 * t);
}

// Decoded city-lights tiles, so re-rendering the terminator (time-lapse) doesn't refetch/decode them
const rawTiles = new Map<string, ImageBitmap>();

// `nightlights://{z}/{x}/{y}?t=<ms>` -> PNG of the city-lights tile with alpha = nightness(sun elevation at time t)
async function loadNightTile(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const [, z, x, y, t] = url.match(/^nightlights:\/\/(\d+)\/(\d+)\/(\d+)\?t=(\d+)/)!.map(Number);
  const sun = SolarCalculator.sunPoint(new Date(t));
  const key = `${z}/${x}/${y}`;
  let bitmap = rawTiles.get(key);
  if (!bitmap) {
    const res = await fetch(tileUrl(z, x, y), { signal });
    if (!res.ok) throw new Error(`night tile ${key}: ${res.status}`);
    bitmap = await createImageBitmap(await res.blob());
    if (rawTiles.size > 300) rawTiles.clear();
    rawTiles.set(key, bitmap);
  }
  const size = bitmap.width;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, size, size);

  const n = 2 ** z;
  const sinDec = Math.sin(sun.lat * RAD), cosDec = Math.cos(sun.lat * RAD);
  const cosHour = new Float32Array(size); // per column: cos(longitude - sun longitude)
  const sinLat = new Float32Array(size);  // per row (Web Mercator -> latitude)
  const cosLat = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    cosHour[i] = Math.cos(((x + (i + 0.5) / size) / n * 360 - 180 - sun.lng) * RAD);
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (i + 0.5) / size) / n)));
    sinLat[i] = Math.sin(lat);
    cosLat[i] = Math.cos(lat);
  }
  const d = img.data;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      d[(j * size + i) * 4 + 3] = 255 * nightness(sinLat[j] * sinDec + cosLat[j] * cosDec * cosHour[i]);
    }
  }
  ctx.putImageData(img, 0, 0);
  const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  return png!.arrayBuffer();
}

let protocolRegistered = false;

export function installNightShading(map: MapLibreMap, beforeLayerId?: string) {
  if (!protocolRegistered) {
    addProtocol('nightlights', async (params, abort) => ({ data: await loadNightTile(params.url, abort.signal) }));
    protocolRegistered = true;
  }
  // Real time: re-render every NIGHT_REFRESH_MS. Time-lapse (setTime): follow the simulated clock, at most once a second.
  let override: number | null = null;
  let applied = -1;
  let lastApply = 0;
  const step = () => (override === null ? NIGHT_REFRESH_MS : 5 * 60 * 1000);
  const timeKey = () => Math.floor((override ?? Date.now()) / step()) * step();
  const tiles = () => [`nightlights://{z}/{x}/{y}?t=${timeKey()}`];
  const apply = () => {
    applied = timeKey();
    lastApply = performance.now();
    (map.getSource('night-lights') as RasterTileSource | undefined)?.setTiles(tiles());
  };
  map.addSource('night-lights', { type: 'raster', tiles: tiles(), tileSize: 256, minzoom: 0, maxzoom: 8 });
  map.addLayer({ id: 'night-lights', type: 'raster', source: 'night-lights' }, beforeLayerId);
  applied = timeKey();
  setInterval(() => { if (override === null) apply(); }, NIGHT_REFRESH_MS);

  return {
    /** Toggle the shading; returns whether it is now on. */
    toggle(): boolean {
      const on = map.getLayoutProperty('night-lights', 'visibility') === 'none';
      map.setLayoutProperty('night-lights', 'visibility', on ? 'visible' : 'none');
      return on;
    },
    /** Follow a simulated clock (ms since epoch) instead of real time; null returns to real time. */
    setTime(ms: number | null) {
      override = ms;
      if (ms === null) apply();
      else if (timeKey() !== applied && performance.now() - lastApply > 900) apply();
    }
  };
}
