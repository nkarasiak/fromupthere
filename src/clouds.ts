// Cloud cover over a place, hour by hour, from Open-Meteo (free, no key): its weather models' analysis for the
// past weeks, their forecast for the next 16 days. A model's cloud cover over the place, not the one in an image.
const URL_BASE = 'https://api.open-meteo.com/v1/forecast?hourly=cloud_cover&past_days=92&forecast_days=16&timezone=GMT&timeformat=unixtime';
const HOUR = 3600e3;
const cache = new Map<string, Promise<Map<number, number>>>();

/** Hourly cloud cover (%) at (lat, lng), keyed by the hour (ms); hours without a value are left out. One request
 * per 0.1° cell and session: a failed one is dropped, so the next call tries again. */
export function cloudCover(lat: number, lng: number): Promise<Map<number, number>> {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  let p = cache.get(key);
  if (!p) {
    p = fetch(`${URL_BASE}&latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`Open-Meteo ${r.status}`))))
      .then((d: { hourly: { time: number[]; cloud_cover: (number | null)[] } }) => {
        const m = new Map<number, number>();
        d.hourly.time.forEach((t, i) => { const c = d.hourly.cloud_cover[i]; if (c !== null) m.set(t * 1e3, c); });
        return m;
      });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** The cloud cover at time t (ms), from the nearest hour; undefined outside the model's range. */
export const cloudAt = (hours: Map<number, number>, t: number) => hours.get(Math.round(t / HOUR) * HOUR);
