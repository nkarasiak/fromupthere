// Ultra-smooth camera controller for video-like satellite tracking
// Features:
// - Automatic bearing based on satellite direction
// - User-controllable bearing override (drag horizontally when tracking)
// - Smooth interpolation between camera states
import { Map as MapLibreMap } from 'maplibre-gl';
import { PredictivePosition } from './smooth-tracker';

export interface CameraState {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
  timestamp: number;
}

export interface CameraTarget {
  center: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
}

export class SmoothCamera {
  private map: MapLibreMap;
  private animationFrame: number | null = null;
  private isSmoothing = false;
  private targetPosition: PredictivePosition | null = null;
  
  // Smoothing parameters for video-like tracking
  private readonly SMOOTHING_FACTOR = 0.08; // Lower = smoother (was 0.15)
  private readonly PREDICTION_LEAD_TIME = 100; // Predict 100ms ahead for smoother tracking
  
  // Adaptive smoothing based on satellite speed
  private adaptiveSmoothingEnabled = true;
  private velocityBasedSmoothing = true;
  
  // Time-lapse speed: the same smoothing per simulated second, so the camera doesn't trail a sped-up satellite
  speed = 1;
  // Read the target every frame (pushed targets arrive at ~30 Hz: at x100 the camera then stepped 25 km at a time
  // behind a satellite drawn at the frame's own time, so the satellite shook on screen)
  source?: () => PredictivePosition | null;
  // Equator-equivalent zoom as if the camera orbited the satellite (the URL's zoom); the map's own zoom is derived from it
  zoom = 4.7;
  private lastZoom: number | null = null; // map zoom set by the last frame: a change since then is the user zooming
  private zoomTarget = 4.7; // the wheel's zoom, eased toward (MapLibre's own scroll zoom is off: jumpTo stops it each frame)
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomTarget = Math.min(MAX_EYE_ZOOM, this.zoomTarget - e.deltaY * (e.deltaMode === 1 ? 40 : 1) / 450); // MapLibre's rate
  };
  private followed: [number, number] = [0, 0]; // smoothed satellite position
  heading = 0; // smoothed camera bearing at the satellite (the map's bearing is the one at the ground point)
  headingOffset = 0; // automatic bearing: this many deg right of its heading (the satellite's defaultBearing)
  // Point of view, the angle at the satellite between straight down and the line of sight to it: 0 from straight above,
  // 90 level with it, more from below (the URL's pitch)
  pov = 62;
  private lastGood = { pov: 62, zoom: 4.7 }; // the last view that kept the satellite on screen

  // User bearing control
  private userControlledBearing = false;
  private userBearing = 0;
  // The track's heading when that bearing was set: a manual bearing turns with the track, so it stays the same angle to
  // the satellite. A fixed compass bearing swung the camera right round it near a pole, where the heading reverses.
  private userTrack: number | null = null;
  // A selected satellite on show, like a game's chase camera: once the fly-in ends the view drifts on its own, slow
  // out-of-step swings of bearing, pitch and distance (SHOW) about where tracking began. Never all the way round: its
  // picture is flat, from behind it would face the wrong way. Any click, wheel or key stops it where it is.
  private showPending = false;
  private show: { t0: number; pov: number; zoom: number } | null = null;

  constructor(map: MapLibreMap) {
    for (const e of ['pointerdown', 'wheel', 'keydown']) addEventListener(e, () => {
      if (this.show) this.setUserControlledBearing(true, this.heading);
      this.show = null;
      this.showPending = false;
    }, { capture: true });
    this.map = map;
    
  }

  // Start smooth tracking of a position
  startSmoothTracking(initialPosition: PredictivePosition): void {
    if (this.showPending) this.show = { t0: performance.now(), pov: this.pov, zoom: this.zoom }; // from where the fly-in ends
    this.showPending = false;
    
    this.targetPosition = initialPosition;
    this.isSmoothing = true;
    this.followed = [initialPosition.longitude, initialPosition.latitude];
    this.heading = this.userControlledBearing ? this.userBearing
      : initialPosition.bearing !== undefined ? initialPosition.bearing + this.headingOffset : this.map.getBearing(); // as the fly-in ended
    this.lastZoom = this.map.getZoom();
    this.lastGood = { pov: this.pov, zoom: this.zoom };
    this.zoomTarget = this.zoom;
    this.map.scrollZoom.disable();
    this.map.getCanvasContainer().addEventListener('wheel', this.onWheel, { passive: false });
    
    // Start the smooth animation loop
    this.startSmoothLoop();
  }

  // Update target position (called 60fps by SmoothTracker)
  updateTargetPosition(position: PredictivePosition): void {
    this.targetPosition = position;
  }

  // Stop smooth tracking
  stopSmoothTracking(): void {
    
    this.isSmoothing = false;
    this.targetPosition = null;
    this.lastZoom = null;
    this.map.scrollZoom.enable();
    this.map.getCanvasContainer().removeEventListener('wheel', this.onWheel);
    
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  // Start the smooth animation loop (60fps)
  private startSmoothLoop(): void {
    const smoothUpdate = () => {
      if (!this.isSmoothing || !this.targetPosition) {
        return;
      }

      const p = this.source?.();
      if (p) this.targetPosition = p;
      this.applySmoothMovement();
      
      // Continue the loop
      this.animationFrame = requestAnimationFrame(smoothUpdate);
    };

    // Start the loop
    this.animationFrame = requestAnimationFrame(smoothUpdate);
  }

  // Apply smooth camera movement toward target
  private applySmoothMovement(): void {
    if (!this.targetPosition) return;

    // On show: each swing eases in over the first seconds (r), then runs at its own period
    const t = this.show ? (performance.now() - this.show.t0) / 1000 : 0, r = Math.min(1, t / 6);
    const swing = ([amp, period]: number[]) => r * amp * Math.sin(2 * Math.PI * t / period);
    if (this.show) {
      this.pov = this.show.pov + swing(SHOW.pov);
      this.zoomTarget = this.show.zoom + swing(SHOW.zoom);
    }

    const currentState = this.getCurrentCameraState();
    const targetCenter: [number, number] = [
      this.targetPosition.longitude,
      this.targetPosition.latitude
    ];
    if (this.lastZoom !== null) this.zoomTarget += currentState.zoom - this.lastZoom; // other zooms (keys, double click)
    this.zoom += (Math.min(MAX_EYE_ZOOM, this.zoomTarget) - this.zoom) * 0.3;

    // Calculate adaptive smoothing factor based on satellite velocity
    const base = this.calculateAdaptiveSmoothingFactor();
    const smoothingFactor = 1 - (1 - base) ** this.speed;
    
    // Apply predictive positioning (look ahead for smoother tracking)
    const predictiveTarget = this.calculatePredictiveTarget(targetCenter);
    
    // Smooth interpolation toward target
    this.followed = this.interpolatePosition(this.followed, predictiveTarget, smoothingFactor);

    // Calculate target bearing - use user bearing if controlled, otherwise satellite direction
    let targetBearing = this.heading;
    if (this.userControlledBearing) {
      const track = this.targetPosition.bearing;
      if (track !== undefined && this.userTrack === null) this.userTrack = track; // set before tracking began (a link's bearing)
      targetBearing = this.userBearing + (track !== undefined ? track - this.userTrack! : 0);
    } else if (this.targetPosition.bearing !== undefined) {
      targetBearing = this.targetPosition.bearing + this.headingOffset + (this.show ? swing(SHOW.bearing) : 0);
    }

    // Smooth bearing interpolation to avoid sudden jumps; a manual bearing applies at once (the hand is smooth already,
    // and turn() adds to `heading`: smoothed, it lagged and most of a drag was lost)
    const newBearing = this.heading = this.userControlledBearing ? targetBearing
      : this.interpolateBearing(this.heading, targetBearing, 1 - (1 - base * 0.5) ** this.speed);

    const frame = (pov = this.pov, maxPitch = MAX_PITCH) => framing(this.followed, this.targetPosition!.altitude, newBearing, pov, this.zoom, this.map.transform.height, maxPitch);
    let view = frame();
    if (!(view.off <= MAX_OFF_AXIS)) { // satellite off the top of the screen, or camera underground: refuse that move
      ({ pov: this.pov, zoom: this.zoom } = this.lastGood);
      this.zoomTarget = this.zoom;
      view = frame();
    }
    this.lastGood = { pov: this.pov, zoom: this.zoom };
    // MapLibre's globe won't centre beyond 85 deg: it clamps the ground point the camera orbits, which moves the camera
    // elsewhere, turned round. Near a pole, look more steeply down (that point nearer the satellite) until it's within
    // reach; the chosen pov comes back past the pole. ponytail: an orbit whose nadir passes 85 deg still clamps
    // Same camera, aimed lower (a nearer ground point, the satellite higher on screen) until that point is within reach:
    // the largest such tilt, by bisection. Lowering the pov instead moved the camera, and it jumped as the clamp came and went
    if (Math.abs(view.camera.center[1]) > MAX_CENTER_LAT) {
      let lo = 0, hi = view.camera.pitch;
      view = frame(this.pov, lo);
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2, v = frame(this.pov, mid);
        if (Math.abs(v.camera.center[1]) > MAX_CENTER_LAT) hi = mid; else { lo = mid; view = v; }
      }
    }
    this.map.jumpTo(view.camera);
    this.lastZoom = this.map.getZoom();
  }

  // Calculate adaptive smoothing factor based on satellite velocity
  private calculateAdaptiveSmoothingFactor(): number {
    if (!this.adaptiveSmoothingEnabled || !this.targetPosition) {
      return this.SMOOTHING_FACTOR;
    }

    // Higher velocity = more responsive tracking
    const velocity = this.targetPosition.velocity;
    const velocityFactor = Math.min(velocity / 8, 1); // Normalize to satellite speeds (0-8 km/s)
    
    // Increase responsiveness for faster satellites
    const adaptiveFactor = this.SMOOTHING_FACTOR + (velocityFactor * 0.1);
    
    return Math.min(adaptiveFactor, 0.3); // Cap at 30% for stability
  }

  // Calculate predictive target position for lead compensation
  private calculatePredictiveTarget(currentTarget: [number, number]): [number, number] {
    if (!this.targetPosition || !this.velocityBasedSmoothing) {
      return currentTarget;
    }

    // Simple velocity-based prediction
    const leadTime = this.PREDICTION_LEAD_TIME / 1000; // Convert to seconds
    const velocity = this.targetPosition.velocity;
    
    // Estimate movement based on current velocity (simplified)
    const kmPerDegLat = 111; // Approximate km per degree latitude
    const kmPerDegLng = 111 * Math.cos(this.targetPosition.latitude * Math.PI / 180);
    
    // Very basic prediction - in real implementation, use orbital mechanics
    const deltaLat = (velocity * leadTime / kmPerDegLat) * 0.1; // Conservative prediction
    const deltaLng = (velocity * leadTime / kmPerDegLng) * 0.1;
    
    return [
      currentTarget[0] + deltaLng,
      currentTarget[1] + deltaLat
    ];
  }

  // Smooth interpolation between positions
  private interpolatePosition(
    current: [number, number],
    target: [number, number],
    factor: number
  ): [number, number] {
    
    // Handle longitude wrapping (crossing 180° meridian)
    let targetLng = target[0];
    const currentLng = current[0];
    
    if (Math.abs(targetLng - currentLng) > 180) {
      if (currentLng > targetLng) {
        targetLng += 360;
      } else {
        targetLng -= 360;
      }
    }

    // Linear interpolation with smoothing
    let newLng = currentLng + (targetLng - currentLng) * factor;
    const newLat = current[1] + (target[1] - current[1]) * factor;

    // Normalize longitude
    while (newLng > 180) newLng -= 360;
    while (newLng < -180) newLng += 360;

    return [newLng, newLat];
  }

  // Smooth interpolation between bearings (handles 0°/360° wrapping)
  private interpolateBearing(
    currentBearing: number,
    targetBearing: number,
    factor: number
  ): number {
    // Normalize bearings to 0-360 range
    currentBearing = ((currentBearing % 360) + 360) % 360;
    targetBearing = ((targetBearing % 360) + 360) % 360;
    
    // Calculate the shortest angular distance
    let diff = targetBearing - currentBearing;
    
    // Handle wrapping (take shortest path around the circle)
    if (Math.abs(diff) > 180) {
      if (diff > 0) {
        diff -= 360;
      } else {
        diff += 360;
      }
    }
    
    // Apply smooth interpolation
    let newBearing = currentBearing + (diff * factor);
    
    // Normalize result to 0-360 range
    newBearing = ((newBearing % 360) + 360) % 360;
    
    return newBearing;
  }

  // Get current camera state
  private getCurrentCameraState(): CameraState {
    return {
      center: [this.map.getCenter().lng, this.map.getCenter().lat],
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
      timestamp: Date.now()
    };
  }

  // Get current tracking status
  isTracking(): boolean {
    return this.isSmoothing && this.targetPosition !== null;
  }

  // User bearing control methods
  setUserControlledBearing(controlled: boolean, bearing?: number): void {
    this.userControlledBearing = controlled;
    if (controlled && bearing !== undefined) this.updateUserBearing(bearing);
  }

  updateUserBearing(bearing: number): void {
    if (!this.userControlledBearing) return;
    this.userBearing = bearing;
    this.userTrack = this.targetPosition?.bearing ?? null;
  }

  onShow(): boolean {
    return this.show !== null;
  }

  // Put the satellite about to be tracked on show (from the end of its fly-in)
  startShow(): void {
    this.showPending = true;
    this.show = null;
  }

  isUserControlledBearing(): boolean {
    return this.userControlledBearing;
  }

}

