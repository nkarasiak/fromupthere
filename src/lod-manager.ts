// Level of Detail (LOD) Manager for aggressive performance optimization
import { LngLat } from 'maplibre-gl';

export interface ViewportInfo {
  zoom: number;
  bounds: {
    getWest(): number;
    getEast(): number;
    getSouth(): number;
    getNorth(): number;
    getCenter(): { lng: number; lat: number };
  };
}

export interface SatelliteForLOD {
  id: string;
  position: LngLat;
  type: string;
  dimensions: { width: number };
  isFollowed: boolean;
  hasImage: boolean;
}

export class LODManager {
  private frustumCullingEnabled = true;
  private distanceCullingEnabled = true;

  // Aggressive LOD levels based on zoom
  private getLODLevel(zoom: number): 'ultra-low' | 'low' | 'medium' | 'high' | 'ultra-high' {
    if (zoom <= 1) return 'ultra-low';
    if (zoom <= 2) return 'low'; 
    if (zoom <= 4) return 'medium';
    if (zoom <= 6) return 'high';
    return 'ultra-high';
  }

  // Get skip factor for satellite rendering
  getSkipFactor(zoom: number, performanceSkip: number = 1): number {
    const lodLevel = this.getLODLevel(zoom);
    
    const baseLODSkips = {
      'ultra-low': 100,  // Show 1 in 100 satellites
      'low': 50,         // Show 1 in 50 satellites  
      'medium': 20,      // Show 1 in 20 satellites
      'high': 5,         // Show 1 in 5 satellites
      'ultra-high': 1    // Show all satellites
    };

    return baseLODSkips[lodLevel] * performanceSkip;
  }

  // Filter satellites based on LOD and viewport
  filterSatellitesForLOD(
    satellites: SatelliteForLOD[], 
    viewport: ViewportInfo,
    performanceSkip: number = 1,
    maxSatellites: number = 1000
  ): SatelliteForLOD[] {
    const { zoom, bounds } = viewport;
    const skipFactor = this.getSkipFactor(zoom, performanceSkip);
    
    // Priority filtering: Always show followed satellite and ISS
    const prioritySatellites = satellites.filter(sat => 
      sat.isFollowed || sat.id === 'iss-zarya'
    );

    // Get regular satellites (excluding priority ones)
    const regularSatellites = satellites.filter(sat => 
      !sat.isFollowed && sat.id !== 'iss-zarya'
    );

    // Apply viewport culling first (most expensive filter)
    const culledSatellites = this.frustumCullingEnabled ? 
      this.applyCulling(regularSatellites, bounds, zoom) : regularSatellites;

    // Apply LOD skip pattern
    const lods = this.applyLODSkip(culledSatellites, skipFactor);

    // Distance-based culling for very low zoom
    const distanceCulled = zoom <= 2 && this.distanceCullingEnabled ? 
      this.applyDistanceCulling(lods, bounds.getCenter(), zoom) : lods;

    // Combine priority + LOD satellites
    const result = [...prioritySatellites, ...distanceCulled];

    // Final cap on satellite count
    const finalResult = result.slice(0, maxSatellites);

    // LOD processing complete
    
    return finalResult;
  }

  private applyCulling(satellites: SatelliteForLOD[], bounds: any, zoom: number): SatelliteForLOD[] {
    // Expand bounds based on zoom for smoother transitions
    const margin = this.getCullingMargin(zoom);
    
    const expandedBounds = {
      west: bounds.getWest() - margin,
      east: bounds.getEast() + margin,
      south: bounds.getSouth() - margin/2,
      north: bounds.getNorth() + margin/2
    };

    return satellites.filter(sat => {
      const { lng, lat } = sat.position;
      return lng >= expandedBounds.west && 
             lng <= expandedBounds.east && 
             lat >= expandedBounds.south && 
             lat <= expandedBounds.north;
    });
  }

  private getCullingMargin(zoom: number): number {
    // Larger margins at lower zoom for smoother satellite appearance
    if (zoom <= 1) return 120; // Very wide margin
    if (zoom <= 2) return 80;  // Wide margin  
    if (zoom <= 3) return 50;  // Medium margin
    if (zoom <= 4) return 30;  // Small margin
    return 15; // Tight margin for high zoom
  }

  private applyLODSkip(satellites: SatelliteForLOD[], skipFactor: number): SatelliteForLOD[] {
    if (skipFactor <= 1) return satellites;

    // Use deterministic sampling based on satellite ID for consistent results
    return satellites.filter((sat) => {
      // Hash the satellite ID for consistent pseudo-random distribution
      const hash = this.hashString(sat.id);
      return hash % skipFactor === 0;
    });
  }

  private applyDistanceCulling(satellites: SatelliteForLOD[], center: { lng: number; lat: number }, zoom: number): SatelliteForLOD[] {
    if (zoom > 2) return satellites;

    // At very low zoom, only show satellites near center of view
    const maxDistance = zoom <= 1 ? 60 : 40; // degrees

    return satellites.filter(sat => {
      const distance = this.calculateDistance(center, sat.position);
      return distance <= maxDistance;
    });
  }

  private calculateDistance(point1: { lng: number; lat: number }, point2: LngLat): number {
    // Simple Euclidean distance for performance (good enough for culling)
    const dLng = point1.lng - point2.lng;
    const dLat = point1.lat - point2.lat;
    return Math.sqrt(dLng * dLng + dLat * dLat);
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  // Icon-specific LOD filtering
  shouldShowIcon(satellite: SatelliteForLOD, zoom: number): boolean {
    const lodLevel = this.getLODLevel(zoom);
    
    // ISS always gets icon at zoom 2+
    if (satellite.id === 'iss-zarya') {
      return zoom >= 2;
    }

    // Followed satellite always gets icon at zoom 3+
    if (satellite.isFollowed) {
      return zoom >= 3;
    }

    // All other satellites (now all have icons - either images or dots) based on LOD level
    switch (lodLevel) {
      case 'ultra-low':
      case 'low': return false;
      case 'medium': return zoom >= 3; // Show at zoom 3+
      case 'high': return zoom >= 3;   // Show at zoom 3+
      case 'ultra-high': return true;  // Always show
    }

    return false;
  }

  // Get circle size for satellites (much smaller than icons)
  getCircleSize(satellite: SatelliteForLOD, zoom: number, baseSize: number): number {
    const lodLevel = this.getLODLevel(zoom);
    
    // Very small circle sizes based on LOD level
    const sizeMultipliers = {
      'ultra-low': 0.1,   // Tiny dots
      'low': 0.2,         // Small dots
      'medium': 0.4,      // Medium dots
      'high': 0.6,        // Visible dots
      'ultra-high': 1.0   // Full size dots
    };

    const multiplier = sizeMultipliers[lodLevel];
    
    // Special handling for ISS and followed satellites - slightly bigger but still small
    if (satellite.id === 'iss-zarya' || satellite.isFollowed) {
      return Math.max(baseSize * multiplier * 2, 3); // Max 6 pixels for followed
    }

    return Math.max(baseSize * multiplier, 1); // Minimum 1 pixel dot
  }

}