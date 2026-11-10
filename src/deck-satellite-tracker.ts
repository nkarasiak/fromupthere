import { Deck } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, IconLayer, ArcLayer, TextLayer, LineLayer } from '@deck.gl/layers';
import { Map as MapLibreMap, LngLat } from 'maplibre-gl';
import * as satellite from 'satellite.js';
import { SATELLITE_CONFIGS_WITH_STARLINK, Constellation } from './config/satellites';
import type { SatelliteConfig } from './types/satellite';
import { displayName } from './types/satellite';
import { TripsLayer } from '@deck.gl/geo-layers';
import { SatelliteDataFetcher } from './satellite-data-fetcher';
import { SolarCalculator } from './utils/solar-calculator';
import { PerformanceManager } from './performance-manager';
import { LODManager, ViewportInfo, SatelliteForLOD } from './lod-manager';
import { OrbitalInterpolator, SatellitePosition } from './orbital-interpolator';
import { SmoothTracker, PredictivePosition } from './smooth-tracker';
import { SmoothCamera } from './smooth-camera';

export interface SatelliteData {
  id: string;
  name: string;
  shortname?: string; // Optional short display name
  alternateName?: string; // Optional alternate name for searching
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
  image?: string; // Optional image URL for satellites with custom icons
  defaultBearing?: number; // Optional default camera bearing when tracking this satellite (0-360 degrees)
  defaultZoom?: number; // Optional default zoom level when tracking this satellite
  defaultPitch?: number; // Optional default pitch angle when tracking this satellite
  scaleFactor?: number; // Optional scale factor for satellite size (default: 2.0)
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

const FLY_DURATION_MS = 3000;
const DEFAULT_ZOOM = 4.7; // default camera when tracking a satellite
const DEFAULT_PITCH = 62;
// Samples per orbit ring. Dense on purpose: near the poles longitude changes fast, and a coarse polyline drawn in lng/lat
// swings out into a visible loop around the pole.
const RING_N = 480;
const VIEW_TILT = 72; // constellation camera: degrees between the orbit axis and the view direction
const TL_SPEEDS = [1, 10, 100];
const TL_DEFAULT_SPEED = 100;
const TRACK_SAMPLE_MS = 10000;      // ground track sampled every 10 simulated seconds (75 km)...
const TRACK_CHUNK_MS = 30 * 60e3;   // ...computed ahead in 30 min chunks; the GPU fades and cuts it at the current time
const TRACK_FADE_MS = 90 * 60e3;     // past swaths fade out over ~1 orbit: older passes have drifted away from the
                                    // orbit with the turning Earth and read as swaths with no satellite over them
// Ground features float this far above the surface: a straight segment between two samples sags below the curved
// globe (and below MapLibre's coarse low-zoom globe mesh), which drew the swath as a dashed sawtooth.
const GROUND_LIFT_M = 8000;
const COVERAGE_MS = 24 * 3600e3;   // "24 h" toggle: keep a full day of swaths, so ground left untinted had no pass that day
// Optical imagers only image the day side: swaths are drawn only where the sun is at least this high at the nadir.
// ponytail: fixed threshold and nadir-only swath; off-nadir pointing (which can fill gaps) isn't modelled.
const MIN_SUN_ELEV_DEG = 10;
const SCAN_MS = 4 * 60e3; // the lit footprint under each satellite covers its last 4 simulated minutes

export class DeckSatelliteTracker {
  private constellation: string[] | null = null; // member ids while viewing a constellation overview
  // The main deck canvas is a flat (Mercator) overlay, which can't sit correctly on the globe at whole-Earth zoom.
  // The constellation is drawn by a MapboxOverlay instead: it renders inside MapLibre's own globe, in metres, at real altitude.
  private constellationOverlay?: MapboxOverlay;
  private constellationColor: [number, number, number] = [0, 214, 255];
  private constellationSwathKm = 0;
  // Constellation time-lapse. The camera is fixed in INERTIAL space (looking along the orbit normal), so the Earth visibly
  // turns under the orbit ring while satellites run round it and paint their ground tracks / swaths onto the surface.
  private tlRaf = 0;
  private tlLast = 0;
  private tlSim = 0;            // simulated time, ms since epoch
  private tlT0 = 0;             // simulated time the orbit rings/tracks were anchored at
  private tlGmst = 0;           // Earth rotation angle (rad) at the previous frame
  private tlGmst0 = 0;          // ... at tlT0
  private tlPlaying = true;
  private tlCoverage = false; // 24 h coverage view (no fade)
  private tlSpeed = TL_DEFAULT_SPEED;
  private tlRings: Array<{ id: string; pts: number[][]; segs: Array<{ a: number[]; b: number[] }> }> = [];
  private tlRingSegs: Array<{ a: number[]; b: number[] }> = [];
  // Ground track per satellite: sub-satellite points (lng unwrapped so a path never jumps across ±180, which on the
  // globe is the same place) and the simulated time of each
  // Ground tracks (TripsLayer): timestamps in s since tlTrackBase (float32 on the GPU, so not ms since epoch).
  // ponytail: float32 seconds stay sub-second for ~3 months of simulated time (~20 h at x100); re-base at the daily
  // re-anchor if anyone runs it longer.
  private tlChunks: Array<{ end: number; path: number[]; timestamps: number[] }> = []; // path: flat [lng, lat, z, ...]
  private tlTrackBase = 0;
  private tlTrackEnd = 0;  // simulated time the tracks are computed up to
  private tlScanLines: Array<{ a: number[]; b: number[] }> = []; // cross-track scan line under each satellite
  // Satellite markers: ONE array, updated in place every frame. A new data array per frame made deck rebuild the
  // labels' per-character GPU buffers 60 times a second, which piled up into 10-15 s GPU stalls.
  private tlDots: Array<{ id: string; name: string; position: number[]; shown: boolean }> = [];
  private tlFrame = 0;
  private tlHeavyAt = 0;
  private tlUiAt = 0;
  private tlVersion = 0;
  private nightTimeSetter?: (t: number | null) => void;
  private constellationLayers: any[] = [];
  private flightUntil = 0; // performance.now() until which deck must not move the map (flyTo in progress)
  private map: MapLibreMap;
  private deck!: Deck;
  private satellites: Map<string, SatelliteData> = new Map(); // Active satellites for display
  private searchSatelliteDatabase: Map<string, SatelliteData> = new Map(); // All satellites for search
  private animationId: number | null = null;
  private followingSatellite: string | null = null;
  private showOrbits = false;
  private isPaused = false;
  private satelliteIcons: Map<string, any> = new Map();
  private loadingIcons = new Set<string>(); // Track which icons are currently loading
  private onTrackingChangeCallback?: () => void;
  private onSatellitesLoadedCallback?: () => void;
  
  // Simple real-time tracking
  private trackingInterval: number | null = null;
  
  // Performance optimization: cache satellite records and positions
  private satelliteRecords: Map<string, any> = new Map();
  private positionCache: Map<string, {position: any, timestamp: number}> = new Map();
  private readonly POSITION_CACHE_TTL = 2000; // Cache positions for 2 seconds (better responsiveness)
  
  // Layer update optimization
  private lastLayerUpdateZoom = -1;
  private lastLayerUpdateBounds: any = null;
  private layerUpdateThrottle = 0;
  private readonly LAYER_UPDATE_THROTTLE = 100; // 10fps layer updates to prevent spam
  
  // Performance optimizers
  private performanceManager = new PerformanceManager();
  private lodManager = new LODManager();
  private satelliteWorker: Worker | null = null;
  private orbitalInterpolator = new OrbitalInterpolator();
  
  // Ultra-smooth tracking system
  private smoothTracker = new SmoothTracker();
  private smoothCamera: SmoothCamera;
  
  // Satellite type filters
  private enabledSatelliteTypes = new Set<string>([
    'scientific', 'communication', 'earth-observation', 'weather', 'navigation'
  ]);
  
  // Satellite visibility filter - when tracking, show only tracked satellite
  // DEFAULT: true to prevent CPU/memory nightmare from showing all satellites
  private showTrackedSatelliteOnly = true;
  
  // Satellite size scaling
  private satelliteSizeMultiplier = 1.0; // Default size multiplier for all satellites
  private trackedSatelliteSizeMultiplier = 1.0; // Size multiplier for tracked satellite only
  private readonly MIN_SIZE_MULTIPLIER = 0.1; // 10% of original size
  private readonly MAX_SIZE_MULTIPLIER = 5.0; // 500% of original size
  
  // Cockpit visibility
  private isCockpitVisible = true;
  
  
  // Dynamic satellite data fetcher
  private satelliteDataFetcher = new SatelliteDataFetcher();
  private allowExternalSatelliteLoading = true; // Flag to prevent loading external satellites on homepage
  

  constructor(map: MapLibreMap) {
    this.map = map;
    this.smoothCamera = new SmoothCamera(map);
    
    // Setup smooth tracker with position update callback
    this.smoothTracker = new SmoothTracker((position: PredictivePosition) => {
      this.smoothCamera.updateTargetPosition(position);
    });
    
    this.initializeDeck();
    this.initializeWorker();
  }


  setOnTrackingChangeCallback(callback: () => void) {
    this.onTrackingChangeCallback = callback;
  }

  setOnSatellitesLoadedCallback(callback: () => void) {
    this.onSatellitesLoadedCallback = callback;
  }

  private onStopFollowingCallback?: () => void;

  setOnStopFollowingCallback(callback: () => void) {
    this.onStopFollowingCallback = callback;
  }

  private satelliteDataService?: any;

  async setSatelliteDataService(service: any): Promise<void> {
    this.satelliteDataService = service;
    // Update satellites with data from the service if available
    if (service && service.getSatellites) {
      const serviceSatellites = service.getSatellites();
      serviceSatellites.forEach((sat: any, id: string) => {
        if (!this.satellites.has(id)) {
          this.satellites.set(id, sat);
        }
      });
    }
  }

  getSatelliteDataService(): any {
    return this.satelliteDataService;
  }

  private setupAggressivePitchOverride() {
    // Simplified approach: Let MapLibre handle pitch completely
    // Deck.gl should only handle satellite rendering, not pitch control
    
    this.deck.setProps({
      onViewStateChange: (params) => {
        const { viewState } = params;
        if (performance.now() < this.flightUntil) return; // don't cancel a programmatic flyTo with a stale zoom
        
        // Only sync non-pitch properties with MapLibre
        // Let the custom Ctrl+drag handler control pitch directly
        this.map.jumpTo({
          center: [viewState.longitude, viewState.latitude],
          zoom: viewState.zoom,
          bearing: viewState.bearing
          // Deliberately omit pitch - let MapLibre handle it
        });
      }
    });
    
  }

  private initializeDeck() {
    // Suppress the calculateFogMatrix warning for globe projection
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('calculateFogMatrix is not supported on globe projection')) {
        return; // Suppress this specific warning
      }
      originalWarn.apply(console, args);
    };
    
    // Create canvas element for deck.gl first
    const canvas = document.createElement('canvas');
    canvas.id = 'deck-canvas';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'auto';
    canvas.style.zIndex = '1';
    
    const mapContainer = this.map.getContainer();
    mapContainer.appendChild(canvas);

    // Initialize deck.gl with the created canvas
    // Get the current map's view state to sync with URL parameters
    const mapCenter = this.map.getCenter();
    const mapZoom = this.map.getZoom();
    
    this.deck = new Deck({
      canvas: canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      initialViewState: {
        longitude: mapCenter.lng,
        latitude: mapCenter.lat,
        zoom: mapZoom,
        pitch: 0,
        bearing: 0,
        maxPitch: 85,
        minPitch: 0
      },
      controller: {
        dragPan: true,
        dragRotate: true,
        scrollZoom: true,
        doubleClickZoom: true,
        touchRotate: false,
        keyboard: true
      },
      // Remove parameters that may cause issues with globe projection
      onViewStateChange: ({ viewState }) => {
        if (performance.now() < this.flightUntil) return; // don't cancel a programmatic flyTo with a stale zoom
        // Sync with MapLibre view but don't set pitch
        // Let MapLibre handle pitch control entirely
        this.map.jumpTo({
          center: [viewState.longitude, viewState.latitude],
          zoom: viewState.zoom,
          bearing: viewState.bearing
          // Deliberately omit pitch - let MapLibre control it
        });
      },
      onClick: this.handleClick.bind(this),
      _typedArrayManagerProps: {
        overAlloc: 1,
        poolSize: 0
      }
    });

    // Add aggressive pitch override after initialization
    setTimeout(() => {
      this.setupAggressivePitchOverride();
    }, 500);

    // Sync deck.gl view with MapLibre
    const syncView = () => {
      const center = this.map.getCenter();
      const zoom = this.map.getZoom();
      const bearing = this.map.getBearing();
      const pitch = this.map.getPitch();

      this.deck.setProps({
        viewState: {
          longitude: center.lng,
          latitude: center.lat,
          zoom,
          bearing,
          pitch
        }
      });
    };

    this.map.on('move', syncView);
    this.map.on('zoom', syncView);
    this.map.on('rotate', syncView);
    this.map.on('pitch', syncView);
    
    // Update satellites on map move for smooth panning
    this.map.on('move', () => {
      // Update layers during map movement for smooth satellite panning
      this.updateLayers(true);
    });
    