// The show's swings: [amplitude, period in s], periods out of step so the motion doesn't visibly repeat
// A little move only, never turning round the satellite
const SHOW = { bearing: [4, 50], pov: [3, 37], zoom: [0.15, 29] }; // deg, deg (up and down), zoom (closer and farther)
const MAX_CENTER_LAT = 85; // MapLibre's globe clamps its centre at 85.05 deg
const MAX_EYE_ZOOM = 14; // ~7 km from the satellite

const MAX_PITCH = 85; // MapLibre's camera tilt, at the ground point it orbits
const SHIFT_FROM_ZOOM = 5.5, SHIFT_FULL_ZOOM = 2.5; // zooming out from this, the picture slides up to centre the globe by this
const SHIFT_MAX_UP = 0.4; // ...the satellite at most this far (screen heights) above the middle
const MAX_OFF_AXIS = Math.atan(0.46); // satellite above the view's axis: the top padding below then stays under 80% of the screen

// MapLibre's camera for a point of view on a satellite: `pov` (see SmoothCamera.pov) and `zoom` place the camera (zoom:
// equator-equivalent, as if it orbited the satellite: 1.5 screen heights away, a globe of radius R spanning
// 512 * 2^zoom / 2 pi px), `bearing` turns it (at the satellite). MapLibre's globe camera orbits a ground point (it
// ignores the centre elevation) at most MAX_PITCH from its vertical. When the line of sight through the satellite lands
// on the ground within that, that's the point and the satellite is at the screen centre. Otherwise (level with it or
// below), the camera looks down to the ground at MAX_PITCH and the satellite shows above the axis (by `off`), kept on
// screen by a top padding that moves the axis down. All in the vertical plane through the satellite along the bearing:
// x ahead, y up at the satellite, km from the Earth's centre.
export function framing(sat: [number, number], altKm: number, bearing: number, pov: number, zoom: number, height: number, maxPitch = MAX_PITCH) {
  const R = 6371, rad = Math.PI / 180, psi = pov * rad;
  const d = 1.5 * height * 2 * Math.PI * R / (512 * 2 ** zoom);
  const L = [Math.sin(psi), -Math.cos(psi)]; // line of sight camera -> satellite
  const P = [-d * L[0], R + altKm - d * L[1]], rP = Math.hypot(P[0], P[1]); // camera
  const hit = (A: number[]) => { // distance along A to the ground, or -1
    const b = P[0] * A[0] + P[1] * A[1], disc = b * b - rP * rP + R * R;
    return disc < 0 ? -1 : -b - Math.sqrt(disc);
  };
  // at the ground point; clamped: looking straight down, rounding gave acos(1.0000001) = NaN and the camera froze
  const tilt = (A: number[], t: number) => Math.acos(Math.min(1, Math.max(-1, -(A[0] * (P[0] + t * A[0]) + A[1] * (P[1] + t * A[1])) / R)));
  const tL = hit(L), hidden = tL > 0 && tL < d; // the Earth is between the camera and the satellite
  let A = L, t = tL;
  if (t <= 0 || hidden || tilt(L, t) > maxPitch * rad) {
    // From the nadir toward the line of sight by a: the ground point seen at MAX_PITCH (law of sines in the triangle
    // Earth centre, camera, ground point)
    const a = Math.asin(R * Math.sin(maxPitch * rad) / rP), n = [-P[0] / rP, -P[1] / rP], ln = L[0] * n[0] + L[1] * n[1];
    const f = [L[0] - ln * n[0], L[1] - ln * n[1]], fl = Math.hypot(f[0], f[1]);
    A = [Math.cos(a) * n[0] + Math.sin(a) * f[0] / fl, Math.cos(a) * n[1] + Math.sin(a) * f[1] / fl];
    t = hit(A);
  }
  const off = rP < R + 1 || hidden ? NaN : Math.acos(Math.min(1, L[0] * A[0] + L[1] * A[1])); // NaN: no view of it
  // The picture's vertical shift (px, + up), by padding (it moves the axis, the camera doesn't turn): a satellite far
  // above the axis comes down to 0.3 of the height; zoomed out, the picture slides up so the globe nears the middle
  // instead of sinking under the satellite, the satellite no higher than SHIFT_MAX_UP. Turning the aim to the Earth's
  // centre instead swept the whole scene round while zooming.
  const f = 1.5 * height, up = f * Math.tan(off); // the satellite above the axis
  const C = [-P[0] / rP, -P[1] / rP], below = f * Math.tan(Math.acos(Math.min(1, A[0] * C[0] + A[1] * C[1]))); // the Earth's centre below it
  const w = Math.max(0, Math.min(1, (SHIFT_FROM_ZOOM - zoom) / (SHIFT_FROM_ZOOM - SHIFT_FULL_ZOOM)));
  const shift = w * Math.min(below, Math.max(0, SHIFT_MAX_UP * height - up)) - Math.max(0, up - 0.3 * height); // evenly over the zooms
  // Ground point: `ang` ahead of the satellite on the great circle along the bearing; the map's bearing is the course there
  const ang = Math.atan2(P[0] + t * A[0], P[1] + t * A[1]), b = bearing * rad, la = sat[1] * rad;
  const lat = Math.asin(Math.sin(la) * Math.cos(ang) + Math.cos(la) * Math.sin(ang) * Math.cos(b));
  const lng = sat[0] * rad + Math.atan2(Math.sin(b) * Math.sin(ang) * Math.cos(la), Math.cos(ang) - Math.sin(la) * Math.sin(lat));
  const course = Math.atan2(Math.sin(b) * Math.cos(la), Math.cos(la) * Math.cos(ang) * Math.cos(b) - Math.sin(la) * Math.sin(ang));
  return {
    camera: {
      center: [(lng / rad + 540) % 360 - 180, lat / rad] as [number, number],
      zoom: Math.log2(1.5 * height * 2 * Math.PI * R * Math.cos(lat) / (512 * t)),
      bearing: course / rad,
      pitch: tilt(A, t) / rad,
      padding: { top: Math.min(0.9 * height, Math.max(0, -2 * shift)), bottom: Math.min(0.9 * height, Math.max(0, 2 * shift)), left: 0, right: 0 }
    },
    off
  };
}

// Zoom offset at latitude `lat` that keeps MapLibre's globe the size it has on screen at the equator
export const globeZoomShift = (lat: number) => Math.log2(Math.max(0.05, Math.cos(lat * Math.PI / 180)));
