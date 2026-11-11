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
  private readonly MIN_MOVEMENT_THRESHOLD = 0.00001; // Lower threshold for more updates
  private readonly PREDICTION_LEAD_TIME = 100; // Predict 100ms ahead for smoother tracking
  
  // Adaptive smoothing based on satellite speed
  private adaptiveSmoothingEnabled = true;
  private velocityBasedSmoothing = true;
  
  // Time-lapse speed: the same smoothing per simulated second, so the camera doesn't trail a sped-up satellite
  speed = 1;
  // Read the target every frame (pushed targets arrive at ~30 Hz: at x100 the camera then stepped 25 km at a time
  // behind a satellite drawn at the frame's own time, so the satellite shook on screen)
  source?: () => PredictivePosition | null;

  // User bearing control
  private userControlledBearing = false;
  private userBearing = 0;

  constructor(map: MapLibreMap) {
    this.map = map;
    
  }

  // Start smooth tracking of a position
  startSmoothTracking(initialPosition: PredictivePosition): void {
    
    this.targetPosition = initialPosition;
    this.isSmoothing = true;
    
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

    const currentState = this.getCurrentCameraState();
    const targetCenter: [number, number] = [
      this.targetPosition.longitude,
      this.targetPosition.latitude
    ];

    // Calculate distance for movement threshold
    const distance = this.calculateDistance(currentState.center, targetCenter);
    
    
    // Skip update if movement is too small
    if (distance < this.MIN_MOVEMENT_THRESHOLD) {
      return;
    }

    // Calculate adaptive smoothing factor based on satellite velocity
    const base = this.calculateAdaptiveSmoothingFactor();
    const smoothingFactor = 1 - (1 - base) ** this.speed;
    
    // Apply predictive positioning (look ahead for smoother tracking)
    const predictiveTarget = this.calculatePredictiveTarget(targetCenter);
    
    // Smooth interpolation toward target
    const newCenter = this.interpolatePosition(
      currentState.center,
      predictiveTarget,
      smoothingFactor
    );

    // Calculate target bearing - use user bearing if controlled, otherwise satellite direction
    let targetBearing = currentState.bearing; // Default to current bearing
    if (this.userControlledBearing) {
      targetBearing = this.userBearing;
    } else if (this.targetPosition.bearing !== undefined) {
      targetBearing = this.targetPosition.bearing;
    }

    // Smooth bearing interpolation to avoid sudden jumps
    const newBearing = this.interpolateBearing(currentState.bearing, targetBearing, 1 - (1 - base * 0.5) ** this.speed);

    // Apply the smooth movement
    // MapLibre's globe grows by 1/cos(lat) at a fixed zoom: shift the zoom with the latitude so the globe keeps its
    // size on screen (near a pole it would otherwise zoom in ~5x and the satellite would leave the screen)
    const zoom = currentState.zoom + globeZoomShift(newCenter[1]) - globeZoomShift(currentState.center[1]);
    this.map.jumpTo({
      center: newCenter,
      zoom,
      pitch: currentState.pitch,
      bearing: newBearing // Use automatic bearing based on satellite direction
    });
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

  // Calculate distance between two geographic points
  private calculateDistance(pos1: [number, number], pos2: [number, number]): number {
    const deltaLng = Math.abs(pos2[0] - pos1[0]);
    const deltaLat = Math.abs(pos2[1] - pos1[1]);
    
    // Handle longitude wrapping
    const wrappedDeltaLng = Math.min(deltaLng, 360 - deltaLng);
    
    return Math.sqrt(wrappedDeltaLng * wrappedDeltaLng + deltaLat * deltaLat);
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
    if (controlled && bearing !== undefined) {
      this.userBearing = bearing;
    }
  }

  updateUserBearing(bearing: number): void {
    if (this.userControlledBearing) {
      this.userBearing = bearing;
    }
  }

  isUserControlledBearing(): boolean {
    return this.userControlledBearing;
  }

}

// Zoom offset at latitude `lat` that keeps MapLibre's globe the size it has on screen at the equator
export const globeZoomShift = (lat: number) => Math.log2(Math.max(0.05, Math.cos(lat * Math.PI / 180)));