    // Initial sync
    setTimeout(syncView, 100);
  }

  // Load only ISS immediately for instant tracking
  loadISSOnly() {
    // Clear all satellites first
    this.satellites.clear();
    return this.loadConfigSatelliteById('iss-zarya');
  }
  
  // Clear all satellites except ISS
  clearAllSatellitesExceptISS() {
    const issData = this.satellites.get('iss-zarya');
    this.satellites.clear();
    if (issData) {
      this.satellites.set('iss-zarya', issData);
    }
  }

  // Disable external satellite loading for homepage performance
  disableExternalSatelliteLoading() {
    this.allowExternalSatelliteLoading = false;
    // Clear any cached external satellite data to prevent automatic loading
    this.satelliteDataFetcher.clearCache();
    // Force clear all satellites except ISS to ensure clean state
    this.clearAllSatellitesExceptISS();
  }

  // Re-enable external satellite loading
  enableExternalSatelliteLoading() {
    this.allowExternalSatelliteLoading = true;
  }

  // Load any satellite from config immediately for instant tracking (only for satellites with TLE data in config)
  loadConfigSatelliteById(satelliteId: string) {
    const satelliteConfig = SATELLITE_CONFIGS_WITH_STARLINK.find(sat => sat.id === satelliteId);
    
    if (satelliteConfig && satelliteConfig.tle1 && satelliteConfig.tle2) {
      try {
        const position = this.calculateSatellitePosition(satelliteConfig.tle1, satelliteConfig.tle2, satelliteConfig.id);
        
        if (!isNaN(position.longitude) && !isNaN(position.latitude) && !isNaN(position.altitude)) {
          const satelliteData = {
            id: satelliteConfig.id,
            name: satelliteConfig.name || satelliteConfig.id,
            shortname: satelliteConfig.shortname,
            alternateName: satelliteConfig.alternateName,
            type: satelliteConfig.type || 'communication',
            tle1: satelliteConfig.tle1,
            tle2: satelliteConfig.tle2,
            dimensions: satelliteConfig.dimensions || { length: 2.0, width: 1.0, height: 1.0 },
            image: satelliteConfig.image,
            defaultBearing: satelliteConfig.defaultBearing,
            defaultZoom: satelliteConfig.defaultZoom,
            defaultPitch: satelliteConfig.defaultPitch,
            scaleFactor: satelliteConfig.scaleFactor,
            position: new LngLat(position.longitude, position.latitude),
            altitude: position.altitude,
            velocity: position.velocity
          };
          
          this.satellites.set(satelliteConfig.id, satelliteData);
          
          // Load image immediately if available, otherwise create dot icon
          if (satelliteConfig.image) {
            this.loadSatelliteIcon(satelliteConfig.id, satelliteConfig.image);
          } else {
            this.createDotIcon(satelliteConfig.id);
          }
          
          // Notify that satellites are loaded
          this.onSatellitesLoadedCallback?.();
          
          return true;
        }
      } catch (error) {
      }
    }
    return false;
  }

  // Add a satellite built from a (TLE-bearing) config to the active set
  private addSatelliteFromConfig(c: SatelliteConfig): boolean {
    if (!c.tle1 || !c.tle2) return false;
    try {
      const p = this.calculateSatellitePosition(c.tle1, c.tle2, c.id);
      if (isNaN(p.longitude) || isNaN(p.latitude) || isNaN(p.altitude)) return false;
      this.satellites.set(c.id, {
        id: c.id, name: c.name || c.id, shortname: c.shortname, alternateName: c.alternateName,
        type: c.type || 'earth-observation', tle1: c.tle1, tle2: c.tle2,
        dimensions: c.dimensions || { length: 2.0, width: 1.0, height: 1.0 }, image: c.image,
        defaultBearing: c.defaultBearing, defaultZoom: c.defaultZoom, defaultPitch: c.defaultPitch,
        scaleFactor: c.scaleFactor || 2.0,
        position: new LngLat(p.longitude, p.latitude), altitude: p.altitude, velocity: p.velocity
      });
      return true;
    } catch {
      return false;
    }
  }

  private ensureGlobeOverlay(): MapboxOverlay {
    if (!this.constellationOverlay) {
      this.constellationOverlay = new MapboxOverlay({ interleaved: true, layers: [] });
      this.map.addControl(this.constellationOverlay as any);
    }
    return this.constellationOverlay;
  }

  // Everything the constellation view draws inside MapLibre's own globe
  private applyGlobeLayers() {
    this.ensureGlobeOverlay().setProps({ layers: this.constellationLayers });
  }

  setNightTimeSetter(fn: (t: number | null) => void) {
    this.nightTimeSetter = fn;
  }

  private clearConstellation() {
    this.constellation = null;
    this.constellationLayers = [];
    cancelAnimationFrame(this.tlRaf);
    document.getElementById('timelapse')?.remove();
    this.nightTimeSetter?.(null); // day/night back to real time
    if (this.constellationOverlay) this.applyGlobeLayers();
  }

  // Show every satellite of a constellation at once: real altitude, real orbit rings, whole orbit in view, and a
  // time-lapse (Earth turning, ground tracks and swaths painted) that shows how the constellation covers the planet.
  async showConstellation(group: Constellation): Promise<boolean> {
    const configs = await this.satelliteDataFetcher.fetchGroup(group.query, group.members);
    const ids = configs.filter(c => this.addSatelliteFromConfig(c)).map(c => c.id);
    console.log(`🌐 Constellation "${group.id}": ${ids.length}/${group.members.length} satellites`);
    if (ids.length === 0) {
      this.showMessage(`Could not load the ${group.name} constellation`, 'error');
      return false;
    }

    this.stopSimpleTracking();
    this.smoothTracker.stopTracking();
    this.smoothCamera.stopSmoothTracking();
    this.followingSatellite = null;
    this.constellation = ids;
    this.constellationColor = group.color;
    this.constellationSwathKm = group.swathKm;
    this.deck.setProps({ layers: [] }); // the flat overlay stays empty; the globe overlay draws everything
    this.ensureGlobeOverlay();

    // Frame the whole orbit, tilted from the plane's normal (see VIEW_TILT). The plane is the one most members share;
    // others (e.g. EDC-01) cross it.
    const sats = ids.map(id => this.satellites.get(id)!);
    const rad = Math.PI / 180;
    const nowDate = new Date();
    const gmst = satellite.gstime(nowDate);
    const normals: number[][] = [];
    for (const s of sats) {
      const pv = satellite.propagate(satellite.twoline2satrec(s.tle1, s.tle2), nowDate);
      if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean') continue;
      const { position: r, velocity: v } = pv;
      const hx = r.y * v.z - r.z * v.y, hy = r.z * v.x - r.x * v.z, hz = r.x * v.y - r.y * v.x; // orbit normal (ECI)
      const m = Math.hypot(hx, hy, hz);
      const e = satellite.eciToEcf({ x: hx / m, y: hy / m, z: hz / m }, gmst); // -> Earth-fixed, the map's frame
      normals.push([e.x, e.y, e.z]);
    }
    const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const sharing = (p: number[]) => normals.filter(q => dot(p, q) > Math.cos(15 * rad));
    let lng0: number, lat0: number;
    let bearing = 0;
    if (normals.length) {
      const ref = normals.reduce((p, q) => (sharing(q).length > sharing(p).length ? q : p));
      const sum = sharing(ref).reduce((acc, q) => [acc[0] + q[0], acc[1] + q[1], acc[2] + q[2]], [0, 0, 0]);
      const n = sum.map(c => c / Math.hypot(...sum));
      // Look from VIEW_TILT off the orbit axis, toward the sun: the ring becomes an ellipse whose near half crosses
      // the globe in front of us, on the daylit side where these imaging satellites take their pictures.
      const sun = SolarCalculator.sunPoint(nowDate);
      const sv = [Math.cos(sun.lat * rad) * Math.cos(sun.lng * rad), Math.cos(sun.lat * rad) * Math.sin(sun.lng * rad), Math.sin(sun.lat * rad)];
      let u = sv.map((c, i) => c - dot(sv, n) * n[i]); // sun direction projected into the orbit plane
      if (Math.hypot(...u) < 1e-3) u = Math.abs(n[2]) < 0.9 ? [-n[1], n[0], 0] : [1, 0, 0]; // sun along the axis
      u = u.map(c => c / Math.hypot(...u));
      const v = n.map((c, i) => Math.cos(VIEW_TILT * rad) * c + Math.sin(VIEW_TILT * rad) * u[i]);
      lat0 = Math.asin(v[2]) / rad;
      lng0 = Math.atan2(v[1], v[0]) / rad;
      // Turn the view so the orbit's long axis (in the plane, across the line of sight: n x v) points straight up,
      // letting the ring use the full screen height
      const ax = [n[1] * v[2] - n[2] * v[1], n[2] * v[0] - n[0] * v[2], n[0] * v[1] - n[1] * v[0]];
      const north = [-Math.sin(lat0 * rad) * Math.cos(lng0 * rad), -Math.sin(lat0 * rad) * Math.sin(lng0 * rad), Math.cos(lat0 * rad)];
      const east = [-Math.sin(lng0 * rad), Math.cos(lng0 * rad), 0];
      bearing = Math.atan2(dot(ax, east), dot(ax, north)) / rad;
      if (bearing > 90) bearing -= 180; else if (bearing < -90) bearing += 180; // keep north roughly up
    } else { // no usable orbit: fall back to the mean position
      lat0 = sats.reduce((a, s) => a + s.position.lat, 0) / sats.length;
      lng0 = sats[0].position.lng;
    }
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const maxAlt = Math.max(...sats.map(s => s.altitude));
    const ringRadius = 1 + maxAlt / 6371; // in Earth radii
    // Ring diameter fills the height between the top bar and the time-lapse controls (100 px kept at each end for
    // them and the labels; ~100 px, as the estimate runs a few % large), or the width on a portrait screen. Its top and bottom lie at the depth of the Earth's
    // centre, one radius R behind the surface MapLibre scales to, so perspective shrinks them by D / (D + R), with
    // D = camera-to-surface distance = 1.5 h at MapLibre's 36.87 deg field of view. Solve rho R D / (D + R) = fit / 2.
    const fit = Math.min(h - 200, w - 40) / 2;
    const D = 1.5 * h;
    const R = (fit * D) / Math.max(1, ringRadius * D - fit); // globe radius in px
    // MapLibre's globe radius is 512 * 2^zoom / (2 pi cos(lat)): it draws the globe larger away from the equator
    const zoom = Math.max(0.5, Math.min(4, Math.log2((R * 2 * Math.PI * Math.cos(lat0 * rad)) / 512)));
    this.flightUntil = performance.now() + FLY_DURATION_MS + 200;
    this.map.flyTo({ center: [lng0, lat0], zoom, pitch: 0, bearing, duration: FLY_DURATION_MS, essential: true });

    // Time-lapse: starts playing right after the fly-in
    this.tlGmst = gmst;
    this.tlPlaying = true;
    this.tlSpeed = TL_DEFAULT_SPEED;
    this.anchorTimelapse(nowDate.getTime());
    this.buildTimelapseControls();
    cancelAnimationFrame(this.tlRaf);
    this.tlLast = 0;
    this.tlRaf = requestAnimationFrame(this.constellationFrame);
    this.onTrackingChangeCallback?.();
    return true;
  }

  // (Re)start rings and ground tracks from simulated time t
  // (keepTracks: the daily loop re-anchors the rings only; tracks keep fading out on their own)
  private anchorTimelapse(t: number, keepTracks = false) {
    this.tlT0 = this.tlSim = t;
    this.tlGmst0 = satellite.gstime(new Date(t));
    if (!keepTracks) {
      this.tlTrackBase = this.tlTrackEnd = t;
      this.tlChunks = [];
    }
    this.tlVersion++;
    // One ring per orbital plane: satellites launched together share one (e.g. EDC-02..07), and their near-identical
    // rings drew as a bundle of parallel lines
    const planes: Array<{ raan: number; inc: number }> = [];
    const ringIds = (this.constellation || []).filter(id => {
      const { nodeo, inclo } = satellite.twoline2satrec(this.satellites.get(id)!.tle1, this.satellites.get(id)!.tle2);
      const raan = nodeo * 180 / Math.PI, inc = inclo * 180 / Math.PI;
      if (planes.some(p => Math.abs(((raan - p.raan + 540) % 360) - 180) < 2 && Math.abs(inc - p.inc) < 0.5)) return false;
      planes.push({ raan, inc });
      return true;
    });
    this.tlRings = ringIds.map(id => {
      const s = this.satellites.get(id)!;
      const pts = this.computeOrbitRing(s.tle1, s.tle2, t);
      const segs = pts.slice(1).map(() => ({ a: [0, 0, 0], b: [0, 0, 0] }));
      return { id, pts, segs };
    });
    this.tlRingSegs = this.tlRings.flatMap(r => r.segs);
  }

  // One full orbit as an inertial ring around the Earth, in the (rotating) Earth-fixed frame at time t.
  private computeOrbitRing(tle1: string, tle2: string, t: number): number[][] {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    const periodMs = (2 * Math.PI / satrec.no) * 60000; // satrec.no = rad/min
    const gmst = satellite.gstime(new Date(t));
    const pts: number[][] = [];
    for (let k = 0; k <= RING_N; k++) {
      const pv = satellite.propagate(satrec, new Date(t + (k / RING_N) * periodMs));
      if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
      const g = satellite.eciToGeodetic(pv.position, gmst); // same gmst for every sample -> inertial ring
      pts.push([satellite.degreesLong(g.longitude), satellite.degreesLat(g.latitude), g.height * 1000]);
    }
    return pts;
  }

  private buildTimelapseControls() {
    document.getElementById('timelapse')?.remove();
    const box = document.createElement('div');
    box.id = 'timelapse';
    box.innerHTML = `<button id="tl-play" title="Pause / play">⏸</button>
      <select id="tl-speed" title="Time-lapse speed">${TL_SPEEDS.map(v => `<option value="${v}"${v === this.tlSpeed ? ' selected' : ''}>×${v}</option>`).join('')}</select>
      <button id="tl-reset" title="Restart from now">⟲</button>
      <button id="tl-coverage" title="Keep 24 h of daylight swaths: untinted ground had no pass that day"${this.tlCoverage ? ' class="on"' : ''}>24 h</button>
      <span id="tl-clock"></span>`;
    document.body.appendChild(box);
    box.querySelector('#tl-play')!.addEventListener('click', e => {
      this.tlPlaying = !this.tlPlaying;
      (e.currentTarget as HTMLElement).textContent = this.tlPlaying ? '⏸' : '▶';
    });
    box.querySelector('#tl-speed')!.addEventListener('change', e => { this.tlSpeed = Number((e.target as HTMLSelectElement).value); });
    box.querySelector('#tl-reset')!.addEventListener('click', () => this.anchorTimelapse(Date.now()));
    box.querySelector('#tl-coverage')!.addEventListener('click', e => {
      this.tlCoverage = !this.tlCoverage;
      (e.currentTarget as HTMLElement).classList.toggle('on', this.tlCoverage);
    });
  }

  private constellationFrame = (ts: number) => {
    if (!this.constellation) return;
    this.tlRaf = requestAnimationFrame(this.constellationFrame);
    const dt = this.tlLast ? Math.min(ts - this.tlLast, 100) : 0;
    this.tlLast = ts;
    const flying = performance.now() < this.flightUntil; // hold the clock still during the fly-in

    if (!flying && this.tlPlaying) {
      this.tlSim += dt * this.tlSpeed;
      if (this.tlSim - this.tlT0 > 24 * 3600e3) this.anchorTimelapse(this.tlSim, true); // re-anchor rings daily
    }
    const date = new Date(this.tlSim);
    const gmst = satellite.gstime(date);

    // Earth turns under a fixed (inertial) view: move the map centre west by the rotation since the last frame
    let d = (gmst - this.tlGmst) * 180 / Math.PI;
    d = ((d + 540) % 360) - 180;
    this.tlGmst = gmst;
    if (!flying && d) {
      const c = this.map.getCenter();
      this.map.jumpTo({ center: [c.lng - d, c.lat] });
    }
    if (!flying) this.nightTimeSetter?.(this.tlSim); // the terminator follows the simulated sun

    // Satellites (and the scan line across each ground track) at the simulated time
    const halfKm = this.constellationSwathKm / 2;
    const before = new Date(this.tlSim - 5000);
    if (this.tlScanLines.length !== this.constellation.length) this.tlScanLines = this.constellation.map(() => ({ a: [0, 0, 0], b: [0, 0, 0] }));
    this.constellation.forEach((id, k) => {
      const s = this.satellites.get(id)!;
      const p = this.calculateSatellitePosition(s.tle1, s.tle2, id, date);
      s.position = new LngLat(p.longitude, p.latitude);
      s.altitude = p.altitude;
      s.velocity = p.velocity;
      const q = this.calculateSatellitePosition(s.tle1, s.tle2, id, before);
      const hd = bearingDeg([q.longitude, q.latitude], [p.longitude, p.latitude]); // ground track heading
      const l = this.tlScanLines[k];
      [l.a[0], l.a[1]] = offsetPoint(p.longitude, p.latitude, hd - 90, halfKm);
      [l.b[0], l.b[1]] = offsetPoint(p.longitude, p.latitude, hd + 90, halfKm);
      l.a[2] = l.b[2] = GROUND_LIFT_M;
    });
    // Keep the ground tracks computed ahead of the satellites; drop chunks that have fully faded
    if (this.tlTrackEnd - this.tlSim < TRACK_CHUNK_MS / 2) {
      const t0 = this.tlTrackEnd, t1 = t0 + TRACK_CHUNK_MS;
      const fresh: typeof this.tlChunks = [];
      for (const id of this.constellation) {
        const s = this.satellites.get(id)!;
        let path: number[] = [], timestamps: number[] = [];
        for (let t = t0; t <= t1; t += TRACK_SAMPLE_MS) { // the first sample repeats the previous chunk's last: no gap
          const date = new Date(t);
          const p = this.calculateSatellitePosition(s.tle1, s.tle2, id, date);
          if (SolarCalculator.calculateSolarElevation(p.latitude, p.longitude, date) < MIN_SUN_ELEV_DEG) { // not imaging
            if (path.length >= 6) fresh.push({ end: t1, path, timestamps });
            path = []; timestamps = [];
            continue;
          }
          path.push(unwrapLng(p.longitude, path[path.length - 3]), p.latitude, GROUND_LIFT_M);
          timestamps.push((t - this.tlTrackBase) / 1000);
        }
        if (path.length >= 6) fresh.push({ end: t1, path, timestamps });
      }
      // ponytail: a new chunk rebuilds the swath buffers (~35k vertices with a day kept); split data per hour if that hitches
      this.tlChunks = [...this.tlChunks.filter(c => this.tlSim - c.end < COVERAGE_MS), ...fresh];
      this.tlTrackEnd = t1;
    }

    const now = performance.now();
    if (now - this.tlHeavyAt > 50) { // orbit rings at 20 Hz
      this.tlHeavyAt = now;
      this.updateRingSegments(gmst);
      this.tlVersion++;
    }
    if (now - this.tlUiAt > 250) { // clock label
      this.tlUiAt = now;
      const iso = date.toISOString();
      const el = document.getElementById('tl-clock');
      if (el) el.textContent = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC${this.tlSpeed === 1 ? ' · real time' : ''}`;
    }
    this.renderConstellation();
  };

  // Orbit rings in the current Earth-fixed frame. Faint, with no bright trail: at 600 km up, a trail projects onto
  // the swath and reads as a centre line that isn't on the ground.
  private updateRingSegments(gmst: number) {
    const shift = (this.tlGmst0 - gmst) * 180 / Math.PI; // an inertial ring turns west as the Earth turns east
    for (const r of this.tlRings) {
      for (let i = 0; i < r.segs.length; i++) {
        const p0 = r.pts[i], p1 = r.pts[i + 1], seg = r.segs[i];
        seg.a[0] = p0[0] + shift; seg.a[1] = p0[1]; seg.a[2] = p0[2];
        seg.b[0] = p1[0] + shift; seg.b[1] = p1[1]; seg.b[2] = p1[2];
      }
    }
  }

  private renderConstellation() {
    if (!this.constellation) return;
    const [r, g, b] = this.constellationColor;
    // Dots and labels are billboards, which the globe's depth buffer would slice in half: draw them on top instead,
    // and leave out the ones behind the Earth (camera looks straight down at the map centre from far away)
    const rad = Math.PI / 180;
    const ecef = (lng: number, lat: number) => [Math.cos(lat * rad) * Math.cos(lng * rad), Math.cos(lat * rad) * Math.sin(lng * rad), Math.sin(lat * rad)];
    const c = this.map.getCenter();
    const view = ecef(c.lng, c.lat);
    if (this.tlDots.length !== this.constellation.length || this.tlDots.some((d, i) => d.id !== this.constellation![i])) {
      this.tlDots = this.constellation.map(id => {
        const s = this.satellites.get(id)!;
        return { id, name: s.shortname || s.name, position: [0, 0, 0], shown: true };
      });
    }
    for (const d of this.tlDots) {
      const s = this.satellites.get(d.id)!;
      // On the ground point it is imaging, i.e. on the head of its own footprint (drawn at altitude, perspective
      // shifted each dot off its footprint by up to a few hundred km and paired dots with the wrong swaths)
      d.position[0] = s.position.lng; d.position[1] = s.position.lat; d.position[2] = GROUND_LIFT_M;
      const p = ecef(s.position.lng, s.position.lat);
      d.shown = p[0] * view[0] + p[1] * view[1] + p[2] * view[2] > 0; // on the visible hemisphere
    }
    const dots = this.tlDots;
    const f = ++this.tlFrame; // positions/visibility changed: refresh those attributes only
    const moved = { getPosition: f, getSourcePosition: f, getTargetPosition: f, getColor: f, getFillColor: f, getLineColor: f, getBackgroundColor: f };
    const ifShown = (rgba: number[]) => (d: any) => (d.shown ? rgba : [0, 0, 0, 0]) as any;
    const v = this.tlVersion;
    // Lines are depth-tested against MapLibre's globe, so whatever is behind the Earth is hidden by it
    const lines = { cullMode: 'none' as const };
    const onTop = { depthCompare: 'always' as const, cullMode: 'none' as const };
    // Swaths: the precomputed ground tracks, cut at the current time and faded by age on the GPU (smooth, nothing
    // rebuilt per frame). A faint one for past passes, a bright one for what each satellite is imaging now.
    // _pathType 'open' (flat paths): on the globe deck otherwise re-cuts paths on a 10 deg grid, adding vertices that
    // the per-vertex timestamps don't follow, which drew the cut ~90 s behind the satellite. No depth writes, so
    // overlapping translucent swaths blend instead of hiding each other in jagged steps (still hidden by the globe).
    const swath = { data: this.tlChunks, _pathType: 'open' as const, parameters: { cullMode: 'none' as const, depthWriteEnabled: false },
      getPath: (d: any) => d.path, getTimestamps: (d: any) => d.timestamps,
      getWidth: this.constellationSwathKm * 1000, widthUnits: 'meters' as const, currentTime: (this.tlSim - this.tlTrackBase) / 1000 };
    this.constellationLayers = [
      new TripsLayer({ ...swath, id: 'constellation-swath', getColor: [r, g, b, this.tlCoverage ? 70 : 40],
        trailLength: (this.tlCoverage ? COVERAGE_MS : TRACK_FADE_MS) / 1000, fadeTrail: !this.tlCoverage }),
      new TripsLayer({ ...swath, id: 'constellation-scan', getColor: [r, g, b, 170], trailLength: SCAN_MS / 1000 }),
      new LineLayer({ // the scan line across the track right under each satellite
        id: 'constellation-scanline', data: this.tlScanLines, parameters: lines, updateTriggers: moved,
        getSourcePosition: (d: any) => d.a, getTargetPosition: (d: any) => d.b,
        getColor: [255, 255, 255, 230], getWidth: 2.5, widthUnits: 'pixels'
      }),
      new LineLayer({ // orbit rings
        id: 'constellation-orbits', data: this.tlRingSegs, parameters: lines,
        getSourcePosition: (d: any) => d.a, getTargetPosition: (d: any) => d.b,
        getColor: [r, g, b, 45], getWidth: 1.5, widthUnits: 'pixels',
        updateTriggers: { getSourcePosition: v, getTargetPosition: v }
      }),
      new ScatterplotLayer({ // soft glow
        id: 'constellation-glow', data: dots, parameters: onTop, updateTriggers: moved,
        getPosition: (d: any) => d.position, getRadius: 20, radiusUnits: 'pixels', billboard: true,
        getFillColor: ifShown([r, g, b, 55])
      }),
      new ScatterplotLayer({ // bright core
        id: 'constellation-dots', data: dots, parameters: onTop, pickable: true, updateTriggers: moved,
        getPosition: (d: any) => d.position, getRadius: 5.5, radiusUnits: 'pixels', billboard: true,
        getFillColor: ifShown([255, 255, 255, 255]), getLineColor: ifShown([r, g, b, 255]), getLineWidth: 2.5, stroked: true
      }),
      new TextLayer({
        id: 'constellation-labels', data: dots, parameters: onTop, updateTriggers: moved,
        getPosition: (d: any) => d.position, getText: (d: any) => d.name,
        getSize: 12, getColor: ifShown([255, 255, 255, 255]), getPixelOffset: [0, -24],
        background: true, getBackgroundColor: ifShown([8, 14, 24, 190]), backgroundPadding: [7, 3],
        fontFamily: 'Inter, sans-serif', fontWeight: 600
      })
    ];
    this.applyGlobeLayers();
  }

  // Load a specific satellite from external data without loading all satellites
  async loadSpecificSatellite(satelliteId: string): Promise<boolean> {
    console.log(`🔍 Loading satellite "${satelliteId}" from Celestrak data...`);
    
    try {
      // Cheap targeted lookup first; only download the full catalogue if that fails
      const direct = await this.satelliteDataFetcher.fetchSatelliteBySlug(satelliteId);
      const allSatellites = direct ? [direct] : await this.satelliteDataFetcher.fetchSatellites(['all']);
      console.log(`🔍 Downloaded ${allSatellites.length} satellites from Celestrak${direct ? ' (targeted)' : ''}`);
      
      // Populate the search database while we have the full catalogue (otherwise it loads on first search)
      if (!direct && !this.searchSatellitesLoaded) {
        await this.populateSearchDatabaseFromSatelliteList(allSatellites);
        this.searchSatellitesLoaded = true;
      }
      
      // Find the specific satellite by ID or name
      const targetSatellite = allSatellites.find(sat => {
        const nameMatch = sat.name?.toLowerCase().replace(/[^a-z0-9]/g, '-') === satelliteId.toLowerCase();
        const idMatch = sat.id?.toLowerCase() === satelliteId.toLowerCase();
        const exactNameMatch = sat.name?.toLowerCase() === satelliteId.toLowerCase();
        return nameMatch || idMatch || exactNameMatch;
      });
      
      if (!targetSatellite || !targetSatellite.tle1 || !targetSatellite.tle2) {
        console.log(`🔍 Satellite "${satelliteId}" not found in Celestrak data`);
        return false;
      }
      
      console.log(`🔍 Found satellite: ${targetSatellite.name} (${targetSatellite.id})`);
      
      // Calculate position using TLE data
      const position = this.calculateSatellitePosition(targetSatellite.tle1, targetSatellite.tle2, targetSatellite.id);
      console.log(`🔍 Position calculated:`, position);
      
      if (isNaN(position.longitude) || isNaN(position.latitude) || isNaN(position.altitude)) {
        console.log(`🔍 Invalid position for satellite "${satelliteId}"`);
        return false;
      }
      
      // Look for config metadata to merge
      const satelliteConfig = SATELLITE_CONFIGS_WITH_STARLINK.find(sat => 
        sat.id === satelliteId || 
        sat.name?.toLowerCase() === targetSatellite.name?.toLowerCase()
      );
      
      console.log(`🔍 Config metadata found:`, satelliteConfig ? 'YES' : 'NO');
      
      // Create satellite data merging TLE with config
      const satelliteData: SatelliteData = {
        id: satelliteId, // Use the requested ID
        name: satelliteConfig?.name || targetSatellite.name || satelliteId,
        shortname: satelliteConfig?.shortname || targetSatellite.shortname,
        alternateName: satelliteConfig?.alternateName || targetSatellite.alternateName,
        type: satelliteConfig?.type || targetSatellite.type || 'communication',
        tle1: targetSatellite.tle1,
        tle2: targetSatellite.tle2,
        dimensions: satelliteConfig?.dimensions || {
          length: 2.0,
          width: 1.0,
          height: 1.0
        },
        image: satelliteConfig?.image,
        defaultBearing: satelliteConfig?.defaultBearing,
        defaultZoom: satelliteConfig?.defaultZoom,
        defaultPitch: satelliteConfig?.defaultPitch,
        scaleFactor: satelliteConfig?.scaleFactor || 2.0,
        position: new LngLat(position.longitude, position.latitude),
        altitude: position.altitude,
        velocity: position.velocity
      };
      
      // Add only this satellite to the map
      this.satellites.set(satelliteId, satelliteData);
      console.log(`🔍 Satellite "${satelliteId}" loaded successfully`);
      
      // Load image if available
      if (satelliteData.image) {
        this.loadSatelliteIcon(satelliteId, satelliteData.image);
        console.log(`🔍 Loading image:`, satelliteData.image);
      } else {
        this.createDotIcon(satelliteId);
      }
      
      this.onSatellitesLoadedCallback?.();
      return true;
      
    } catch (error) {
      console.error(`Failed to load satellite "${satelliteId}":`, error);
      return false;
    }
  }

  // Load all satellites for search functionality (cached)
  private searchSatellitesLoaded = false;

  // Populate search database from a list of satellite configs
  private async populateSearchDatabaseFromSatelliteList(allSatellites: any[]): Promise<void> {
    let loadedCount = 0;
    
    for (const sat of allSatellites) {
      if (!sat.tle1 || !sat.tle2) continue;
      
      // Skip if satellite already exists in search database
      if (this.searchSatelliteDatabase.has(sat.id)) continue;
      
      try {
        // Calculate position using TLE data
        const position = this.calculateSatellitePosition(sat.tle1, sat.tle2, sat.id);
        
        if (isNaN(position.longitude) || isNaN(position.latitude) || isNaN(position.altitude)) {
          continue;
        }
        
        // Look for config metadata to merge
        const satelliteConfig = SATELLITE_CONFIGS_WITH_STARLINK.find(config => 
          config.id === sat.id || 
          config.name?.toLowerCase() === sat.name?.toLowerCase()
        );
        
        // Create satellite data merging TLE with config
        const satelliteData: SatelliteData = {
          id: sat.id,
          name: satelliteConfig?.name || sat.name || sat.id,
          shortname: satelliteConfig?.shortname || sat.shortname,
          alternateName: satelliteConfig?.alternateName || sat.alternateName,
          type: satelliteConfig?.type || sat.type || 'communication',
          tle1: sat.tle1,
          tle2: sat.tle2,
          dimensions: satelliteConfig?.dimensions || sat.dimensions || {
            length: 2.0,
            width: 1.0,
            height: 1.0
          },
          image: satelliteConfig?.image,
          defaultBearing: satelliteConfig?.defaultBearing,
          defaultZoom: satelliteConfig?.defaultZoom,
          defaultPitch: satelliteConfig?.defaultPitch,
          scaleFactor: satelliteConfig?.scaleFactor || 2.0,
          position: new LngLat(position.longitude, position.latitude),
          altitude: position.altitude,
          velocity: position.velocity
        };
        
        // Add to search database (not active satellites)
        this.searchSatelliteDatabase.set(sat.id, satelliteData);
        
        loadedCount++;
      } catch (error) {
        // Skip satellites with invalid data
        continue;
      }
    }
    
    console.log(`🌍 Successfully populated search database with ${loadedCount} satellites`);
  }
  
  async loadAllSatellitesForSearch(): Promise<void> {
    // Only load once for search functionality
    if (this.searchSatellitesLoaded) {
      return;
    }
    
    await this.loadAllSatellitesFromCelestrak();
    // Stay "not loaded" if the download failed, so a later open can retry
    this.searchSatellitesLoaded = this.searchSatelliteDatabase.size > 0;
  }

  async searchRemote(query: string): Promise<Array<{ id: string; name: string }>> {
    return (await this.satelliteDataFetcher.searchByName(query)).map(t => ({ id: t.id, name: t.name }));
  }

  // Load a specific satellite from search database into active satellites for tracking
  loadSatelliteFromSearchDatabase(satelliteId: string): boolean {
    const searchSatellite = this.searchSatelliteDatabase.get(satelliteId);
    if (!searchSatellite) {
      console.warn(`Satellite ${satelliteId} not found in search database`);
      return false;
    }
    
    // Recalculate current position (search database may have old positions)
    try {
      const position = this.calculateSatellitePosition(searchSatellite.tle1, searchSatellite.tle2, satelliteId);
      
      // Create updated satellite data with current position
      const updatedSatellite: SatelliteData = {
        ...searchSatellite,
        position: new LngLat(position.longitude, position.latitude),
        altitude: position.altitude,
        velocity: position.velocity
      };
      
      // Add to active satellites
      this.satellites.set(satelliteId, updatedSatellite);
      
      // Load image if available, otherwise create dot icon
      if (updatedSatellite.image) {
        this.loadSatelliteIcon(satelliteId, updatedSatellite.image);
      } else {
        this.createDotIcon(satelliteId);
      }
      
      console.log(`✅ Loaded satellite ${satelliteId} from search database`);
      return true;
      
    } catch (error) {
      console.error(`Failed to load satellite ${satelliteId} from search database:`, error);
      return false;
    }
  }

  // Load all satellites from Celestrak into search database
  async loadAllSatellitesFromCelestrak(): Promise<void> {
    if (!this.allowExternalSatelliteLoading) {
      console.log('🚫 External satellite loading is disabled');
      return;
    }
    
    console.log('🌍 Loading all satellites from Celestrak into search database...');
    
    try {
      // Download all TLE data from Celestrak
      const allSatellites = await this.satelliteDataFetcher.fetchSatellites(['all']);
      console.log(`🌍 Downloaded ${allSatellites.length} satellites from Celestrak`);
      
      let loadedCount = 0;
      
      for (const sat of allSatellites) {
        if (!sat.tle1 || !sat.tle2) continue;
        
        // Skip if satellite already exists in search database
        if (this.searchSatelliteDatabase.has(sat.id)) continue;
        
        try {
          // Calculate position using TLE data
          const position = this.calculateSatellitePosition(sat.tle1, sat.tle2, sat.id);
          
          if (isNaN(position.longitude) || isNaN(position.latitude) || isNaN(position.altitude)) {
            continue;
          }
          
          // Look for config metadata to merge
          const satelliteConfig = SATELLITE_CONFIGS_WITH_STARLINK.find(config => 
            config.id === sat.id || 
            config.name?.toLowerCase() === sat.name?.toLowerCase()
          );
          
          // Create satellite data merging TLE with config
          const satelliteData: SatelliteData = {
            id: sat.id,
            name: satelliteConfig?.name || sat.name || sat.id,
            shortname: satelliteConfig?.shortname || sat.shortname,
            alternateName: satelliteConfig?.alternateName || sat.alternateName,
            type: satelliteConfig?.type || sat.type || 'communication',
            tle1: sat.tle1,
            tle2: sat.tle2,
            dimensions: satelliteConfig?.dimensions || sat.dimensions || {
              length: 2.0,
              width: 1.0,
              height: 1.0
            },
            image: satelliteConfig?.image,
            defaultBearing: satelliteConfig?.defaultBearing,
            defaultZoom: satelliteConfig?.defaultZoom,
            defaultPitch: satelliteConfig?.defaultPitch,
            scaleFactor: satelliteConfig?.scaleFactor || 2.0,
            position: new LngLat(position.longitude, position.latitude),
            altitude: position.altitude,
            velocity: position.velocity
          };
          
          // Add to search database (not active satellites)
          this.searchSatelliteDatabase.set(sat.id, satelliteData);
          
          loadedCount++;
        } catch (error) {
          // Skip satellites with invalid data
          continue;
        }
      }
      
      console.log(`🌍 Successfully loaded ${loadedCount} satellites into search database`);
      
      // Debug: show a few examples of what's in the database
      const sampleSatellites = Array.from(this.searchSatelliteDatabase.values()).slice(0, 5);
      console.log('🔍 Sample satellites in database:', sampleSatellites.map(sat => ({
        id: sat.id,
        name: sat.name,
        type: sat.type
      })));
      
    } catch (error) {
      console.error('Failed to load all satellites from Celestrak:', error);
      throw error;
    }
  }

  async initialize() {
    // Load config satellites first (synchronously) for immediate tracking
    this.loadConfigSatellites();
    
    // External satellites will be loaded on-demand for search functionality
    // This keeps the app fast when viewing specific satellites
    
    this.loadSatelliteIcons();
    this.updateLayers();
    // Start background satellite position updates (not camera tracking)
    this.startBackgroundUpdates();
    
    // Setup search and filters after satellites are loaded
    setTimeout(() => {
      this.setupSearchFunctionality();
      this.setupKeyboardShortcuts();
      this.setupCockpitToggle();
    }, 100);
  }

  private initializeWorker() {
    // Disable worker for now due to module loading issues with importScripts
    // All calculations will use main thread fallback which works reliably
    this.satelliteWorker = null;
  }

  // Prioritize satellites for loading - important ones first
  // prioritizeAllSatellites() method removed - no longer needed since we don't bulk load satellites

  private loadConfigSatellites() {
    // Load satellites from config immediately (no external API calls)
    SATELLITE_CONFIGS_WITH_STARLINK.forEach(sat => {
      try {
        // Skip configs without TLE data - they will be loaded from external sources
        if (!sat.tle1 || !sat.tle2) {
          return;
        }
        
        const position = this.calculateSatellitePosition(sat.tle1, sat.tle2, sat.id);
        
        if (isNaN(position.longitude) || isNaN(position.latitude) || isNaN(position.altitude)) {
          return;
        }
        
        this.satellites.set(sat.id, {
          id: sat.id,
          name: sat.name || sat.id,
          shortname: sat.shortname,
          alternateName: sat.alternateName,
          type: sat.type || 'communication',
          tle1: sat.tle1,
          tle2: sat.tle2,
          dimensions: sat.dimensions || { length: 2.0, width: 1.0, height: 1.0 },
          image: sat.image,
          defaultBearing: sat.defaultBearing,
          scaleFactor: sat.scaleFactor,
          position: new LngLat(position.longitude, position.latitude),
          altitude: position.altitude,
          velocity: position.velocity
        });
        
      } catch (error) {
        // Silently skip satellites with invalid TLE data
      }
    });
    
    // Notify that initial config satellites are loaded
    this.onSatellitesLoadedCallback?.();
  }

  // External satellites are loaded on-demand for search functionality
  // This keeps the app fast when viewing specific satellites

  private loadSatelliteIcons() {
    // Don't load all images immediately - use lazy loading instead
    // Only create dot icons for satellites without images
    const satellitesWithoutImages = Array.from(this.satellites.values()).filter(sat => !sat.image);
    satellitesWithoutImages.forEach(sat => {
      this.createDotIcon(sat.id);
    });
    
    // Images will be loaded on-demand when satellites become visible/tracked
  }

  private loadSatelliteIconLazy(satelliteId: string, imageUrl: string) {
    // Don't load if already loaded or loading
    if (this.satelliteIcons.has(satelliteId) || this.loadingIcons.has(satelliteId)) {
      return;
    }
    
    this.loadingIcons.add(satelliteId);
    
    // Resolve against the Vite base (e.g. /fromupthere/ on GitHub Pages)
    const resolvedUrl = `${import.meta.env.BASE_URL}${imageUrl.replace(/^\//, '')}`;
    
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // Keep full resolution - just create canvas with original image dimensions
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Draw image at full resolution
        ctx.drawImage(img, 0, 0);
        
        // Use actual image dimensions
        const ICON_MAPPING = {
          [satelliteId]: { x: 0, y: 0, width: img.width, height: img.height, mask: false }
        };
        
        this.satelliteIcons.set(satelliteId, {
          atlas: canvas,
          mapping: ICON_MAPPING,
          width: canvas.width,
          height: canvas.height
        });
        
        this.loadingIcons.delete(satelliteId);
        this.updateLayers(true); // Refresh layers with icon
      }
    };
    img.onerror = (error) => {
      console.error(`❌ Failed to load satellite image for ${satelliteId} at ${resolvedUrl}:`, error);
      this.loadingIcons.delete(satelliteId);
      // Fall back to dot icon for this satellite
      this.createDotIcon(satelliteId);
    };
    img.src = resolvedUrl;
  }

  // Legacy method for backward compatibility - now uses lazy loading
  private loadSatelliteIcon(satelliteId: string, imageUrl: string) {
    this.loadSatelliteIconLazy(satelliteId, imageUrl);
  }

  private createDotIcon(satelliteId: string) {
    // Create high-quality static tracking dot (CSS will handle blinking)
    const dotSize = 32; // Larger for better quality
    const canvas = document.createElement('canvas');
    
    // Use device pixel ratio for crisp rendering on high-DPI displays
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dotSize * dpr;
    canvas.height = dotSize * dpr;
    canvas.style.width = dotSize + 'px';
    canvas.style.height = dotSize + 'px';
    
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Scale context for high-DPI rendering
      ctx.scale(dpr, dpr);
      
      // Enable maximum anti-aliasing
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      const centerX = dotSize / 2;
      const centerY = dotSize / 2;
      
      // Clear canvas with transparent background
      ctx.clearRect(0, 0, dotSize, dotSize);
      
      // Outer soft glow
      const outerGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 12);
      outerGradient.addColorStop(0, 'rgba(0, 255, 136, 0.6)');
      outerGradient.addColorStop(0.3, 'rgba(0, 255, 136, 0.3)');
      outerGradient.addColorStop(0.7, 'rgba(0, 255, 136, 0.1)');
      outerGradient.addColorStop(1, 'rgba(0, 255, 136, 0)');
      
      ctx.beginPath();
      ctx.arc(centerX, centerY, 12, 0, 2 * Math.PI);
      ctx.fillStyle = outerGradient;
      ctx.fill();
      
      // Middle ring with subtle glow
      ctx.beginPath();
      ctx.arc(centerX, centerY, 7, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(0, 255, 136, 0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
      
      // Inner core with gradient
      const coreGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, 5);
      coreGradient.addColorStop(0, '#ffffff');
      coreGradient.addColorStop(0.3, '#00ff88');
      coreGradient.addColorStop(0.7, '#00cc66');
      coreGradient.addColorStop(1, '#009944');
      
      ctx.beginPath();
      ctx.arc(centerX, centerY, 5, 0, 2 * Math.PI);
      ctx.fillStyle = coreGradient;
      ctx.fill();
      
      // Bright center point
      ctx.beginPath();
      ctx.arc(centerX, centerY, 2, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      
      // Very bright center pixel
      ctx.beginPath();
      ctx.arc(centerX, centerY, 0.8, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      
      // Store the dot icon
      const ICON_MAPPING = {
        [satelliteId]: { x: 0, y: 0, width: dotSize, height: dotSize, mask: false }
      };
      
      this.satelliteIcons.set(satelliteId, {
        atlas: canvas,
        mapping: ICON_MAPPING,
        width: dotSize,
        height: dotSize
      });
    }
  }

  private calculateSatellitePosition(tle1: string, tle2: string, satelliteId?: string, at?: Date) {
    const now = Date.now();
    
    // Check cache first if satellite ID is provided, but SKIP cache for followed satellite
    if (satelliteId && !at && this.followingSatellite !== satelliteId) {
      const cached = this.positionCache.get(satelliteId);
      if (cached && now - cached.timestamp < this.POSITION_CACHE_TTL) {
        return cached.position;
      }
    }
    
    // Get or create satellite record (expensive operation)
    const cacheKey = `${tle1}-${tle2}`;
    let satrec = this.satelliteRecords.get(cacheKey);
    if (!satrec) {
      satrec = satellite.twoline2satrec(tle1, tle2);
      this.satelliteRecords.set(cacheKey, satrec);
    }
    
    const currentTime = at ?? new Date(); // `at`: simulated time (constellation time-lapse); bypasses the cache
    const positionAndVelocity = satellite.propagate(satrec, currentTime);
    
    if (positionAndVelocity.position && typeof positionAndVelocity.position !== 'boolean') {
      const gmst = satellite.gstime(currentTime);
      const positionGd = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
      
      // Calculate bearing from velocity vector
      let bearing = 0;
      if (positionAndVelocity.velocity && typeof positionAndVelocity.velocity !== 'boolean') {
        // Convert ECI velocity to geographic direction
        const velocityEci = positionAndVelocity.velocity;
        
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
      
      const result = {
        longitude: satellite.degreesLong(positionGd.longitude),
        latitude: satellite.degreesLat(positionGd.latitude),
        altitude: positionGd.height,
        velocity: positionAndVelocity.velocity && typeof positionAndVelocity.velocity !== 'boolean' ? 
          Math.sqrt(
            Math.pow(positionAndVelocity.velocity.x, 2) + 
            Math.pow(positionAndVelocity.velocity.y, 2) + 
            Math.pow(positionAndVelocity.velocity.z, 2)
          ) : 0,
        bearing: bearing
      };
      
      // Cache the result if satellite ID is provided
      if (satelliteId && !at) {
        this.positionCache.set(satelliteId, { position: result, timestamp: now });
        
        // Add to interpolator for smooth movement
        const satellitePos: SatellitePosition = {
          longitude: result.longitude,
          latitude: result.latitude,
          altitude: result.altitude,
          velocity: result.velocity,
          timestamp: now
        };
        this.orbitalInterpolator.addPosition(satelliteId, satellitePos);
      }
      
      return result;
    }
    
    return { longitude: 0, latitude: 0, altitude: 0, velocity: 0, bearing: 0 };
  }

  private getColorForType(type: string): [number, number, number, number] {
    switch (type) {
      case 'scientific': return [0, 255, 0, 255]; // Green
      case 'communication': return [0, 128, 255, 255]; // Blue
      case 'weather': return [255, 128, 0, 255]; // Orange
      case 'earth-observation': return [255, 128, 0, 255]; // Orange
      case 'navigation': return [128, 0, 255, 255]; // Purple
      default: return [255, 255, 255, 255]; // White
    }
  }


  private generateSatellitePoints(): SatellitePointData[] {
    const zoom = this.map.getZoom();    
    // AGGRESSIVE FIX: If external satellite loading is disabled and we have more than 1 satellite, 
    // force clear all except ISS to prevent cached satellites from appearing
    if (!this.allowExternalSatelliteLoading && this.satellites.size > 1) {
      this.clearAllSatellitesExceptISS();
    }
    
    // Ultra-fast path: if we only have ISS loaded, return it immediately
    if (this.satellites.size === 1 && this.followingSatellite) {
      const trackedSat = this.satellites.get(this.followingSatellite);
      if (trackedSat && trackedSat.position) {
        // Skip if this satellite has an image AND the icon is loaded
        if (trackedSat.image && this.satelliteIcons.has(this.followingSatellite)) {
          return [];
        }
        
        const baseSize = 2;
        const size = baseSize * this.trackedSatelliteSizeMultiplier;
        
        let position = trackedSat.position;
        let altitude = trackedSat.altitude;
        let velocity = trackedSat.velocity;
        
        const smoothPos = this.smoothTracker.getPredictedPosition();
        if (smoothPos) {
          position = { lng: smoothPos.longitude, lat: smoothPos.latitude } as any;
          altitude = smoothPos.altitude;
          velocity = smoothPos.velocity;
        }
        
        return [{
          position: [position.lng, position.lat, altitude],
          size,
          color: [255, 255, 0, 255],
          id: trackedSat.id,
          name: trackedSat.name,
          type: trackedSat.type,
          altitude: altitude,
          velocity: velocity,
          length: 0
        }];
      }
      return [];
    }
    
    // Fast path for single satellite tracking - bypass all expensive operations
    if (this.followingSatellite && this.showTrackedSatelliteOnly) {
      const trackedSat = this.satellites.get(this.followingSatellite);
      if (trackedSat && trackedSat.position) {
        // Skip if this satellite has an image AND the icon is loaded (should render as icon instead)
        if (trackedSat.image && this.satelliteIcons.has(this.followingSatellite)) {
          return [];
        }
        
        // If satellite has an image but icon isn't loaded yet, load it and show point temporarily
        if (trackedSat.image && !this.satelliteIcons.has(this.followingSatellite)) {
          this.loadSatelliteIcon(this.followingSatellite, trackedSat.image);
          // Fall through to show point until icon loads
        }
        
        const baseSize = 2; // Fixed size for performance
        const size = baseSize * this.trackedSatelliteSizeMultiplier;
        
        // Use smooth position if available for ultra-smooth tracking
        let position = trackedSat.position;
        let altitude = trackedSat.altitude;
        let velocity = trackedSat.velocity;
        
        const smoothPos = this.smoothTracker.getPredictedPosition();
        if (smoothPos) {
          position = { lng: smoothPos.longitude, lat: smoothPos.latitude } as any;
          altitude = smoothPos.altitude;
          velocity = smoothPos.velocity;
        }
        
        return [{
          position: [position.lng, position.lat, altitude],
          size,
          color: [255, 255, 0, 255], // Yellow for tracked satellite
          id: trackedSat.id,
          name: trackedSat.name,
          type: trackedSat.type,
          altitude: altitude,
          velocity: velocity,
          length: 0
        }];
      }
      return [];
    }
    
    const bounds = this.map.getBounds();
    
    // Enhanced performance management for high satellite counts
    const maxSatellites = this.performanceManager.getMaxSatellites();
    const performanceSkip = this.performanceManager.getLODSkip(zoom);
    
    // Aggressive viewport culling for performance
    const getViewportMargin = (zoom: number): number => {
      if (zoom <= 2) return 60; // Wide margin at very low zoom
      if (zoom <= 4) return 30; // Medium margin at low zoom
      if (zoom <= 6) return 15; // Smaller margin at medium zoom
      return 5; // Very tight margin at high zoom
    };
    
    const margin = getViewportMargin(zoom);
    const expandedBounds = {
      west: bounds.getWest() - margin,
      east: bounds.getEast() + margin,
      south: bounds.getSouth() - margin/2,
      north: bounds.getNorth() + margin/2
    };
    
    // Filter satellites based on visibility settings
    const satellitesForLOD: SatelliteForLOD[] = Array.from(this.satellites.values())
      .filter(sat => {
        // If showing only tracked satellite and we're tracking one, show only that
        if (this.followingSatellite && this.showTrackedSatelliteOnly) {
          return sat.id === this.followingSatellite;
        }
        
        // Apply type filters
        if (!this.enabledSatelliteTypes.has(sat.type)) return false;
        
        // Aggressive viewport culling for performance
        const lng = sat.position.lng;
        const lat = sat.position.lat;
        if (lng < expandedBounds.west || lng > expandedBounds.east || 
            lat < expandedBounds.south || lat > expandedBounds.north) {
          return false;
        }
        
        return true;
      })
      .map(sat => ({
        id: sat.id,
        position: sat.position,
        type: sat.type,
        dimensions: sat.dimensions,
        scaleFactor: sat.scaleFactor,
        isFollowed: this.followingSatellite === sat.id,
        hasImage: true
      }));
    
    // Apply LOD filtering with enhanced performance limits
    const viewport: ViewportInfo = { zoom, bounds };
    const filteredSatellites = this.lodManager.filterSatellitesForLOD(
      satellitesForLOD,
      viewport,
      performanceSkip,
      Math.min(maxSatellites, 1000) // Cap at 1000 points for performance
    );
    
    // Filter out satellites that should show as icons instead of circles
    const pointSatellites = filteredSatellites.filter(lodSat => {
      return !this.lodManager.shouldShowIcon(lodSat, zoom);
    });
    
    const points = pointSatellites
      .map(lodSat => {
        const sat = this.satellites.get(lodSat.id)!;
        const baseSize = this.lodManager.getCircleSize(lodSat, zoom, 2);
        
        const sizeMultiplier = this.followingSatellite === lodSat.id ? 
          this.trackedSatelliteSizeMultiplier : this.satelliteSizeMultiplier;
        const size = baseSize * sizeMultiplier;
        
        // Use smooth position for followed satellites, interpolated for others
        let smoothPos = null;
        if (this.followingSatellite === lodSat.id && this.smoothTracker.isTracking()) {
          smoothPos = this.smoothTracker.getPredictedPosition();
        } else {
          smoothPos = this.getSmoothSatellitePosition(lodSat.id);
        }
        
        const lng = smoothPos ? smoothPos.longitude : sat.position.lng;
        const lat = smoothPos ? smoothPos.latitude : sat.position.lat;
        const altitude = smoothPos ? smoothPos.altitude : sat.altitude;
        const velocity = smoothPos ? smoothPos.velocity : sat.velocity;
        
        const scaledAltitude = Math.sqrt(altitude) * 5000;
        
        return {
          position: [lng, lat, scaledAltitude] as [number, number, number],
          id: sat.id,
          name: sat.name,
          type: sat.type,
          altitude: altitude,
          velocity: velocity,
          length: sat.dimensions.length,
          color: this.getColorForType(sat.type),
          size
        };
      });
    
    // Update performance metrics
    this.performanceManager.setSatelliteCount(points.length);
    
    return points;
  }

  private generateSatelliteIconData(): any[] {
    // Ultra-fast path: if we only have ISS loaded and it has an icon, return it immediately
    if (this.satellites.size === 1 && this.followingSatellite) {
      const trackedSat = this.satellites.get(this.followingSatellite);
      if (trackedSat && trackedSat.position && this.satelliteIcons.has(this.followingSatellite)) {
        let position = trackedSat.position;
        let altitude = trackedSat.altitude;
        
        const smoothPos = this.smoothTracker.getPredictedPosition();
        if (smoothPos) {
          position = { lng: smoothPos.longitude, lat: smoothPos.latitude } as any;
          altitude = smoothPos.altitude;
        }
        
        const zoom = this.map.getZoom();
        const baseIconSize = this.getSatelliteImageSize(zoom, trackedSat.dimensions.width, this.followingSatellite, trackedSat.scaleFactor);
        const iconSize = baseIconSize * this.trackedSatelliteSizeMultiplier;
        
        return [{
          position: [position.lng, position.lat, altitude],
          icon: this.followingSatellite,
          size: iconSize,
          angle: 0,
          color: [255, 255, 255, 255]
        }];
      }
      return [];
    }
    
    // Fast path for single satellite tracking - only process tracked satellite
    if (this.followingSatellite && this.showTrackedSatelliteOnly) {
      const trackedSat = this.satellites.get(this.followingSatellite);
      if (trackedSat && trackedSat.position && this.satelliteIcons.has(this.followingSatellite)) {
        // Use smooth position if available
        let position = trackedSat.position;
        let altitude = trackedSat.altitude;
        
        const smoothPos = this.smoothTracker.getPredictedPosition();
        if (smoothPos) {
          position = { lng: smoothPos.longitude, lat: smoothPos.latitude } as any;
          altitude = smoothPos.altitude;
        }
        
        // Calculate proper size using scaleFactor and zoom
        const zoom = this.map.getZoom();
        const baseIconSize = this.getSatelliteImageSize(zoom, trackedSat.dimensions.width, this.followingSatellite, trackedSat.scaleFactor);
        const iconSize = baseIconSize * this.trackedSatelliteSizeMultiplier;
        
        return [{
          position: [position.lng, position.lat, altitude],
          icon: this.followingSatellite,
          size: iconSize,
          angle: 0,
          color: [255, 255, 255, 255]
        }];
      }
      return [];
    }

    const zoom = this.map.getZoom();
    const bounds = this.map.getBounds();
    const iconData: any[] = [];

    // Enhanced performance optimization: aggressive viewport culling for images
    const getViewportMargin = (zoom: number): number => {
      // Much tighter margins for high satellite counts
      if (zoom <= 2) return 30; // Smaller margin at very low zoom
      if (zoom <= 4) return 20; // Medium margin at low zoom
      if (zoom <= 6) return 10; // Small margin at medium zoom
      return 5; // Very tight margin at high zoom for max performance
    };

    const margin = getViewportMargin(zoom);
    const expandedBounds = {
      getWest: () => bounds.getWest() - margin,
      getEast: () => bounds.getEast() + margin,
      getSouth: () => bounds.getSouth() - margin/2,
      getNorth: () => bounds.getNorth() + margin/2
    };

    // Limit total icons rendered for performance
    const maxIconsToRender = zoom <= 4 ? 100 : 200;
    let iconCount = 0;

    // Generate icon data for satellites with loaded icons
    this.satelliteIcons.forEach((_, satelliteId) => {
      // Stop rendering icons if we hit the performance limit
      if (iconCount >= maxIconsToRender) {
        return;
      }
      
      const satellite = this.satellites.get(satelliteId);
      if (satellite && this.enabledSatelliteTypes.has(satellite.type)) { // Apply type filter
        // If showing only tracked satellite and we're tracking one, show only that
        if (this.followingSatellite && this.showTrackedSatelliteOnly && satelliteId !== this.followingSatellite) {
          return; // Skip all other satellites when tracking and showing only tracked
        }
        
        // Enhanced LOD for performance with high satellite counts
        let shouldShowIcon = false;
        if (this.followingSatellite === satelliteId) {
          shouldShowIcon = true; // Always show tracked satellite
        } else if (satelliteId === 'iss' || satelliteId.includes('iss')) {
          shouldShowIcon = true; // Always show ISS
        } else if (zoom >= 5) {
          shouldShowIcon = true; // Show all at high zoom
        } else if (zoom >= 4) {
          // At zoom 4, only show every 2nd satellite to improve performance
          const satelliteIndex = Array.from(this.satelliteIcons.keys()).indexOf(satelliteId);
          shouldShowIcon = satelliteIndex % 2 === 0;
        } else if (zoom >= 3) {
          // At zoom 3, only show every 4th satellite image for better performance
          const satelliteIndex = Array.from(this.satelliteIcons.keys()).indexOf(satelliteId);
          shouldShowIcon = satelliteIndex % 4 === 0;
        }
        
        // Aggressive viewport culling for performance
        const isInView = this.followingSatellite === satelliteId || 
                        satelliteId === 'iss' || 
                        this.isInBounds(satellite.position, expandedBounds);
        
        if (shouldShowIcon && isInView) {
          iconCount++;
          
          // Lazy load satellite image if it has one but isn't loaded yet
          if (satellite.image && !this.satelliteIcons.has(satelliteId) && !this.loadingIcons.has(satelliteId)) {
            this.loadSatelliteIconLazy(satelliteId, satellite.image);
          }
          
          const baseIconSize = this.getSatelliteImageSize(zoom, satellite.dimensions.width, satelliteId, satellite.scaleFactor);
          // Apply tracked satellite size multiplier if this is the followed satellite
          const sizeMultiplier = this.followingSatellite === satelliteId ? 
            this.trackedSatelliteSizeMultiplier : this.satelliteSizeMultiplier;
          const iconSize = baseIconSize * sizeMultiplier;
          
          // Use smooth position for followed satellites, interpolated for others
          let smoothPos = null;
          if (this.followingSatellite === satelliteId && this.smoothTracker.isTracking()) {
            // Use smooth tracker for followed satellite
            smoothPos = this.smoothTracker.getPredictedPosition();
          } else {
            // Use orbital interpolator for other satellites
            smoothPos = this.getSmoothSatellitePosition(satelliteId);
          }
          
          const lng = smoothPos ? smoothPos.longitude : satellite.position.lng;
          const lat = smoothPos ? smoothPos.latitude : satellite.position.lat;
          const altitude = smoothPos ? smoothPos.altitude : satellite.altitude;
          const velocity = smoothPos ? smoothPos.velocity : satellite.velocity;
            
          // Scale altitude for better visibility - high altitude satellites are too far to see
          const scaledAltitude = Math.sqrt(altitude) * 5000; // Square root scaling brings high satellites much closer
          
          const data = {
            position: [lng, lat, scaledAltitude], // Use scaled altitude in meters for deck.gl
            icon: satelliteId,
            size: iconSize,
            id: satellite.id,
            name: satellite.name,
            type: satellite.type,
            altitude: altitude, // Keep original altitude for display
            velocity: velocity
          };
          iconData.push(data);
        }
      } else {
      }
    });
    
    return iconData;
  }


  private getSatelliteImageSize(zoom: number, satelliteWidth: number, satelliteId: string, scaleFactor?: number): number {
    // Smart size scaling with performance caps
    const effectiveZoom = Math.max(zoom, 0.5);
    const isTracked = this.followingSatellite === satelliteId;
    
    let size: number;
    if (satelliteId === 'iss') {
      // ISS: More conservative scaling
      size = Math.min((effectiveZoom * satelliteWidth) / 3, 80); // Cap at 80px
    } else {
      // Others: Aggressive scaling but with performance caps
      if (zoom <= 6) {
        // Tracked satellite gets 10x multiplier, others get 2x multiplier
        const multiplier = isTracked ? 10 : 2;
        size = Math.min(effectiveZoom * satelliteWidth * multiplier, 120); // Cap at 120px
      } else {
        // At higher zoom, tracked satellites keep 10x multiplier, others get 3x multiplier
        const multiplier = isTracked ? 10 : 3;
        size = Math.min(effectiveZoom * satelliteWidth * multiplier, 200); // Higher zoom gets bigger, cap at 200px
      }
    }
    
    // Apply satellite-specific scale factor
    const finalScaleFactor = scaleFactor || 2.0;
    size *= finalScaleFactor;
    
    // Minimum size to ensure visibility
    return Math.max(size, 8);
  }

  private generateOrbitPaths(): any[] {
    if (!this.showOrbits) return [];
    
    // Fast path for single satellite tracking - only calculate orbit for tracked satellite
    if (this.followingSatellite && this.showTrackedSatelliteOnly) {
      const trackedSat = this.satellites.get(this.followingSatellite);
      if (trackedSat) {
        const orbitPoints = this.calculateOrbitPath(trackedSat);
        if (orbitPoints && orbitPoints.length > 0) {
          return [{
            path: orbitPoints,
            color: [255, 165, 0, 255] // Orange color for orbit path
          }];
        }
      }
      return [];
    }
    
    const orbitData: any[] = [];
    
    Array.from(this.satellites.values())
      .filter(sat => sat.type === 'scientific' || this.followingSatellite === sat.id)
      .forEach(sat => {
        // Generate orbit path points
        const orbitPoints = this.calculateOrbitPath(sat);
        
        // Create arc segments for the orbit
        for (let i = 0; i < orbitPoints.length - 1; i++) {
          orbitData.push({
            source: orbitPoints[i],
            target: orbitPoints[i + 1],
            color: this.getColorForType(sat.type),
            satelliteId: sat.id
          });
        }
      });
    
    return orbitData;
  }
  
  private calculateOrbitPath(sat: SatelliteData): [number, number][] {
    const points: [number, number][] = [];
    const numPoints = 64; // Number of points for orbit path
    
    try {
      const satrec = satellite.twoline2satrec(sat.tle1, sat.tle2);
      const now = new Date();
      
      // Generate points for one complete orbit (roughly 90-120 minutes)
      const orbitPeriod = 90 * 60 * 1000; // 90 minutes in milliseconds
      
      for (let i = 0; i < numPoints; i++) {
        const timeOffset = (i / numPoints) * orbitPeriod;
        const futureTime = new Date(now.getTime() + timeOffset);
        
        const positionAndVelocity = satellite.propagate(satrec, futureTime);
        if (positionAndVelocity.position && typeof positionAndVelocity.position !== 'boolean') {
          const gmst = satellite.gstime(futureTime);
          const positionGd = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
          
          const longitude = satellite.degreesLong(positionGd.longitude);
          const latitude = satellite.degreesLat(positionGd.latitude);
          
          points.push([longitude, latitude]);
        }
      }
    } catch (error) {
    }
    
    return points;
  }


  updateLayers(forceUpdate: boolean = false) {
    if (this.constellation) return; // drawn by the time-lapse frame loop
    const now = Date.now();
    const zoom = this.map.getZoom();
    const bounds = this.map.getBounds();
    
    // Ultra-fast updates for single satellite tracking (60fps)
    if (this.followingSatellite && this.showTrackedSatelliteOnly) {
      if (!forceUpdate && now - this.layerUpdateThrottle < 16) return; // 60fps
    } else {
      // Light throttling for force updates to prevent excessive rendering during map panning
      if (!forceUpdate) {
        // Throttle background updates more aggressively
        const zoomChanged = Math.abs(zoom - this.lastLayerUpdateZoom) > 0.3;
        const boundsChanged = !this.lastLayerUpdateBounds || 
          Math.abs(bounds.getCenter().lng - this.lastLayerUpdateBounds.getCenter().lng) > 0.1 ||
          Math.abs(bounds.getCenter().lat - this.lastLayerUpdateBounds.getCenter().lat) > 0.1;
        
        const shouldUpdate = now - this.layerUpdateThrottle > this.LAYER_UPDATE_THROTTLE || 
                            zoomChanged || boundsChanged;
        
        if (!shouldUpdate) return;
      } else {
        // Allow 30fps updates when tracking any satellite for smooth tracking
        if (this.followingSatellite) {
          // Allow 30fps updates for smooth tracking
          if (now - this.layerUpdateThrottle < 33) return;
        } else {
          // More aggressive throttling for force updates (10fps max)
          if (now - this.layerUpdateThrottle < 100) return;
        }
      }
    }
    
    this.layerUpdateThrottle = now;
    
    // Always update tracking variables for force updates
    this.lastLayerUpdateZoom = zoom;
    this.lastLayerUpdateBounds = bounds;

    const satellitePoints = this.generateSatellitePoints();
    const satelliteIconData = this.generateSatelliteIconData();
    const orbitPaths = this.generateOrbitPaths();

    const layers: any[] = [
      // Satellite points layer (excluding satellites with images)
      new ScatterplotLayer({
        id: 'satellites',
        data: satellitePoints,
        getPosition: (d: SatellitePointData) => d.position,
        getRadius: (d: SatellitePointData) => d.size,
        getFillColor: (d: SatellitePointData) => d.color,
        getLineColor: [255, 255, 255, 255],
        getLineWidth: 2,
        stroked: true,
        filled: true,
        radiusUnits: 'pixels',
        pickable: false
      })
    ];

    // Add icon layers for satellites with images (only for visible satellites)
    const visibleSatelliteIds = new Set(satelliteIconData.map(d => d.id || d.icon));
    
    // Special handling for tracked satellite when only showing tracked satellite
    if (this.followingSatellite && this.showTrackedSatelliteOnly && satelliteIconData.length > 0) {
      const trackedIconMapping = this.satelliteIcons.get(this.followingSatellite);
      
      if (trackedIconMapping) {
        layers.push(
          new IconLayer({
            id: `${this.followingSatellite}-icon`,
            data: satelliteIconData,
            pickable: false,
            iconAtlas: trackedIconMapping.atlas,
            iconMapping: trackedIconMapping.mapping,
            getIcon: (d: any) => d.icon,
            sizeScale: 1,
            getPosition: (d: any) => d.position,
            getSize: (d: any) => d.size,
            getColor: [255, 255, 255, 255]
          })
        );
      }
    } else {
      // Normal handling for multiple satellites
      this.satelliteIcons.forEach((iconMapping, satelliteId) => {
        if (visibleSatelliteIds.has(satelliteId)) {
          const satelliteData = satelliteIconData.filter(d => (d.id || d.icon) === satelliteId);
          if (satelliteData.length > 0) {
            layers.push(
              new IconLayer({
                id: `${satelliteId}-icon`,
                data: satelliteData,
                pickable: false,
                iconAtlas: iconMapping.atlas,
                iconMapping: iconMapping.mapping,
                getIcon: (d: any) => d.icon,
                sizeScale: 1,
                getPosition: (d: any) => d.position,
                getSize: (d: any) => d.size,
                getColor: [255, 255, 255, 255]
              })
            );
          }
        }
      });
    }

    // Add orbit paths layer
    if (orbitPaths.length > 0) {
      layers.push(
        new ArcLayer({
          id: 'orbit-paths',
          data: orbitPaths,
          getSourcePosition: (d: any) => d.source,
          getTargetPosition: (d: any) => d.target,
          getSourceColor: (d: any) => d.color,
          getTargetColor: (d: any) => d.color,
          getWidth: 2,
          pickable: false
        })
      );
    }

    this.deck.setProps({ layers });
  }

  private handleClick(info: any) {
    // Clicking empty areas does nothing (avoids loading all satellites at once).
    // In constellation view, a click on a satellite starts tracking it.
    if (this.constellation && this.constellationOverlay) {
      const hit: any = this.constellationOverlay.pickObject({ x: info.x, y: info.y, radius: 14 });
      if (hit?.object?.id) this.followSatellite(hit.object.id);
    }
  }


  followSatellite(satelliteId: string, preserveZoom: boolean = false, explicitZoom?: number) {
    this.clearConstellation();
    this.followingSatellite = satelliteId;
    // Reset tracked satellite size when following a new satellite
    this.trackedSatelliteSizeMultiplier = 1.0;
    // Always show only tracked satellite when tracking starts
    this.showTrackedSatelliteOnly = true;
    const satellite = this.satellites.get(satelliteId);
    
    // Load satellite image immediately when starting to follow it
    if (satellite?.image && !this.satelliteIcons.has(satelliteId)) {
      this.loadSatelliteIcon(satelliteId, satellite.image);
    }
    
    if (satellite) {
      
      // Stop all existing tracking to avoid interference
      this.stopSimpleTracking();
      this.smoothTracker.stopTracking();
      this.smoothCamera.stopSmoothTracking();
      
      // Calculate camera position to focus on satellite's 3D position at altitude
      const satelliteAltitudeKm = satellite.altitude;
      const satelliteLat = satellite.position.lat;
      const satelliteLng = satellite.position.lng;
      
      // Calculate offset to position camera so satellite appears centered
      // This simulates looking "at" the satellite rather than "up at" it
      const pitch = satellite.defaultPitch ?? DEFAULT_PITCH;
      const pitchRadians = pitch * Math.PI / 180;
      
      // Calculate how far back the camera needs to be to center the satellite
      // Using trigonometry: distance = altitude / tan(pitch)
      const horizontalDistanceKm = satelliteAltitudeKm / Math.tan(pitchRadians);
      
      // Convert distance to degrees (approximate)
      const latOffsetDegrees = horizontalDistanceKm / 111; // ~111 km per degree latitude
      
      // Position camera south of satellite (looking north up at it)
      const cameraLat = satelliteLat - latOffsetDegrees;
      const cameraLng = satelliteLng; // Same longitude
      
      // Calculate appropriate zoom for this altitude
      let adjustedZoom;
      if (explicitZoom !== undefined) {
        adjustedZoom = explicitZoom;
      } else if (preserveZoom) {
        adjustedZoom = this.map.getZoom();
      } else {
        adjustedZoom = satellite.defaultZoom ?? DEFAULT_ZOOM;
      }
      this.flightUntil = performance.now() + 2200; // keep deck from cancelling the flyTo with a stale zoom
      this.map.flyTo({
        center: [cameraLng, cameraLat],
        zoom: adjustedZoom,
        pitch, // Look up at satellite
        bearing: satellite.defaultBearing ?? 0, // Use satellite's default bearing or 0
        duration: 2000,
        essential: true
      });
      
      // Verify zoom after flyTo starts
      setTimeout(() => {
      }, 100);
      
      // Start smooth tracking once the 2s flyTo has finished (earlier, its jumpTo cancels the flight mid-way)
      setTimeout(() => {
        if (this.followingSatellite === satelliteId) this.startUltraSmoothTracking(satellite);
      }, 2100);
      
      this.showMessage(`Tracking ${displayName(satellite)}`, 'success');
      this.updateLayers(true); // Update layers to show orbit path if enabled
      
      // Notify about tracking change
      if (this.onTrackingChangeCallback) {
        this.onTrackingChangeCallback();
      }
    }
  }

  followSatelliteWithAnimation(satelliteId: string, targetZoom: number, targetPitch: number, targetBearing: number) {
    this.clearConstellation();
    this.followingSatellite = satelliteId;
    // Reset tracked satellite size when following a new satellite
    this.trackedSatelliteSizeMultiplier = 1.0;
    // Always show only tracked satellite when tracking starts
    this.showTrackedSatelliteOnly = true;
    const satellite = this.satellites.get(satelliteId);
    if (satellite) {
      // Stop all existing tracking to avoid interference
      this.stopSimpleTracking();
      this.smoothTracker.stopTracking();
      this.smoothCamera.stopSmoothTracking();
      
      // Reset bearing to automatic mode when starting new satellite tracking
      this.smoothCamera.setUserControlledBearing(false);
      
      // Calculate camera position to focus on satellite's 3D position at altitude
      const satelliteAltitudeKm = satellite.altitude;
      const satelliteLat = satellite.position.lat;
      const satelliteLng = satellite.position.lng;
      
      // Calculate offset to position camera so satellite appears centered
      const pitchRadians = targetPitch * Math.PI / 180;
      const horizontalDistanceKm = satelliteAltitudeKm / Math.tan(pitchRadians);
      const latOffsetDegrees = horizontalDistanceKm / 111;
      
      // Position camera to look at satellite
      const cameraLat = Math.max(-90, Math.min(90, satelliteLat - latOffsetDegrees));
      const cameraLng = satelliteLng;
      
      // Clamp zoom to valid range to prevent tile errors
      const validZoom = Math.max(0, Math.min(25, targetZoom));
      
      // Use map.flyTo with proper completion callback
      this.map.flyTo({
        center: [cameraLng, cameraLat],
        zoom: validZoom,
        pitch: targetPitch,
        bearing: targetBearing,
        duration: FLY_DURATION_MS,
        essential: true
      });
      
      // Start tracking when the flyTo ends. Ignore a 'moveend' from some earlier camera move that ends
      // mid-flight (it would start tracking and cancel the flyTo); a timer guarantees tracking starts anyway.
      const flyStart = performance.now();
      this.flightUntil = flyStart + FLY_DURATION_MS + 200;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.map.off('moveend', onFlyMoveEnd);
        this.startUltraSmoothTracking(satellite);
        
        // Notify about tracking change AFTER animation completes
        if (this.onTrackingChangeCallback) {
          this.onTrackingChangeCallback();
        }
      };
      const onFlyMoveEnd = () => {
        if (performance.now() - flyStart >= FLY_DURATION_MS - 100) finish();
      };
      
      this.map.on('moveend', onFlyMoveEnd);
      setTimeout(finish, FLY_DURATION_MS + 300);
      
      this.showMessage(`Tracking ${displayName(satellite)}`, 'success');
      this.updateLayers(true); // Update layers to show orbit path if enabled
    }
  }

  stopFollowing() {
    // Don't clear followingSatellite - keep it for display but stop camera tracking
    // Keep showing only the current satellite to prevent performance issues  
    this.showTrackedSatelliteOnly = true;
    
    // Only stop camera tracking, keep satellite position updates running
    this.smoothCamera.stopSmoothTracking();
    
    // Don't stop smoothTracker or stopSimpleTracking - let satellite continue its orbit
    // this.smoothTracker.stopTracking();
    // this.stopSimpleTracking();
    
    this.updateLayers();
    
    // Notify about tracking change
    if (this.onTrackingChangeCallback) {
      this.onTrackingChangeCallback();
    }
    
    // Call the stop following callback if set
    if (this.onStopFollowingCallback) {
      this.onStopFollowingCallback();
    }
  }


  private stopSimpleTracking() {
    if (this.trackingInterval) {
      cancelAnimationFrame(this.trackingInterval);
      this.trackingInterval = null;
    }
  }

  // Start ultra-smooth tracking for video-like performance
  private startUltraSmoothTracking(satellite: SatelliteData) {
    
    // Stop any existing tracking
    this.stopSimpleTracking();
    this.smoothTracker.stopTracking();
    this.smoothCamera.stopSmoothTracking();
    
    // Apply 30fps smooth tracking for all satellites
    
    // Create smooth tracker with callback to update satellite data and camera
    const smoothTracker = new SmoothTracker((position: PredictivePosition) => {
      // Update the main satellite data with smooth position
      const sat = this.satellites.get(satellite.id);
      if (sat) {
        sat.position = new LngLat(position.longitude, position.latitude);
        sat.altitude = position.altitude;
        sat.velocity = position.velocity;
      }
      
      // Update smooth camera
      this.smoothCamera.updateTargetPosition(position);
    });
    
    this.smoothTracker = smoothTracker;
    
    // Start the smooth tracker with satellite TLE data
    this.smoothTracker.startTracking(satellite.id, satellite.tle1, satellite.tle2);
    
    // Get initial position and start smooth camera tracking
    const initialPosition = this.smoothTracker.getPredictedPosition();
    if (initialPosition) {
      this.smoothCamera.startSmoothTracking(initialPosition);
    }  }


  // Get smooth interpolated position for a satellite
  private getSmoothSatellitePosition(satelliteId: string) {
    const now = Date.now();
    return this.orbitalInterpolator.getInterpolatedPosition(satelliteId, now);
  }


  toggleOrbits() {
    this.showOrbits = !this.showOrbits;
    this.updateLayers();
    this.showMessage(this.showOrbits ? '🛰️ Orbits shown' : '🛰️ Orbits hidden', 'info');
  }


  togglePause() {
    this.isPaused = !this.isPaused;
    this.showMessage(this.isPaused ? '⏸️ Satellite updates paused' : '▶️ Satellite updates resumed', 'info');
    return this.isPaused;
  }

  getFollowingSatellite(): string | null {
    return this.followingSatellite;
  }


  private showMessage(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    const messageDiv = document.createElement('div');
    messageDiv.className = `toast toast-${type}`;
    messageDiv.textContent = message;
    document.body.appendChild(messageDiv);
    
    setTimeout(() => {
      messageDiv.remove();
    }, 3000);
  }


  private processSatelliteUpdates(bounds: any, zoom: number, now: number, lastFullUpdate: number, FULL_UPDATE_INTERVAL: number, UPDATE_INTERVAL: number) {
    // Fast path for single satellite tracking - skip all other satellite updates
    if (this.followingSatellite && this.showTrackedSatelliteOnly) {
      // Only the smooth tracker needs to update the tracked satellite
      // Skip all other expensive operations
      return;
    }
    
    // Skip position updates for tracked satellite - smooth tracking handles it
    // Only update other satellites for rendering
    
    // Use main thread calculations (worker disabled)
    this.processSatelliteUpdatesMainThread(bounds, zoom, now, lastFullUpdate, FULL_UPDATE_INTERVAL, UPDATE_INTERVAL);
  }

  private processSatelliteUpdatesMainThread(bounds: any, zoom: number, now: number, lastFullUpdate: number, FULL_UPDATE_INTERVAL: number, UPDATE_INTERVAL: number) {
    // Fallback method using main thread
    let updatedCount = 0;
    let satelliteIndex = 0;
    const isFullUpdate = now - lastFullUpdate >= FULL_UPDATE_INTERVAL;
    
    // Skip followed satellite - smooth tracking handles it completely
    // The ultra-smooth tracking system will update the followed satellite at 30fps
    
    for (const [id, sat] of this.satellites) {
      // Skip followed satellite since we updated it above
      const shouldUpdate = (this.followingSatellite !== id) && (
                          isFullUpdate ||
                          (zoom >= 3 && this.isInBounds(sat.position, bounds)));
      
      if (isFullUpdate && this.followingSatellite !== id) {
        const frameOffset = Math.floor(now / UPDATE_INTERVAL) % 30;
        if (satelliteIndex % 30 !== frameOffset) {
          satelliteIndex++;
          continue;
        }
      }
      
      if (shouldUpdate) {
        const position = this.calculateSatellitePosition(sat.tle1, sat.tle2, sat.id);
        sat.position = new LngLat(position.longitude, position.latitude);
        sat.altitude = position.altitude;
        sat.velocity = position.velocity;
        updatedCount++;
      }
      satelliteIndex++;
    }
    
    this.updateLayers();
    // Only log occasionally to avoid spam
    if (Math.random() < 0.02) { // 2% chance
      // Satellites updated
    }
  }

  // Background satellite position updates (separate from camera tracking)
  startBackgroundUpdates() {
    let lastUpdate = 0;
    let lastFullUpdate = 0;
    
    const FULL_UPDATE_INTERVAL = 1000; // 1fps for background updates
    
    const updatePositions = () => {
      const now = Date.now();
      
      // Fast path for single satellite tracking - minimal updates
      if (this.followingSatellite && this.showTrackedSatelliteOnly && this.satellites.size === 1) {
        // Only run minimal update loop for single satellite at 30fps
        if (!this.isPaused && now - lastUpdate >= 33) { // 30fps for single satellite
          const trackedSat = this.satellites.get(this.followingSatellite);
          if (trackedSat && trackedSat.tle1 && trackedSat.tle2) {
            // Update just this one satellite's position
            const newPosition = this.calculateSatellitePosition(trackedSat.tle1, trackedSat.tle2, trackedSat.id);
            if (!isNaN(newPosition.longitude) && !isNaN(newPosition.latitude) && !isNaN(newPosition.altitude)) {
              trackedSat.position = new LngLat(newPosition.longitude, newPosition.latitude);
              trackedSat.altitude = newPosition.altitude;
              trackedSat.velocity = newPosition.velocity;
              
              // Update layers only when position actually changes
              this.updateLayers();
            }
          }
          lastUpdate = now;
        }
        this.animationId = requestAnimationFrame(updatePositions);
        return;
      }
      
      // Update performance monitoring
      this.performanceManager.updateFrameRate();
      
      // Skip position updates if paused, but continue the animation loop
      const UPDATE_INTERVAL = this.performanceManager.getUpdateInterval();
      if (!this.isPaused && now - lastUpdate >= UPDATE_INTERVAL) {
        // Get current map view bounds for performance optimization
        const bounds = this.map.getBounds();
        const zoom = this.map.getZoom();
        
        // Update satellite positions (but not camera - that's handled by smooth tracking)
        this.processSatelliteUpdates(bounds, zoom, now, lastFullUpdate, FULL_UPDATE_INTERVAL, UPDATE_INTERVAL);

        if (now - lastFullUpdate >= FULL_UPDATE_INTERVAL) {
          lastFullUpdate = now;
        }

        lastUpdate = now;
      }
      
      // Cleanup interpolator data periodically (every 60 seconds)
      if (now % 60000 < UPDATE_INTERVAL) {
        this.orbitalInterpolator.cleanup();
      }
      
      this.animationId = requestAnimationFrame(updatePositions);
    };

    updatePositions();
  }

  private isInBounds(position: LngLat, bounds: any): boolean {
    return position.lng >= bounds.getWest() && 
           position.lng <= bounds.getEast() && 
           position.lat >= bounds.getSouth() && 
           position.lat <= bounds.getNorth();
  }


  // updateFollowing removed - handled by ultra-smooth tracking system

  private setupSearchFunctionality() {
    const searchInput = document.getElementById('satellite-search') as HTMLInputElement;
    const searchResults = document.getElementById('search-results') as HTMLDivElement;
    
    if (!searchInput || !searchResults) {
      return;
    }
        
    searchInput.addEventListener('input', async (e) => {
      const query = (e.target as HTMLInputElement).value.toLowerCase().trim();
      await this.performSearch(query, searchResults);
    });
    
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target as Node) && !searchResults.contains(e.target as Node)) {
        searchResults.innerHTML = '';
      }
    });
  }
  
  private async performSearch(query: string, resultsContainer: HTMLDivElement) {
    resultsContainer.innerHTML = '';
    
    if (query.length < 2) return;
    
    // Show loading indicator
    resultsContainer.innerHTML = '<div style="padding: 8px; color: #999;">Searching satellites...</div>';
    
    try {
      // Load all satellites for search if not already loaded
      await this.loadAllSatellitesForSearch();
      
      // Clear loading indicator
      resultsContainer.innerHTML = '';
      
    } catch (error) {
      // If loading fails, show error and use any cached data
      console.warn('Failed to load all satellites for search:', error);
      resultsContainer.innerHTML = '<div style="padding: 8px; color: #ff9999;">Failed to load satellite database</div>';
      return;
    }
    
    // Search in the full satellite database (not just active satellites)
    console.log(`🔍 Searching ${this.searchSatelliteDatabase.size} satellites for "${query}"`);
    console.log(`🔍 Active satellites: ${this.satellites.size}`);
    console.log(`🔍 Search database loaded: ${this.searchSatellitesLoaded}`);
    
    // Debug: Show some sample satellites from search database
    const sampleFromSearch = Array.from(this.searchSatelliteDatabase.values()).slice(0, 5);
    console.log(`🔍 Sample from search database:`, sampleFromSearch.map(sat => sat.name || sat.id));
    
    // Debug: If search database is empty, fall back to active satellites
    const databaseToSearch = this.searchSatelliteDatabase.size > 0 ? this.searchSatelliteDatabase : this.satellites;
    console.log(`🔍 Using ${databaseToSearch === this.searchSatelliteDatabase ? 'search database' : 'active satellites'} with ${databaseToSearch.size} entries`);
    
    // Let's search for the query in a few different ways for debugging
    console.log(`🔍 Searching for "${query}" in satellite names...`);
    let foundCount = 0;
    const matches: any[] = [];
    
    for (const satellite of databaseToSearch.values()) {
      // Apply search filter only - no type filtering
      const name = (satellite.name || satellite.id).toLowerCase();
      const id = satellite.id.toLowerCase();
      const type = satellite.type.toLowerCase();
      const altName = (satellite.alternateName || '').toLowerCase();
      
      const nameMatch = name.includes(query);
      const idMatch = id.includes(query);
      const typeMatch = type.includes(query);
      const altNameMatch = altName.includes(query);
      
      const isMatch = nameMatch || idMatch || typeMatch || altNameMatch;
      
      if (isMatch) {
        foundCount++;
        if (foundCount <= 20) { // Only add first 20 to results
          matches.push(satellite);
        }
        if (foundCount <= 5) { // Log first 5 matches for debugging
          console.log(`🔍 Match ${foundCount}: ${satellite.name || satellite.id} (ID: ${satellite.id}, Type: ${satellite.type})`);
        }
      }
      
      // Stop after checking a reasonable number if we have enough matches
      if (foundCount >= 50) break;
    }
    
    console.log(`🔍 Found ${foundCount} total matches for "${query}", showing first ${Math.min(foundCount, 20)}`);
      
    if (matches.length === 0) {
      resultsContainer.innerHTML = '<div style="padding: 8px; color: #999;">No satellites found</div>';
      return;
    }
    
    // Sort the matches alphabetically
    matches.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    
    matches.forEach(satellite => {
      const resultDiv = document.createElement('div');
      resultDiv.className = 'search-result';
      if (this.followingSatellite === satellite.id) {
        resultDiv.className += ' following';
      }
      
      resultDiv.innerHTML = `
        <div><strong>${satellite.name || satellite.id}</strong></div>
        <div style="font-size: 11px; color: #ccc;">
          ${satellite.type} | ${satellite.dimensions.length}×${satellite.dimensions.width}×${satellite.dimensions.height}m | Alt: ${satellite.altitude.toFixed(0)}km
        </div>
        <div style="font-size: 10px; color: #aaa;">
          ${satellite.position.lat.toFixed(2)}°, ${satellite.position.lng.toFixed(2)}°
        </div>
      `;
      
      resultDiv.addEventListener('click', () => {
        // Load the selected satellite from search database into active satellites
        this.loadSatelliteFromSearchDatabase(satellite.id);
        this.followSatellite(satellite.id);
        resultsContainer.innerHTML = '';
        (document.getElementById('satellite-search') as HTMLInputElement).value = satellite.name || satellite.id;
        
        // Close the search dropdown
        const searchContent = document.getElementById('search-content');
        const satelliteStatus = document.querySelector('.status-item.satellite[data-section="search"]');
        if (searchContent && satelliteStatus) {
          searchContent.classList.remove('active');
          satelliteStatus.classList.remove('active');
        }
      });
      
      resultsContainer.appendChild(resultDiv);
    });
    
    if (matches.length === 0 && query.length >= 2) {
      resultsContainer.innerHTML = '<div style="padding: 8px; color: #999;">No satellites found</div>';
    }
  }

  

  getSatellites(): Map<string, SatelliteData> {
    return this.satellites;
  }

  getSmoothCamera(): SmoothCamera {
    return this.smoothCamera;
  }

  getSearchDatabase(): Map<string, SatelliteData> {
    return this.searchSatelliteDatabase;
  }

  getSatelliteConfigs() {
    return SATELLITE_CONFIGS_WITH_STARLINK;
  }

  // Satellite type filtering methods
  setSatelliteTypeEnabled(type: string, enabled: boolean) {
    if (enabled) {
      this.enabledSatelliteTypes.add(type);
    } else {
      this.enabledSatelliteTypes.delete(type);
    }
    this.updateLayers(); // Refresh display
  }

  isSatelliteTypeEnabled(type: string): boolean {
    return this.enabledSatelliteTypes.has(type);
  }

  getEnabledSatelliteTypes(): Set<string> {
    return new Set(this.enabledSatelliteTypes);
  }
  
  // Tracked satellite only filter methods
  setShowTrackedSatelliteOnly(enabled: boolean) {
    this.showTrackedSatelliteOnly = enabled;
    this.updateLayers(); // Refresh display
  }
  
  getShowTrackedSatelliteOnly(): boolean {
    return this.showTrackedSatelliteOnly;
  }


  // Get satellite counts by type
  getSatelliteCountsByType(): Record<string, number> {
    const counts: Record<string, number> = {
      'scientific': 0,
      'communication': 0,
      'earth-observation': 0,
      'weather': 0,
      'navigation': 0
    };

    for (const satellite of this.satellites.values()) {
      if (counts.hasOwnProperty(satellite.type)) {
        counts[satellite.type]++;
      }
    }

    return counts;
  }

  // Satellite size control methods
  increaseSatelliteSize() {
    if (this.followingSatellite) {
      this.trackedSatelliteSizeMultiplier = Math.min(this.trackedSatelliteSizeMultiplier * 1.25, this.MAX_SIZE_MULTIPLIER);
      this.updateLayers(true);
      const satellite = this.satellites.get(this.followingSatellite);
      this.showMessage(`🔍 ${satellite?.name || 'Tracked satellite'} size: ${(this.trackedSatelliteSizeMultiplier * 100).toFixed(0)}%`, 'info');
    } else {
      this.showMessage(`🎯 Track a satellite first to resize it (search and click)`, 'warning');
    }
  }

  decreaseSatelliteSize() {
    if (this.followingSatellite) {
      this.trackedSatelliteSizeMultiplier = Math.max(this.trackedSatelliteSizeMultiplier / 1.25, this.MIN_SIZE_MULTIPLIER);
      this.updateLayers(true);
      const satellite = this.satellites.get(this.followingSatellite);
      this.showMessage(`🔍 ${satellite?.name || 'Tracked satellite'} size: ${(this.trackedSatelliteSizeMultiplier * 100).toFixed(0)}%`, 'info');
    } else {
      this.showMessage(`🎯 Track a satellite first to resize it (search and click)`, 'warning');
    }
  }

  resetSatelliteSize() {
    if (this.followingSatellite) {
      this.trackedSatelliteSizeMultiplier = 1.0;
      this.updateLayers(true);
      const satellite = this.satellites.get(this.followingSatellite);
      this.showMessage(`🔍 ${satellite?.name || 'Tracked satellite'} size reset to 100%`, 'info');
    } else {
      this.showMessage(`🎯 Track a satellite first to resize it (search and click)`, 'warning');
    }
  }

  getSatelliteSizeMultiplier(): number {
    return this.satelliteSizeMultiplier;
  }

  private setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Only respond to shortcuts if no input elements are focused
      if (document.activeElement?.tagName === 'INPUT') {
        return;
      }


      switch (e.key) {
        case 'ArrowUp':
          if (e.shiftKey) {
            e.preventDefault();
            this.increaseSatelliteSize();
          }
          break;
        
        case 'ArrowDown':
          if (e.shiftKey) {
            e.preventDefault();
            this.decreaseSatelliteSize();
          }
          break;
        
        case 'r':
        case 'R':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this.resetSatelliteSize();
          }
          break;
        
        case 'c':
        case 'C':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this.toggleCockpit();
          }
          break;
        
        case 'h':
        case 'H':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            this.showKeyboardHelp();
          }
          break;
      }
    });

    // Keyboard shortcuts enabled
  }

  private showKeyboardHelp() {
    const helpText = `
🔧 TRACKED SATELLITE SIZE SHORTCUTS:

Shift+↑    Increase tracked satellite size
Shift+↓    Decrease tracked satellite size  
R          Reset tracked satellite to normal size

🎛️ INTERFACE CONTROLS:
C          Hide/show cockpit
G          Toggle Globe/Mercator projection
H          Show this help

📍 CAMERA CONTROLS:
Ctrl+Drag  Adjust pitch angle
Click      Select/follow satellite
+/-        Zoom map (normal behavior)

📡 NOTE: First track a satellite (search & click) to resize it!
    `;

    const helpDiv = document.createElement('div');
    helpDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 3000;
      padding: 20px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.95);
      color: white;
      font-family: 'Inter', monospace;
      font-size: 13px;
      white-space: pre-line;
      border: 2px solid #00d4ff;
      box-shadow: 0 10px 30px rgba(0, 212, 255, 0.3);
      max-width: 300px;
      text-align: left;
    `;

    helpDiv.textContent = helpText;
    document.body.appendChild(helpDiv);

    // Remove help after 5 seconds or on click
    const removeHelp = () => helpDiv.remove();
    setTimeout(removeHelp, 5000);
    helpDiv.addEventListener('click', removeHelp);
  }

  private setupCockpitToggle() {
    const showButton = document.getElementById('show-cockpit-btn');
    
    if (showButton) {
      showButton.addEventListener('click', () => {
        this.toggleCockpit();
      });
    }
  }

  toggleCockpit() {
    this.isCockpitVisible = !this.isCockpitVisible;
    const cockpitPanel = document.getElementById('cockpit-panel');
    const showButton = document.getElementById('show-cockpit-btn');
    
    if (cockpitPanel && showButton) {
      if (this.isCockpitVisible) {
        cockpitPanel.classList.remove('hidden');
        showButton.style.display = 'none';
        this.showMessage('🎛️ Mission Control active', 'info');
      } else {
        cockpitPanel.classList.add('hidden');
        showButton.style.display = 'flex';
        this.showMessage('🎛️ Mission Control hidden - Press C to show', 'info');
      }
    }
  }

  isCockpitHidden(): boolean {
    return !this.isCockpitVisible;
  }

  // Get ultra-smooth tracking quality (0-1, where 1 is perfect)
  getTrackingQuality(): number {
    return this.smoothTracker.getTrackingQuality();
  }

  // Check if ultra-smooth tracking is active
  isUltraSmoothTracking(): boolean {
    return this.smoothTracker.isTracking() && this.smoothCamera.isTracking();
  }

  stop() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    if (this.satelliteWorker) {
      this.satelliteWorker.terminate();
      this.satelliteWorker = null;
    }
    if (this.deck) {
      this.deck.finalize();
    }
  }
}

// Longitude shifted by whole turns to be within 180° of the previous one, so a path stays continuous across ±180
function unwrapLng(lng: number, prev?: number): number {
  return prev === undefined ? lng : lng + 360 * Math.round((prev - lng) / 360);
}

// Initial bearing (deg) from a to b ([lng, lat] in degrees)
function bearingDeg(a: number[], b: number[]): number {
  const r = Math.PI / 180, dl = (b[0] - a[0]) * r;
  return Math.atan2(Math.sin(dl) * Math.cos(b[1] * r), Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos(dl)) / r;
}

// Point `km` from [lng, lat] along `bearing` (deg), on a spherical Earth; keeps lng continuous with the input
function offsetPoint(lng: number, lat: number, bearing: number, km: number): [number, number] {
  const r = Math.PI / 180, d = km / 6371, br = bearing * r, la = lat * r;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lo2 = lng * r + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [lo2 / r, la2 / r];
}
