// node --experimental-strip-types scripts/coverage-check.ts
// A full great circle with a ±1000 km swath covers sin(1000/6371) of the Earth: around the equator, and through the poles.
import { stripCells, coveredShare } from '../src/coverage.ts';
const want = Math.sin(1000 / 6371);
for (const [name, at] of [['equator', (d: number) => [d - 180, 0]], ['meridian', (d: number) => (d < 180 ? [10, d - 90] : [-170, 270 - d])]] as const) {
  const cells: number[] = [];
  for (let d = 0; d < 360; d++) stripCells(at(d), at(d + 1), 1000, cells);
  const got = coveredShare([{ cells, ts: cells.map(() => 0) }], 0, 0);
  console.log(name, got.toFixed(4), 'want', want.toFixed(4));
  if (Math.abs(got - want) > 0.01 * want + 0.002) throw new Error(`${name}: ${got} != ${want}`);
}
