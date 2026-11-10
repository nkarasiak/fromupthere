import { LngLat } from 'maplibre-gl';

export interface SatelliteData {
  id: string;
  name: string;
  shortname?: string;
  alternateName?: string;
  type: 'scientific' | 'communication' | 'navigation' | 'earth-observation' | 'weather';
  position: LngLat;
  altitude: number;
  velocity: number;
  tle1: string;
  tle2: string;
  dimensions: {
    length: number; // meters
    width: number;  // meters
    height: number; // meters
  };
  image?: string;
  defaultBearing?: number;
  defaultZoom?: number;
  defaultPitch?: number;
  scaleFactor?: number;
}

export interface SatelliteConfig {
  id: string;
  name?: string;
  shortname?: string;
  alternateName?: string;
  type?: 'scientific' | 'communication' | 'navigation' | 'earth-observation' | 'weather';
  tle1?: string;
  tle2?: string;
  dimensions?: {
    length: number;
    width: number;
    height: number;
  };
  image?: string;
  defaultBearing?: number;
  defaultZoom?: number;
  defaultPitch?: number;
  scaleFactor?: number;
}

export interface SatellitePointData {
  position: [number, number, number];
  id: string;
  name: string;
  type: string;
  altitude: number;
  velocity: number;
  length: number;
  color: [number, number, number, number];
  size: number;
}

export interface OrbitCircleData {
  center: [number, number];
  radius: number; // in meters
  color: [number, number, number, number];
  satelliteId: string;
}

export interface SatellitePosition {
  longitude: number;
  latitude: number;
  altitude: number;
  velocity: number;
}
/** Human-readable name: configs without a `name` fall back to their slug id (e.g. "iss-zarya"). */
export const displayName = (s: Pick<SatelliteData, 'id' | 'name' | 'shortname' | 'alternateName'>): string =>
  s.shortname || s.alternateName || (s.name === s.id ? s.id.toUpperCase() : s.name);
