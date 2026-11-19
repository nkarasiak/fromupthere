// Sentinel-2 images over a place, with their cloud cover, from Element 84's Earth Search STAC (public, no key).
// eo:cloud_cover is the share of the whole 110 km tile that is cloudy, not the cloud over the place itself.
const SEARCH = 'https://earth-search.aws.element84.com/v1/search';
const MATCH_MS = 10 * 60e3; // an image's time and the pass's closest approach: a few minutes apart along the track

export interface Scene { platform: string; t: number; cloud: number } // platform: 'sentinel-2a'…, as satellite ids

/** The L2A images over (lat, lng) acquired in [from, to] (ms). */
export async function s2Scenes(lat: number, lng: number, from: number, to: number): Promise<Scene[]> {
  const r = await fetch(SEARCH, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-c1-l2a'], intersects: { type: 'Point', coordinates: [lng, lat] },
      datetime: `${new Date(from).toISOString()}/${new Date(to).toISOString()}`, limit: 250,
      fields: { include: ['properties.datetime', 'properties.platform', 'properties.eo:cloud_cover'], exclude: ['assets', 'links', 'geometry', 'bbox'] }
    })
  });
  if (!r.ok) throw new Error(`Earth Search ${r.status}`);
  const d: { features: Array<{ properties: Record<string, any> }> } = await r.json();
  return d.features.map(({ properties: p }) => ({ platform: p.platform, t: Date.parse(p.datetime), cloud: p['eo:cloud_cover'] }));
}

/** The image of satellite `id` from its pass at t: where the place lies in two tiles, the clearer one. */
export function sceneAt(scenes: Scene[], id: string, t: number): Scene | undefined {
  return scenes.filter(s => s.platform === id && Math.abs(s.t - t) < MATCH_MS).sort((a, b) => a.cloud - b.cloud)[0];
}
