// node --experimental-strip-types scripts/next-overhead-check.ts
// The ISS's ground point 40 min from now: the next pass over it must be at +40 min, within a km.
// And no pass over 80°N (its orbit is inclined 51.6°).
import * as satellite from 'satellite.js';
import { nextOverhead } from '../src/next-overhead.ts';
const tle1 = '1 25544U 98067A   25216.88307209  .00003454  00000+0  67688-4 0  9997';
const tle2 = '2 25544  51.6362  65.7123 0001818 143.6625 298.7323 15.50331059522717';
const from = Date.UTC(2025, 7, 5), at = from + 40 * 60e3;
const pv = satellite.propagate(satellite.twoline2satrec(tle1, tle2), new Date(at));
const g = satellite.eciToGeodetic(pv.position as satellite.EciVec3<number>, satellite.gstime(new Date(at)));
const p = nextOverhead([{ id: 'iss', tle1, tle2, halfKm: 10 }], satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude), from);
console.log(p, 'want t', new Date(at).toISOString());
if (!p || Math.abs(p.t - at) > 5e3 || p.distKm > 1) throw new Error('wrong pass');
if (nextOverhead([{ id: 'iss', tle1, tle2, halfKm: 10 }], 80, 0, from)) throw new Error('ISS (51.6 deg) over 80N?');
