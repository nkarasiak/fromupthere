// Next satellite over a place: the first time, from `from`, a satellite's ground track comes within halfKm of it
// (for an imager, its swath half-width: when it images the place). Ground point every 30 s (~200 km along the track);
// each pass's closest approach is bracketed by a local minimum of the distance, then refined to ~1 s.
import * as satellite from 'satellite.js';

export interface OverheadSat { id: string; tle1: string; tle2: string; halfKm: number }
export interface OverheadPass { id: string; t: number; distKm: number } // t: closest approach (ms)

const STEP_MS = 30e3, R = 6371, rad = Math.PI / 180;

export function nextOverhead(sats: OverheadSat[], lat: number, lng: number, from = Date.now(), horizonMs = 24 * 3600e3): OverheadPass | null {
  let best: OverheadPass | null = null;
  for (const s of sats) {
    const rec = satellite.twoline2satrec(s.tle1, s.tle2);
    const d = (t: number) => {
      const pv = satellite.propagate(rec, new Date(t));
      if (!pv || typeof pv.position === 'boolean' || !pv.position) return NaN;
      const g = satellite.eciToGeodetic(pv.position, satellite.gstime(new Date(t)));
      const h = Math.sin((g.latitude - lat * rad) / 2) ** 2 + Math.cos(g.latitude) * Math.cos(lat * rad) * Math.sin((g.longitude - lng * rad) / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
    };
    const end = Math.min(from + horizonMs, best ? best.t : Infinity); // later than the best so far: no need to look
    let t0 = from - STEP_MS, d0 = d(t0), t1 = from, d1 = d(t1);
    while (t1 <= end && !Number.isNaN(d1)) { // NaN: decayed, or a bad TLE
      const t2 = t1 + STEP_MS, d2 = d(t2);
      if (d1 <= d0 && d1 <= d2) {
        let a = t0, b = t2; // golden-section search for the closest approach in [t0, t2]
        while (b - a > 1e3) {
          const m1 = b - (b - a) * 0.618, m2 = a + (b - a) * 0.618;
          if (d(m1) < d(m2)) b = m2; else a = m1;
        }
        const t = Math.max(from, (a + b) / 2), dist = d(t);
        if (dist <= s.halfKm && t <= end) { best = { id: s.id, t, distKm: dist }; break; }
      }
      t0 = t1; d0 = d1; t1 = t2; d1 = d2;
    }
  }
  return best;
}
