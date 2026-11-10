// Ultra-smooth satellite tracking system for zero-lag video-like performance
import * as satellite from 'satellite.js';

export interface PredictivePosition {
  longitude: number;
  latitude: number;
  altitude: number;
  velocity: number;
  timestamp: number;
  confidence: number; // 0-1, how accurate this prediction is
  bearing?: number; // Optional bearing from satellite's movement direction (0-360°)
}

export interface TrackingState {
  satelliteId: string;
  tle1: string;
  tle2: string;
  lastKnownPosition: PredictivePosition;
  velocityVector: {
    longitudePerMs: number;
    latitudePerMs: number;
    altitudePerMs: number;
  };
  orbitPeriod: number; // in milliseconds
  nextOrbitTime: number;
}

export class SmoothTracker {
  private trackingState: TrackingState | null = null;
  private animationFrame: number | null = null;
  private onPositionUpdate: ((position: PredictivePosition) => void) | null = null;
  private highFrequencyTimer: number | null = null;
  
  // Ultra-high frequency prediction cache
  private predictionCache = new Map<number, PredictivePosition>();
  private readonly CACHE_SIZE = 500; // Store 500 predictions (~16 seconds at 30fps)
  private readonly UPDATE_FREQUENCY = 33; // 30fps - update every 33ms for smooth tracking
  private readonly PREDICTION_HORIZON = 5000; // Predict 5 seconds ahead

  constructor(onPositionUpdate?: (position: PredictivePosition) => void) {
    this.onPositionUpdate = onPositionUpdate || null;
  }

  // Start tracking a satellite with ultra-smooth prediction
  startTracking(satelliteId: string, tle1: string, tle2: string): void {
    
    // Stop any existing tracking
    this.stopTracking();
    
    // Calculate initial state
    const now = Date.now();
    const position = this.calculateExactPosition(tle1, tle2, now);
    
    // Calculate orbital period for prediction accuracy
    const satrec = satellite.twoline2satrec(tle1, tle2);
    const orbitPeriod = this.calculateOrbitPeriod(satrec);
    
    // Calculate velocity vector by comparing positions 100ms apart
    const futurePosition = this.calculateExactPosition(tle1, tle2, now + 100);
    const velocityVector = {
      longitudePerMs: (futurePosition.longitude - position.longitude) / 100,
      latitudePerMs: (futurePosition.latitude - position.latitude) / 100,
      altitudePerMs: (futurePosition.altitude - position.altitude) / 100
    };

    this.trackingState = {
      satelliteId,
      tle1,
      tle2,
      lastKnownPosition: position,
      velocityVector,
      orbitPeriod,
      nextOrbitTime: now + orbitPeriod
    };

    // Pre-populate prediction cache
    this.populatePredictionCache();
    
    // Start ultra-high frequency updates
    this.startHighFrequencyUpdates();
    
  }

  // Stop tracking and clean up
  stopTracking(): void {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    
    if (this.highFrequencyTimer) {
      clearInterval(this.highFrequencyTimer);
      this.highFrequencyTimer = null;
    }
    
    this.trackingState = null;
    this.predictionCache.clear();
  }

  // Get predicted position at any timestamp (for 60fps smooth tracking)
  getPredictedPosition(timestamp?: number): PredictivePosition | null {
    if (!this.trackingState) return null;
    
    const now = timestamp || Date.now();
    
    // Check cache first for ultra-fast lookup
    const cachedPosition = this.predictionCache.get(Math.floor(now / this.UPDATE_FREQUENCY) * this.UPDATE_FREQUENCY);
    if (cachedPosition && Math.abs(cachedPosition.timestamp - now) < this.UPDATE_FREQUENCY) {
      return cachedPosition;
    }
    
    // Calculate real-time if not in cache
    return this.calculatePredictedPosition(now);
  }

  // Calculate exact position using TLE at specific timestamp
  private calculateExactPosition(tle1: string, tle2: string, timestamp: number): PredictivePosition {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    const date = new Date(timestamp);
    const positionAndVelocity = satellite.propagate(satrec, date);
    
    if (positionAndVelocity.position && typeof positionAndVelocity.position !== 'boolean') {
      const positionEci = positionAndVelocity.position;
      const velocityEci = positionAndVelocity.velocity;
      
      // Convert to geodetic coordinates
      const gmst = satellite.gstime(date);
      const positionGd = satellite.eciToGeodetic(positionEci, gmst);
      
      // Calculate velocity magnitude and bearing
      let velocity = 0;
      let bearing = 0;
      if (velocityEci && typeof velocityEci !== 'boolean') {
        velocity = Math.sqrt(velocityEci.x * velocityEci.x + velocityEci.y * velocityEci.y + velocityEci.z * velocityEci.z);
        
        // Calculate bearing from velocity vector
        // Transform velocity from ECI to ECEF (Earth-fixed) coordinates
        const cosGmst = Math.cos(gmst);
        const sinGmst = Math.sin(gmst);
        
        const vx_ecef = velocityEci.x * cosGmst + velocityEci.y * sinGmst;
        const vy_ecef = -velocityEci.x * sinGmst + velocityEci.y * cosGmst;
        const vz_ecef = velocityEci.z;
        
        // Convert position to ECEF for local coordinate transformation
        const lat_rad = positionGd.latitude;
        const lon_rad = positionGd.longitude;
        
        // Transform velocity to local tangent plane (East, North, Up)
        const cosLat = Math.cos(lat_rad);
        const sinLat = Math.sin(lat_rad);
        const cosLon = Math.cos(lon_rad);
        const sinLon = Math.sin(lon_rad);
        
        // East-North-Up transformation
        const v_east = -sinLon * vx_ecef + cosLon * vy_ecef;
        const v_north = -sinLat * cosLon * vx_ecef - sinLat * sinLon * vy_ecef + cosLat * vz_ecef;
        
        // Calculate bearing (0° = North, 90° = East)
        bearing = Math.atan2(v_east, v_north) * 180 / Math.PI;
        
        // Normalize bearing to 0-360 degrees
        if (bearing < 0) bearing += 360;
      }
      
      return {
        longitude: satellite.degreesLong(positionGd.longitude),
        latitude: satellite.degreesLat(positionGd.latitude),
        altitude: positionGd.height,
        velocity,
        timestamp,
        confidence: 1.0, // Exact calculation
        bearing
      };
    }
    
    // Fallback
    return {
      longitude: 0,
      latitude: 0,
      altitude: 400,
      velocity: 7.66,
      timestamp,
      confidence: 0.0,
      bearing: 0
    };
  }

