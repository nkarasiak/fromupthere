// Share of the Earth's surface under a constellation's swaths. A 0.5° lng/lat grid: a cell counts when its centre lies
// in a swath (unbiased, also for swaths narrower than a cell), weighted by its area (cos lat).
const RES = 0.5, COLS = 360 / RES, ROWS = 180 / RES, rad = Math.PI / 180;
const rowCos = new Float64Array(ROWS), rowSin = new Float64Array(ROWS), colCos = new Float64Array(COLS), colSin = new Float64Array(COLS);
for (let i = 0; i < ROWS; i++) { rowCos[i] = Math.cos((-90 + (i + 0.5) * RES) * rad); rowSin[i] = Math.sin((-90 + (i + 0.5) * RES) * rad); }
for (let j = 0; j < COLS; j++) { colCos[j] = Math.cos((-180 + (j + 0.5) * RES) * rad); colSin[j] = Math.sin((-180 + (j + 0.5) * RES) * rad); }
const TOTAL = rowCos.reduce((a, w) => a + w, 0) * COLS;
const seen = new Uint8Array(ROWS * COLS);

const unit = (p: number[]) => [Math.cos(p[1] * rad) * Math.cos(p[0] * rad), Math.cos(p[1] * rad) * Math.sin(p[0] * rad), Math.sin(p[1] * rad)];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Grid cells whose centre is within halfKm of the ground track from a to b ([lng, lat]), pushed to out. */
export function stripCells(a: number[], b: number[], halfKm: number, out: number[]) {
  const A = unit(a), B = unit(b), c = cross(A, B), m = Math.hypot(...c);
  if (m < 1e-12) return;
  const n = c.map(x => x / m), v = cross(n, A); // n: the track's pole; A, v: its plane
  const L = Math.atan2(B[0] * v[0] + B[1] * v[1] + B[2] * v[2], B[0] * A[0] + B[1] * A[1] + B[2] * A[2]);
  const h = halfKm / 6371, sh = Math.sin(h), hDeg = h / rad;
  const lat0 = Math.max(-90, Math.min(a[1], b[1]) - hDeg), lat1 = Math.min(90, Math.max(a[1], b[1]) + hDeg);
  // Longitudes: the segment's, widened by the swath at the latitude nearest the pole (all of them over a pole)
  const dl = ((b[0] - a[0]) % 360 + 540) % 360 - 180;
  const k = sh / Math.cos(Math.max(Math.abs(lat0), Math.abs(lat1)) * rad);
  const half = k >= 1 ? 180 : Math.abs(dl) / 2 + Math.asin(k) / rad + RES;
  const j0 = half >= 180 ? 0 : Math.floor((a[0] + dl / 2 - half + 180) / RES), j1 = half >= 180 ? COLS - 1 : Math.floor((a[0] + dl / 2 + half + 180) / RES);
  for (let i = Math.max(0, Math.floor((lat0 + 90) / RES)); i <= Math.min(ROWS - 1, Math.floor((lat1 + 90) / RES)); i++) {
    for (let jj = j0; jj <= j1; jj++) {
      const j = ((jj % COLS) + COLS) % COLS;
      const C0 = rowCos[i] * colCos[j], C1 = rowCos[i] * colSin[j], C2 = rowSin[i];
      if (Math.abs(C0 * n[0] + C1 * n[1] + C2 * n[2]) > sh) continue; // farther across the track than the swath
      const along = Math.atan2(C0 * v[0] + C1 * v[1] + C2 * v[2], C0 * A[0] + C1 * A[1] + C2 * A[2]);
      if (along >= 0 && along < L) out.push(i * COLS + j);
    }
  }
}

/** Share of the Earth (0..1) in the cells marked at a time in [t0, t1]. */
export function coveredShare(marks: Array<{ cells: number[]; ts: number[] }>, t0: number, t1: number): number {
  seen.fill(0);
  let area = 0;
  for (const { cells, ts } of marks) {
    for (let k = 0; k < cells.length; k++) {
      if (ts[k] < t0 || ts[k] > t1 || seen[cells[k]]) continue;
      seen[cells[k]] = 1;
      area += rowCos[Math.floor(cells[k] / COLS)];
    }
  }
  return area / TOTAL;
}
