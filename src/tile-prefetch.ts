// Tiles where the tracked satellite is heading, fetched ahead of the camera: the day imagery into the HTTP cache (Esri
// keeps them a day), the night lights into Cache Storage (night-layer.ts keeps them for good). Only along its track,
// not the whole world at this zoom: ~2000 tiles, 40 MB for every visitor, and Esri's terms forbid bulk downloading.
import { nightTileBytes } from './night-layer';

export const ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_ZOOMS = [4, 5, 6]; // what the tracking view requests (tileSize 128 in main.ts: a level above the 256 px norm)
const NIGHT_ZOOMS = [3, 4, 5];
const CONCURRENCY = 4; // in the background: leave room for the tiles on screen

const queued = new Set<string>(), queue: Array<{ key: string; get: () => Promise<unknown> }> = [];
let running = 0;

/** Fetch the tiles around these [lng, lat] points (each one's and its 8 neighbours), once per page. A new call drops
 *  what the last one hadn't started: only the latest stretch of track matters (a time-lapse moves on fast). */
export function prefetchAround(points: number[][]) {
  for (const { key } of queue.splice(0)) queued.delete(key);
  for (const [lng0, lat] of points) {
    const lng = ((lng0 + 540) % 360) - 180, s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
    const add = (z: number, kind: 'esri' | 'night', get: (x: number, y: number) => Promise<unknown>) => {
      const n = 2 ** z, x0 = Math.floor((lng + 180) / 360 * n), y0 = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const x = (x0 + dx + n) % n, y = y0 + dy, key = `${kind}/${z}/${x}/${y}`;
        if (y < 0 || y >= n || queued.has(key)) continue;
        queued.add(key);
        queue.push({ key, get: () => get(x, y) });
      }
    };
    for (const z of ESRI_ZOOMS) add(z, 'esri', (x, y) => fetch(ESRI_TILES.replace('{z}', `${z}`).replace('{y}', `${y}`).replace('{x}', `${x}`)));
    for (const z of NIGHT_ZOOMS) add(z, 'night', (x, y) => nightTileBytes(z, x, y));
  }
  pump();
}

let idle: Array<() => void> = [];

/** Resolves once everything asked for so far has been fetched (or failed). */
export const prefetched = () => new Promise<void>(resolve => { idle.push(resolve); pump(); });

function pump() {
  while (running < CONCURRENCY && queue.length) {
    running++;
    queue.shift()!.get().catch(() => { /* on screen it'll be fetched again */ }).finally(() => { running--; pump(); });
  }
  if (!running && !queue.length) { idle.forEach(f => f()); idle = []; }
}
