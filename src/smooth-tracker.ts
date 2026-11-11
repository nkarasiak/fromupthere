// Position of the tracked satellite for every frame: an exact SGP4 propagation each time (a few microseconds), so the
// position and heading change continuously. (It used to extrapolate linearly and recompute every 15 s, which made the
// heading, and the camera turning with it, jump every 15 s: by several degrees near the poles.)
import * as satellite from 'satellite.js';

export interface PredictivePosition {
  longitude: number;
  latitude: number;
  altitude: number;
  velocity: number;
  timestamp: number;
  confidence: number; // 0-1, how accurate this prediction is
  bearing?: number; // heading of the ground track (0-360°, 0 = north)
}

const UPDATE_MS = 33; // position callbacks at ~30 Hz
const HEADING_DT_MS = 1000; // heading from the ground point now to the one 1 s later

export class SmoothTracker {
  private satrec: satellite.SatRec | null = null;
  private timer: number | null = null;
  private onPositionUpdate: ((position: PredictivePosition) => void) | null;
  clock: () => number = Date.now; // the tracking view's (possibly sped-up) simulated time, ms

  constructor(onPositionUpdate?: (position: PredictivePosition) => void) {
    this.onPositionUpdate = onPositionUpdate || null;
  }

  startTracking(_satelliteId: string, tle1: string, tle2: string): void {
    this.stopTracking();
    this.satrec = satellite.twoline2satrec(tle1, tle2);
    this.timer = window.setInterval(() => {
      const p = this.getPredictedPosition();
      if (p) this.onPositionUpdate?.(p);
    }, UPDATE_MS);
  }

  stopTracking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.satrec = null;
  }

  isTracking(): boolean {
    return this.satrec !== null;
  }

  getPredictedPosition(timestamp?: number): PredictivePosition | null {
    if (!this.satrec) return null;
    const t = timestamp || this.clock();
    const p = this.ground(t), q = this.ground(t + HEADING_DT_MS);
    if (!p || !q) return null;
    const r = Math.PI / 180, dl = (q.lng - p.lng) * r;
    const bearing = Math.atan2(Math.sin(dl) * Math.cos(q.lat * r),
      Math.cos(p.lat * r) * Math.sin(q.lat * r) - Math.sin(p.lat * r) * Math.cos(q.lat * r) * Math.cos(dl)) / r;
    return {
      longitude: p.lng, latitude: p.lat, altitude: p.alt, velocity: p.velocity,
      timestamp: t, confidence: 1, bearing: (bearing + 360) % 360
    };
  }

  private ground(t: number) {
    const date = new Date(t);
    const pv = satellite.propagate(this.satrec!, date);
    if (!pv || typeof pv.position === 'boolean' || !pv.position || typeof pv.velocity === 'boolean' || !pv.velocity) return null;
    const g = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
    const v = pv.velocity;
    return {
      lng: satellite.degreesLong(g.longitude), lat: satellite.degreesLat(g.latitude), alt: g.height,
      velocity: Math.hypot(v.x, v.y, v.z)
    };
  }
}
