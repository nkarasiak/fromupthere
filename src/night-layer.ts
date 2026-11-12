import { addProtocol, LightSpecification, Map as MapLibreMap, RasterTileSource } from 'maplibre-gl';
import { SolarCalculator } from './utils/solar-calculator';

// Day/night as ONE continuous globe: NASA VIIRS city lights are faded in over the day imagery by the sun's elevation
// at every pixel, so the terminator is a soft twilight instead of a hard basemap swap. It is a normal MapLibre raster
// layer fed by a custom tile protocol (each night tile is made transparent where the sun is up), so it works with the
// globe, terrain and any pitch.

export const NIGHT_REFRESH_MS = 2 * 60 * 1000; // the sun moves ~0.5 deg in 2 min: re-render the tiles that often
// ...but never more often than this in real time: a fast time-lapse (x300: every second) re-rendered and uploaded
// every tile nonstop, which piled up into GPU stalls of a second or more
const MIN_REAL_REFRESH_MS = 3000;

const RAD = Math.PI / 180;
const tileUrl = (z: number, x: number, y: number) =>
  `https://gitc.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_CityLights_2012/default/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpg`;

// 0 = day, 1 = night, smooth through twilight: sun at +3 deg -> 0, sun at -12 deg (nautical twilight) -> 1
const SIN_DAY = Math.sin(3 * RAD), SIN_NIGHT = Math.sin(-12 * RAD);
function nightness(sinElevation: number): number {
  if (sinElevation >= SIN_DAY) return 0; // most of the globe is fully day or fully night: skip the asin
  if (sinElevation <= SIN_NIGHT) return 1;
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD;
  const t = Math.max(0, Math.min(1, (3 - elevation) / 15));
  return t * t * (3 - 2 * t);
}

// The 2012 city lights never change, but NASA serves them no-store: the browser refetched each one every time (0.2-1.7 s).
// Their bytes are kept in Cache Storage, across visits (none in an insecure context: then just fetched).
export async function nightTileBytes(z: number, x: number, y: number, signal?: AbortSignal): Promise<Blob> {
  const url = tileUrl(z, x, y);
  const cache = typeof caches === 'undefined' ? null : await caches.open('night-tiles-v1').catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return hit.blob();
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`night tile ${z}/${x}/${y}: ${res.status}`);
  cache?.put(url, res.clone()).catch(() => { /* full: fetched again next time */ });
  return res.blob();
}

// Decoded city-lights tiles, so re-rendering the terminator (time-lapse) doesn't refetch/decode them
const rawTiles = new Map<string, ImageBitmap>();

// The day/night alpha is computed on a MASK x MASK grid and smoothly scaled up over the tile: the twilight band is
// ~15 deg wide, far coarser than a tile pixel, so this looks the same as per-pixel at 1/16 of the work (per-pixel
// sun angles + readback + PNG encode/decode on the main thread caused 100-170 ms hitches during the time-lapse).
const MASK = 64;

// `nightlights://{z}/{x}/{y}?t=<ms>` -> the city-lights tile with alpha = nightness(sun elevation at time t),
// returned as an ImageBitmap (MapLibre takes it as is: no PNG round trip)
async function loadNightTile(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const [, z, x, y, t] = url.match(/^nightlights:\/\/(\d+)\/(\d+)\/(\d+)\?t=(\d+)/)!.map(Number);
  // MapLibre requests every tile at once: give each its own task, so a refresh is spread over several frames
  // instead of compositing (and uploading) them all in one long one
  await new Promise(resolve => setTimeout(resolve));
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  const sun = SolarCalculator.sunPoint(new Date(t));
  const key = `${z}/${x}/${y}`;
  let bitmap = rawTiles.get(key);
  if (!bitmap) {
    bitmap = await createImageBitmap(await nightTileBytes(z, x, y, signal));
    if (rawTiles.size > 300) rawTiles.clear();
    rawTiles.set(key, bitmap);
  }

  const n = 2 ** z;
  const sinDec = Math.sin(sun.lat * RAD), cosDec = Math.cos(sun.lat * RAD);
  const mask = new OffscreenCanvas(MASK, MASK);
  const img = new ImageData(MASK, MASK);
  for (let j = 0; j < MASK; j++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (j + 0.5) / MASK) / n))); // Web Mercator row -> latitude
    const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
    for (let i = 0; i < MASK; i++) {
      const cosHour = Math.cos(((x + (i + 0.5) / MASK) / n * 360 - 180 - sun.lng) * RAD);
      img.data[(j * MASK + i) * 4 + 3] = 255 * nightness(sinLat * sinDec + cosLat * cosDec * cosHour);
    }
  }
  mask.getContext('2d')!.putImageData(img, 0, 0);

  const size = bitmap.width;
  const out = new OffscreenCanvas(size, size);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  ctx.globalCompositeOperation = 'destination-in'; // keep the lights only where the mask is opaque (night)
  ctx.drawImage(mask, 0, 0, size, size);
  return out.transferToImageBitmap();
}

