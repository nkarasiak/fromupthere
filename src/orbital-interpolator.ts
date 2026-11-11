// Orbital interpolation for smooth satellite movement
export interface SatellitePosition {
  longitude: number;
  latitude: number;
  altitude: number;
  velocity: number;
  timestamp: number;
}

export interface InterpolatedPosition {
  longitude: number;
  latitude: number;
  altitude: number;
  velocity: number;
}

export class OrbitalInterpolator {
  private positionHistory: Map<string, SatellitePosition[]> = new Map();
  private readonly MAX_HISTORY = 3; // Keep last 3 positions for prediction

  // Add a new calculated position for a satellite
  addPosition(satelliteId: string, position: SatellitePosition) {
    let history = this.positionHistory.get(satelliteId);
    if (!history) {
      history = [];
      this.positionHistory.set(satelliteId, history);
    }

    history.push(position);
    
    // Keep only recent positions
    if (history.length > this.MAX_HISTORY) {
      history.shift();
    }
  }

  // Get interpolated position at any timestamp
  getInterpolatedPosition(satelliteId: string, targetTimestamp: number): InterpolatedPosition | null {
    const history = this.positionHistory.get(satelliteId);
    if (!history || history.length < 2) {
      // Not enough data for interpolation
      return history?.[0] ? {
        longitude: history[0].longitude,
        latitude: history[0].latitude,
        altitude: history[0].altitude,
        velocity: history[0].velocity
      } : null;
    }

    // Find the two positions to interpolate between
    let beforePos: SatellitePosition | null = null;
    let afterPos: SatellitePosition | null = null;

    for (let i = 0; i < history.length - 1; i++) {
      if (targetTimestamp >= history[i].timestamp && targetTimestamp <= history[i + 1].timestamp) {
        beforePos = history[i];
        afterPos = history[i + 1];
        break;
      }
    }

    // If target is after all known positions, extrapolate from last two
    if (!beforePos && history.length >= 2) {
      beforePos = history[history.length - 2];
      afterPos = history[history.length - 1];
    }

    // If target is before all known positions, use first position
    if (!beforePos) {
      const firstPos = history[0];
      return {
        longitude: firstPos.longitude,
        latitude: firstPos.latitude,
        altitude: firstPos.altitude,
        velocity: firstPos.velocity
      };
    }

    return this.interpolateBetweenPositions(beforePos, afterPos!, targetTimestamp);
  }

  private interpolateBetweenPositions(
    pos1: SatellitePosition, 
    pos2: SatellitePosition, 
    targetTimestamp: number
  ): InterpolatedPosition {
    const timeDelta = pos2.timestamp - pos1.timestamp;
    const progress = timeDelta > 0 ? (targetTimestamp - pos1.timestamp) / timeDelta : 0;

    // Handle longitude wrapping (crossing 180° meridian)
    let lon1 = pos1.longitude;
    let lon2 = pos2.longitude;
    
    // If longitude difference is > 180°, satellite crossed the dateline
    if (Math.abs(lon2 - lon1) > 180) {
      if (lon1 > lon2) {
        lon2 += 360;
      } else {
        lon1 += 360;
      }
    }

    // Linear interpolation with orbital motion consideration
    let interpolatedLon = this.lerp(lon1, lon2, progress);
    
    // Normalize longitude to -180 to 180
    while (interpolatedLon > 180) interpolatedLon -= 360;
    while (interpolatedLon < -180) interpolatedLon += 360;

    const interpolatedLat = this.lerp(pos1.latitude, pos2.latitude, progress);
    const interpolatedAlt = this.lerp(pos1.altitude, pos2.altitude, progress);
    const interpolatedVel = this.lerp(pos1.velocity, pos2.velocity, progress);

    return {
      longitude: interpolatedLon,
      latitude: interpolatedLat,
      altitude: interpolatedAlt,
      velocity: interpolatedVel
    };
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Math.max(0, Math.min(1, t));
  }

  // Get predicted position for smooth extrapolation
  getPredictedPosition(satelliteId: string, futureTimestamp: number): InterpolatedPosition | null {
    const history = this.positionHistory.get(satelliteId);
    if (!history || history.length < 2) return null;

    const lastPos = history[history.length - 1];
    const prevPos = history[history.length - 2];
    
    // Don't extrapolate too far into the future (max 5 seconds)
    const maxExtrapolationTime = 5000; // 5 seconds
    if (futureTimestamp - lastPos.timestamp > maxExtrapolationTime) {
      return {
        longitude: lastPos.longitude,
        latitude: lastPos.latitude,
        altitude: lastPos.altitude,
        velocity: lastPos.velocity
      };
    }

    return this.interpolateBetweenPositions(prevPos, lastPos, futureTimestamp);
  }

  // Clean old data
  cleanup() {
    const now = Date.now();
    const maxAge = 300000; // 5 minutes

    for (const [satelliteId, history] of this.positionHistory) {
      // Remove positions older than maxAge
      const filtered = history.filter(pos => now - pos.timestamp < maxAge);
      
      if (filtered.length === 0) {
        this.positionHistory.delete(satelliteId);
      } else {
        this.positionHistory.set(satelliteId, filtered);
      }
    }
  }

}