  // Calculate predicted position using velocity vector interpolation
  private calculatePredictedPosition(timestamp: number): PredictivePosition {
    if (!this.trackingState) {
      return {
        longitude: 0, latitude: 0, altitude: 400, velocity: 7.66, timestamp, confidence: 0.0, bearing: 0
      };
    }

    const { lastKnownPosition, velocityVector } = this.trackingState;
    const deltaTime = timestamp - lastKnownPosition.timestamp;
    
    // Linear interpolation for ultra-smooth movement
    let predictedLongitude = lastKnownPosition.longitude + (velocityVector.longitudePerMs * deltaTime);
    let predictedLatitude = lastKnownPosition.latitude + (velocityVector.latitudePerMs * deltaTime);
    const predictedAltitude = lastKnownPosition.altitude + (velocityVector.altitudePerMs * deltaTime);
    
    // Handle longitude wrapping
    while (predictedLongitude > 180) predictedLongitude -= 360;
    while (predictedLongitude < -180) predictedLongitude += 360;
    
    // Clamp latitude
    predictedLatitude = Math.max(-90, Math.min(90, predictedLatitude));
    
    // Confidence decreases over time since last exact calculation
    const confidence = Math.max(0, 1 - (deltaTime / this.PREDICTION_HORIZON));
    
    return {
      longitude: predictedLongitude,
      latitude: predictedLatitude,
      altitude: predictedAltitude,
      velocity: lastKnownPosition.velocity,
      timestamp,
      confidence,
      bearing: lastKnownPosition.bearing // Keep the last known bearing
    };
  }

  // Populate prediction cache for smooth interpolation
  private populatePredictionCache(): void {
    if (!this.trackingState) return;
    
    const now = Date.now();
    this.predictionCache.clear();
    
    // Pre-calculate positions for next few seconds at 60fps intervals
    for (let i = 0; i < this.CACHE_SIZE; i++) {
      const futureTime = now + (i * this.UPDATE_FREQUENCY);
      const position = this.calculatePredictedPosition(futureTime);
      
      // Store with timestamp rounded to update frequency for easy lookup
      const cacheKey = Math.floor(futureTime / this.UPDATE_FREQUENCY) * this.UPDATE_FREQUENCY;
      this.predictionCache.set(cacheKey, position);
    }
    
  }

  // Start high-frequency position updates
  private startHighFrequencyUpdates(): void {
    if (!this.trackingState) return;
    
    // Update every 8ms (120fps) for ultra-smooth tracking
    this.highFrequencyTimer = window.setInterval(() => {
      if (!this.trackingState) return;
      
      const now = Date.now();
      const position = this.getPredictedPosition(now);
      
      if (position && this.onPositionUpdate) {
        this.onPositionUpdate(position);
      }
      
      // Refresh cache and recalculate exact position every 15 seconds
      if (now - this.trackingState.lastKnownPosition.timestamp > 15000) {
        this.refreshTrackingData();
      }
      
    }, this.UPDATE_FREQUENCY);
    
  }

  // Refresh tracking data with new exact calculation
  private refreshTrackingData(): void {
    if (!this.trackingState) return;
    
    const now = Date.now();
    const exactPosition = this.calculateExactPosition(
      this.trackingState.tle1, 
      this.trackingState.tle2, 
      now
    );
    
    // Update velocity vector based on new exact position
    const deltaTime = now - this.trackingState.lastKnownPosition.timestamp;
    if (deltaTime > 0) {
      this.trackingState.velocityVector = {
        longitudePerMs: (exactPosition.longitude - this.trackingState.lastKnownPosition.longitude) / deltaTime,
        latitudePerMs: (exactPosition.latitude - this.trackingState.lastKnownPosition.latitude) / deltaTime,
        altitudePerMs: (exactPosition.altitude - this.trackingState.lastKnownPosition.altitude) / deltaTime
      };
    }
    
    this.trackingState.lastKnownPosition = exactPosition;
    
    // Refresh prediction cache with new data
    this.populatePredictionCache();
    
  }

  // Calculate orbital period in milliseconds
  private calculateOrbitPeriod(satrec: satellite.SatRec): number {
    // Mean motion is in revolutions per day
    const meanMotion = satrec.no; // rad/min
    const minutesPerOrbit = (2 * Math.PI) / meanMotion;
    return minutesPerOrbit * 60 * 1000; // Convert to milliseconds
  }

  // Get current tracking state
  getTrackingState(): TrackingState | null {
    return this.trackingState;
  }

  // Check if currently tracking
  isTracking(): boolean {
    return this.trackingState !== null;
  }

  // Get tracking quality/confidence
  getTrackingQuality(): number {
    if (!this.trackingState) return 0;
    
    const now = Date.now();
    const timeSinceUpdate = now - this.trackingState.lastKnownPosition.timestamp;
    return Math.max(0, 1 - (timeSinceUpdate / this.PREDICTION_HORIZON));
  }
}