// MapLibre lights the globe atmosphere from `light.position` (anchor 'map'), in a globe frame where x points to lng 90,
// y to the north pole and z to lng 0/lat 0, and it negates sphericalToCartesian([r, azimuthal + 90, polar]).
// Invert that so the glow and haze face the real sun.
function sunLight(t: number): LightSpecification {
  const sun = SolarCalculator.sunPoint(new Date(t));
  const x = Math.cos(sun.lat * RAD) * Math.sin(sun.lng * RAD);
  const y = Math.sin(sun.lat * RAD);
  const z = Math.cos(sun.lat * RAD) * Math.cos(sun.lng * RAD);
  return { anchor: 'map', position: [1.5, Math.atan2(-y, -x) / RAD - 90, Math.acos(-z) / RAD] };
}

let protocolRegistered = false;

export function installNightShading(map: MapLibreMap, beforeLayerId?: string) {
  if (!protocolRegistered) {
    addProtocol('nightlights', async (params, abort) => ({ data: await loadNightTile(params.url, abort.signal) }));
    protocolRegistered = true;
  }
  // Real time: re-render every NIGHT_REFRESH_MS. Time-lapse (setTime): follow the simulated clock.
  // Double-buffered: a new sun time renders into the hidden buffer (opacity 0 still loads tiles) and is swapped in only
  // once ALL its tiles are ready. setTiles on the visible source instead reloads tile by tile, leaving a patchwork of
  // squares from different times on screen.
  let override: number | null = null;
  let applied = -1;   // time shown
  let pending = -1;   // time loading in the back buffer
  let front = 0;
  let pendingSince = 0;
  const ids = ['night-lights-a', 'night-lights-b'];
  const step = () => (override === null ? NIGHT_REFRESH_MS : 5 * 60 * 1000);
  const timeKey = () => Math.floor((override ?? Date.now()) / step()) * step();
  const tiles = (t: number) => [`nightlights://{z}/{x}/{y}?t=${t}`];
  let shown = 1; // 0 while the opening hides the imagery (the tiles still load)
  const swap = () => {
    if (pending < 0) return;
    front = 1 - front;
    map.setPaintProperty(ids[front], 'raster-opacity', shown);
    map.setPaintProperty(ids[1 - front], 'raster-opacity', 0);
    applied = pending;
    pending = -1;
    map.setLight(sunLight(applied));
  };
  const apply = () => {
    const t = timeKey();
    if (t === applied || pending >= 0) return; // one load at a time: the next time starts once this one is shown
    if (performance.now() - pendingSince < MIN_REAL_REFRESH_MS) return;
    pendingSince = performance.now();
    pending = t;
    (map.getSource(ids[1 - front]) as RasterTileSource | undefined)?.setTiles(tiles(t));
  };
  map.on('sourcedata', e => {
    // swap when the back buffer is complete (or after 4 s, so a camera that keeps moving can't stall it forever)
    if (pending >= 0 && e.sourceId === ids[1 - front] &&
        (map.isSourceLoaded(ids[1 - front]) || performance.now() - pendingSince > 4000)) swap();
  });
  applied = timeKey();
  ids.forEach((id, i) => {
    map.addSource(id, { type: 'raster', tiles: tiles(applied), tileSize: 256, minzoom: 0, maxzoom: 8 });
    map.addLayer({
      id, type: 'raster', source: id,
      // no opacity transition: a cross-fade puts both buffers near 0.5 mid-swap, so the day imagery flashes through the night side
      paint: { 'raster-opacity': i === front ? 1 : 0, 'raster-opacity-transition': { duration: 0, delay: 0 }, 'raster-fade-duration': 0 }
    }, beforeLayerId);
  });
  map.setLight(sunLight(applied));
  setInterval(() => { if (override === null) apply(); }, NIGHT_REFRESH_MS);

  return {
    /** Follow a simulated clock (ms since epoch) instead of real time; null returns to real time. */
    setTime(ms: number | null) {
      override = ms;
      apply();
    },
    /** Show (1) or hide (0) the lights, fading over `ms` */
    setShown(opacity: number, ms = 0) {
      shown = opacity;
      map.setPaintProperty(ids[front], 'raster-opacity-transition', { duration: ms, delay: 0 });
      map.setPaintProperty(ids[front], 'raster-opacity', opacity);
      setTimeout(() => map.setPaintProperty(ids[front], 'raster-opacity-transition', { duration: 0, delay: 0 }), ms + 50); // swaps stay instant
    }
  };
}
