import { Deck } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, IconLayer, ArcLayer, TextLayer, LineLayer, SolidPolygonLayer, PathLayer } from '@deck.gl/layers';
import { Map as MapLibreMap, LngLat } from 'maplibre-gl';
import * as satellite from 'satellite.js';
import { SATELLITE_CONFIGS_WITH_STARLINK, Constellation, constellationOf } from './config/satellites';
import type { SatelliteConfig } from './types/satellite';
import { displayName } from './types/satellite';
import { DataFilterExtension, DataFilterExtensionProps } from '@deck.gl/extensions';
import { SatelliteDataFetcher } from './satellite-data-fetcher';
import { SolarCalculator } from './utils/solar-calculator';
import { settings, SPEEDS } from './settings';
import { PerformanceManager } from './performance-manager';
import { LODManager, ViewportInfo, SatelliteForLOD } from './lod-manager';
import { OrbitalInterpolator, SatellitePosition } from './orbital-interpolator';
import { SmoothTracker, PredictivePosition, predictPosition } from './smooth-tracker';
import { prefetchAround } from './tile-prefetch';
import { stripCells, coveredShare } from './coverage';
import { HorizonExtension } from './horizon-extension';
import { SmoothCamera, framing } from './smooth-camera';

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
  defaultBearing?: number; // camera bearing when tracking it, relative to its heading (deg, + to the right; 0: straight behind)
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
// The tracking view's names on a dark chip, as the constellation view's: plain white vanished over a desert or ice
// (an SDF outline instead looked blurred)
const LABEL_CHIP = { background: true, getBackgroundColor: [8, 14, 24, 150] as [number, number, number, number], backgroundPadding: [8, 3] as [number, number], backgroundBorderRadius: 8 };
const SIBLING_MARKS_MAX = 16; // a tracked imager's mates drawn with swath, cone and picture up to this many (else dots)
const SIBLING_SWATH = 0.4; // a mate's swath, relative to the tracked one's
const SIBLING_MIN_SCALE = 0.6; // a mate's picture: in perspective with the tracked one, at most its size, never below this of it
const DEFAULT_ZOOM = 4.7; // default camera when tracking a satellite
const DEFAULT_PITCH = 62;
// Samples per orbit ring. Dense on purpose: near the poles longitude changes fast, and a coarse polyline drawn in lng/lat
// swings out into a visible loop around the pole.
const RING_N = 480;
const TRACK_SAMPLE_MS = 10000;      // ground track sampled every 10 simulated seconds (75 km)...
const TRACK_CHUNK_MS = 30 * 60e3;   // ...computed ahead in 30 min chunks; the GPU fades and cuts it at the current time
const TRACK_FADE_MS = 90 * 60e3;     // past swaths fade out over ~1 orbit: older passes have drifted away from the
                                    // orbit with the turning Earth and read as swaths with no satellite over them
// Coverage: swaths of the last 90 min (fading), or of the last 6, 12 or 24 h (all kept, to see how much is imaged).
// ponytail: a 24 h window keeps every quad in memory; fine for tens of satellites, heavy for hundreds (SuperDoves).
const COVER_WINDOWS_MS = [TRACK_FADE_MS, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
// Ground features float this far above the surface: a straight segment between two samples sags below the curved
// globe (and below MapLibre's coarse low-zoom globe mesh), which drew the swath as a dashed sawtooth.
const GROUND_LIFT_M = 8000;
// Satellites switch from drawn-on-top to depth-tested while the line of sight to them grazes the Earth this close (in
// Earth radii: 0.02 = 127 km above the surface), just before it is blocked
const LIMB_GRAZE = 0.02;
// Mega-constellations (Starlink): from this many satellites, no labels or per-satellite glow, satellites as fine points
// coloured by shell (inclination family) on their planes' rings, a plane lit up on hover
const DENSE_MIN = 1000;
const DENSE_RING_N = 96;
const SHELL_COLORS = [[79, 209, 255], [255, 179, 71], [255, 112, 168], [184, 140, 255], [126, 224, 161], [255, 224, 102]]; // biggest shell first
// Sensor cone from each satellite to both ends of its scan line, in bands fading toward the ground
const CONE_ALPHA = [70, 50, 34, 22];
const LABEL_LIFT_PX = 24; // satellite labels sit this far above their dot
// Optical imagers only image the day side (SAR and thermal ones: night too): where the sun is at least this high at the
// nadir. The constellation view draws the swath everywhere but counts only those passes as covered.
// ponytail: fixed threshold and nadir-only swath; off-nadir pointing (which can fill gaps) isn't modelled.
const MIN_SUN_ELEV_DEG = 10;
const TRACKED_PAST_MS = 20 * 60e3;  // tracking view: ground track drawn 20 min behind the satellite...
const TRACKED_AHEAD_MS = 20 * 60e3; // ...and 20 min ahead
const TRACKED_ICON_SCALE = 0.5;
const DARK_SWATH = 0.3;              // swath opacity where the ground is dark (no imaging), relative to lit
const SCAN_ARC_N = 24;
const SWATH_ACROSS_N = 8;           // wide swaths: 8 quads across, so the strip follows the Earth's curvature              // scan line / cone foot: 24 steps across the swath     // tracked satellite picture, relative to getSatelliteImageSize
const SCAN_MS = 4 * 60e3; // the lit footprint under each satellite covers its last 4 simulated minutes
const AGE_FILTER = new DataFilterExtension({ filterSize: 1 }); // swath quads cut at the current time and faded by age on the GPU
const HORIZON = new HorizonExtension(); // ground features: not from behind the Earth

type Quad = { polygon: number[]; t: number }; // a swath quad and when it is imaged (s since tlTrackBase)

export class DeckSatelliteTracker {
  private constellation: string[] | null = null; // member ids while viewing a constellation overview
  // The main deck canvas is a flat (Mercator) overlay, which can't sit correctly on the globe at whole-Earth zoom.
  // The constellation is drawn by a MapboxOverlay instead: it renders inside MapLibre's own globe, in metres, at real altitude.
  private constellationOverlay?: MapboxOverlay;
  private constellationColor: [number, number, number] = [0, 214, 255];
  private constellationSwathKm = 0;
  private constellationNight = false; // SAR and thermal imagers image day and night: no daylight cut on its swaths
  private constellationOrbitR = 1; // highest member's orbit radius, in Earth radii
  private constellationName = '';
  // Constellation time-lapse. The camera is fixed in INERTIAL space (looking along the orbit normal), so the Earth visibly
  // turns under the orbit ring while satellites run round it and paint their ground tracks / swaths onto the surface.
  private tlRaf = 0;
  private tlLast = 0;
  private tlSim = 0;            // simulated time, ms since epoch
  private tlT0 = 0;             // simulated time the orbit rings/tracks were anchored at
  private tlGmst = 0;           // Earth rotation angle (rad) at the previous frame
  private tlGmst0 = 0;          // ... at tlT0
  private tlPlaying = true;
  private tlSpeed = settings.speed;
  private tlRings: Array<{ id: string; pts: number[][]; segs: Array<{ a: number[]; b: number[]; c?: number[] }>; inc: number }> = [];
  private tlRingSegs: Array<{ a: number[]; b: number[]; c?: number[] }> = [];
  // A mega-constellation (DENSE_MIN): SGP4 records, positions (two buffers swapped every frame so deck sees new data),
  // colour per satellite, its plane (index in tlRings), and the shells for the legend
  private dense: { recs: any[]; pos: Float64Array[]; flip: number; colors: Uint8Array; plane: Int32Array;
    shells: Array<{ inc: number; color: number[]; n: number }> } | null = null;
  private tlHover = -1; // dense: the satellite under the pointer...
  private tlPinned = -1; // ...and the one clicked: its plane stays lit
  // Ground track per satellite: sub-satellite points (lng unwrapped so a path never jumps across ±180, which on the
  // globe is the same place) and the simulated time of each
  // Swaths in 30 min chunks: rows across each ground track every 10 s (per satellite, with whether it images there) and
  // the quads between lit rows. t: when the satellite reaches the quad's far row, in s since tlTrackBase (float32 on the
  // GPU, so not ms since epoch).
  // ponytail: float32 seconds stay sub-second for ~3 months of simulated time (~20 h at x100); re-base at the daily
  // re-anchor if anyone runs it longer.
  private tlChunks: Array<{ start: number; end: number; rows: Array<Array<{ row: number[][]; lit: boolean }>>; quads: Quad[]; cells: number[]; ts: number[] }> = [];
  private tlTrackBase = 0;
  private tlTrackEnd = 0;
  private tlWindowMs = TRACK_FADE_MS; // swaths shown over this past window (COVER_WINDOWS_MS)
  private coverAt = 0;  // simulated time the tracks are computed up to
  private tlScanArcs: number[][][] = []; // scan line across the track under each satellite, along the ground
  private tlHeads: number[][] = []; // swath quads from each satellite's last track row up to its scan line
  // Satellite markers: ONE array, updated in place every frame. A new data array per frame made deck rebuild the
  // labels' per-character GPU buffers 60 times a second, which piled up into 10-15 s GPU stalls.
  // label: the label's opacity, eased toward 0 while a nearer satellite's label overlaps it on screen
  private tlDots: Array<{ id: string; name: string; position: number[]; alpha: number; dist: number; label: number }> = [];
  private tlFrame = 0;
  private tlHeavyAt = 0;
  private tlVersion = 0;
  private nightTimeSetter?: (t: number | null) => void;
  private constellationLayers: any[] = [];
  private siblings = { of: '', ids: [] as string[] }; // the tracked satellite's constellation mates, drawn around it
  private swarm: { layers: any[]; t0: number } | null = null; // the constellation left behind, fading out as tracking flies in
  // Tracking view clock: live, or a time-lapse anchored at (trackSimT0 simulated, trackRealT0 performance.now)
  private trackLive = true;
  private trackSpeed = 1;
  private trackPaused = false;
  private clockUiAt = 0;
  private trackSimT0 = 0;
  private trackRealT0 = 0;
  private trackedOnGlobe = false; // the tracked satellite is drawn by the globe overlay (real altitude, ground track)
  private trackedPaths = new Map<string, { base: number; end: number; line: number[]; light: number[]; heading: number[] }>(); // ponytail: never pruned, a few KB per satellite tracked or drawn
  private mapHeight = 0; // map container height, cached: reading clientHeight every frame forced a layout
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
    this.installTimeControls();
  }


  setOnTrackingChangeCallback(callback: () => void) {
    this.onTrackingChangeCallback = callback;
  }

  setOnSatellitesLoadedCallback(callback: () => void) {
    this.onSatellitesLoadedCallback = callback;
  }

  private onStopFollowingCallback?: () => void;


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
      _typedArrayManagerProps: {
        overAlloc: 1,
        poolSize: 0
      }
    });

    // Add aggressive pitch override after initialization
    setTimeout(() => {
      this.setupAggressivePitchOverride();
    }, 500);

    const measure = () => { this.mapHeight = this.map.getContainer().clientHeight; };
    measure();
    this.map.on('resize', measure);

    // Sync deck.gl view with MapLibre
    const syncView = () => {
      if (this.constellation) return; // this overlay is empty then (the globe overlay draws): don't redraw it
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

  // Clear all satellites except ISS
  clearAllSatellitesExceptISS() {
    const issData = this.satellites.get('iss-zarya');
    this.satellites.clear();
    if (issData) {
      this.satellites.set('iss-zarya', issData);
    }
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
      // In constellation view a click on a satellite starts tracking it (elsewhere clicks do nothing: that would load
      // the whole catalogue)
      this.constellationOverlay = new MapboxOverlay({
        interleaved: true, layers: [], pickingRadius: 14,
        // Clear the stencil the swaths paint each pixel once with (MapLibre's tile masks are done with by now: the
        // overlay draws last)
        onBeforeRender: ({ gl }) => { gl.stencilMask(0xff); gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT); },
        onClick: info => {
          if (this.dense) this.tlPinned = info.layer?.id === 'constellation-dense' ? info.index : -1; // shows its plane: no tracking
          else if (this.constellation && info.object?.id) this.followSatellite(info.object.id);
          else if (info.layer?.id.startsWith('tracked-siblings') && info.object?.id) this.followSatellite(info.object.id, true); // a mate: switch to it
        },
        onHover: info => { this.tlHover = this.dense && info.layer?.id === 'constellation-dense' ? info.index : -1; }
      });
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

  // keep: the satellite about to be tracked. A mega-constellation's others go: every loop over the satellites would crawl
  private clearConstellation(keep?: string) {
    this.swarm = this.constellation ? { layers: this.constellationLayers, t0: performance.now() } : null;
    if (this.dense) for (const id of this.constellation!) if (id !== keep) this.satellites.delete(id);
    this.constellation = null;
    this.dense = null;
    document.getElementById('tl-cover')!.hidden = true;
    this.tlHover = this.tlPinned = -1;
    this.constellationLayers = [];
    cancelAnimationFrame(this.tlRaf);
    document.getElementById('utc-label')!.textContent = 'UTC'; // the clock goes back to real time
    this.nightTimeSetter?.(null); // day/night back to real time
    (this.map as any).transform.clearNearFarZOverride?.();
    document.getElementById('deck-canvas')!.style.visibility = '';
    if (this.constellationOverlay) this.applyGlobeLayers();
  }

  // Show every satellite of a constellation at once: real altitude, real orbit rings, whole orbit in view, and a
  // time-lapse (Earth turning, ground tracks and swaths painted) that shows how the constellation covers the planet.
  /** Start fetching a constellation's orbits now (showConstellation then picks up the same request) */
  prefetchGroup(group: Constellation) { this.satelliteDataFetcher.fetchGroup(group); }

  async showConstellation(group: Constellation, pitch = 0): Promise<boolean> {
    const configs = await this.satelliteDataFetcher.fetchGroup(group);
    const ids = configs.filter(c => this.addSatelliteFromConfig(c)).map(c => c.id);
    console.log(`🌐 Constellation "${group.id}": ${ids.length} satellites`);
    if (ids.length === 0) return false; // the caller says so, or tries another

    // From a satellite in time-lapse, carry on with its clock (time and speed); from live tracking, start now at its speed
    // (x1: the settings' speed only for a constellation opened directly, ?group=)
    const fromTrack = this.followingSatellite && !this.trackLive ? { t: this.simNow(), speed: this.trackSpeed, paused: this.trackPaused } : null;
    const fromSpeed = this.followingSatellite ? this.trackSpeed : null;
    this.stopSimpleTracking();
    this.smoothTracker.stopTracking();
    this.smoothCamera.stopSmoothTracking();
    this.followingSatellite = null;
    this.constellation = ids;
    this.constellationColor = group.color;
    this.constellationSwathKm = group.swathKm;
    this.constellationNight = !!group.night;
    document.getElementById('tl-cover')!.hidden = !group.swathKm;
    this.constellationName = group.name;
    this.dense = ids.length >= DENSE_MIN ? this.buildDense(ids) : null;
    this.tlHover = this.tlPinned = -1;
    this.deck.setProps({ layers: [] }); // the flat overlay stays empty; the globe overlay draws everything
    document.getElementById('deck-canvas')!.style.visibility = 'hidden'; // ...so don't composite its full-screen canvas
    this.ensureGlobeOverlay();

    // Look at the orbit plane edge-on, over its daylit pass: the ground track is a vertical line through the middle of
    // the screen. The plane is the one most members share; with other planes (e.g. EDC-01's), the centre is midway
    // between their daylit equator crossings.
    const sats = ids.map(id => this.satellites.get(id)!);
    const rad = Math.PI / 180;
    const nowDate = new Date(fromTrack?.t ?? Date.now());
    const gmst = satellite.gstime(nowDate);
    const normals: number[][] = [];
    let orbitR = 1; // the highest satellite's distance from the Earth's centre, in Earth radii
    this.constellationOrbitR = 1;
    for (const s of sats) {
      const pv = satellite.propagate(satellite.twoline2satrec(s.tle1, s.tle2), nowDate);
      if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean') continue;
      const { position: r, velocity: v } = pv;
      orbitR = Math.max(orbitR, Math.hypot(r.x, r.y, r.z) / 6371);
      this.constellationOrbitR = orbitR;
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
      const sun = SolarCalculator.sunPoint(nowDate);
      const sv = [Math.cos(sun.lat * rad) * Math.cos(sun.lng * rad), Math.cos(sun.lat * rad) * Math.sin(sun.lng * rad), Math.sin(sun.lat * rad)];
      const sunSide = (v: number[]) => (dot(v, sv) < 0 ? v.map(c => -c) : v);
      const node = [-n[1], n[0], 0]; // z x n: where the orbit plane crosses the equator
      if (!group.swathKm) { // not an imager, no ground track to line up: look at the plane face-on from the equator, on the sun's side
        if (Math.hypot(...node) < 0.5) { // inclination under 30 deg: from the equator the belt (geostationary) would be a line, so look
          lat0 = 30; // from 30 deg north to see a ring (MapLibre can't zoom out enough over a pole, and doesn't draw the poles)
          lng0 = sun.lng;
        } else {
          const h = sunSide([n[0], n[1], 0]);
          lat0 = 0;
          lng0 = Math.atan2(h[1], h[0]) / rad;
        }
      } else {
        // View direction: the orbit's equator crossing on the sun's side, the daylit pass where these imaging satellites work,
        // with the equator at the centre of the globe; several planes: the middle of their crossings
        const planes: number[][] = [];
        for (const q of normals) if (!planes.some(p => dot(p, q) > Math.cos(15 * rad))) planes.push(q);
        const crossings = planes.map(p => sunSide([-p[1], p[0], 0])).filter(c => Math.hypot(...c) > 0.05).map(c => c.map(x => x / Math.hypot(...c)));
        const mid = crossings.reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0]);
        let u = planes.length > 1 && Math.hypot(...mid) > 0.1 ? mid : sunSide(node);
        if (Math.hypot(...u) < 0.05) { // equatorial orbit: no single crossing, use the sun projected into the orbit plane
          u = sv.map((c, i) => c - dot(sv, n) * n[i]);
          if (Math.hypot(...u) < 1e-3) u = [1, 0, 0]; // sun along the axis
        }
        u = u.map(c => c / Math.hypot(...u));
        lat0 = Math.asin(u[2]) / rad;
        lng0 = Math.atan2(u[1], u[0]) / rad;
        // Turn the view so the ground track (n x u, along the orbit at the centre) points straight up
        const ax = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        const north = [-Math.sin(lat0 * rad) * Math.cos(lng0 * rad), -Math.sin(lat0 * rad) * Math.sin(lng0 * rad), Math.cos(lat0 * rad)];
        const east = [-Math.sin(lng0 * rad), Math.cos(lng0 * rad), 0];
        bearing = Math.atan2(dot(ax, east), dot(ax, north)) / rad;
        if (bearing > 90) bearing -= 180; else if (bearing < -90) bearing += 180; // keep north roughly up
      }
    } else { // no usable orbit: fall back to the mean position
      lat0 = sats.reduce((a, s) => a + s.position.lat, 0) / sats.length;
      lng0 = sats[0].position.lng;
    }
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    // Globe disc fits the height below the top bar, with room for satellites and labels over the limb (or the width on a portrait
    // screen). Its limb lies behind the surface MapLibre scales to, so perspective shrinks it: a sphere of radius R at
    // D = 1.5 h (MapLibre's 36.87 deg field of view) shows a disc of r = D R / sqrt((D + R)^2 - R^2). Solve for R.
    const r = Math.min(h - 240, w - 80) / 2; // with a margin of space around the globe
    const D = 1.5 * h;
    // Higher orbits (navigation 3.2, geostationary 6.6 Earth radii) must fit too: a satellite orbitR R off the axis, level
    // with the globe's centre (D + R from the camera), is orbitR R D / (D + R) px off the screen centre
    const rOrbit = Math.min(h - 160, w - 40) / 2;
    const R = Math.min((r * r + r * Math.hypot(r, D)) / D, rOrbit * D / (orbitR * D - rOrbit)); // globe radius in px at the centre of the screen
    // MapLibre's globe radius is 512 * 2^zoom / (2 pi cos(lat)): it draws the globe larger away from the equator
    const zoom = Math.max(-2, Math.min(4, Math.log2((R * 2 * Math.PI * Math.cos(lat0 * rad)) / 512)));
    this.flightUntil = performance.now() + FLY_DURATION_MS + 200;
    const padding = { top: 0, bottom: 0, left: 0, right: 0 }; // the tracking camera may have moved the axis down
    this.map.flyTo({ center: [lng0, lat0], zoom, pitch, bearing, padding, duration: FLY_DURATION_MS, essential: true });

    // Time-lapse: starts playing right after the fly-in
    this.tlGmst = gmst;
    this.tlPlaying = !fromTrack?.paused;
    this.tlSpeed = fromTrack?.speed ?? fromSpeed ?? settings.speed;
    this.anchorTimelapse(nowDate.getTime());
    document.getElementById('utc-label')!.textContent = 'Sim UTC';
    this.syncTimeControls();
    cancelAnimationFrame(this.tlRaf);
    this.tlLast = 0;
    this.tlRaf = requestAnimationFrame(this.constellationFrame);
    this.onTrackingChangeCallback?.();
    return true;
  }

  // Shells: inclinations sorted, a new shell at each gap over 3 deg; coloured biggest first
  private buildDense(ids: string[]) {
    const recs = ids.map(id => satellite.twoline2satrec(this.satellites.get(id)!.tle1, this.satellites.get(id)!.tle2));
    const incs = recs.map(r => r.inclo * 180 / Math.PI);
    const groups: number[][] = [];
    [...incs.keys()].sort((a, b) => incs[a] - incs[b]).forEach(k => {
      const g = groups[groups.length - 1];
      if (g && incs[k] - incs[g[g.length - 1]] < 3) g.push(k); else groups.push([k]);
    });
    groups.sort((a, b) => b.length - a.length);
    const colors = new Uint8Array(ids.length * 4);
    const shells = groups.map((g, i) => {
      const color = SHELL_COLORS[Math.min(i, SHELL_COLORS.length - 1)];
      for (const k of g) colors.set([...color, 255], 4 * k);
      return { inc: g.reduce((a, k) => a + incs[k], 0) / g.length, color, n: g.length };
    });
    return { recs, pos: [new Float64Array(ids.length * 3), new Float64Array(ids.length * 3)], flip: 0, colors, plane: new Int32Array(ids.length), shells };
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
    const ringIds = (this.constellation || []).filter((id, i) => {
      const { nodeo, inclo } = satellite.twoline2satrec(this.satellites.get(id)!.tle1, this.satellites.get(id)!.tle2);
      const raan = nodeo * 180 / Math.PI, inc = inclo * 180 / Math.PI;
      const k = planes.findIndex(p => Math.abs(((raan - p.raan + 540) % 360) - 180) < 2 && Math.abs(inc - p.inc) < 0.5);
      if (this.dense) this.dense.plane[i] = k < 0 ? planes.length : k;
      if (k >= 0) return false;
      planes.push({ raan, inc });
      return true;
    });
    const dense = this.dense;
    this.tlRings = ringIds.map((id, k) => {
      const s = this.satellites.get(id)!;
      const pts = this.computeOrbitRing(s.tle1, s.tle2, t, dense ? DENSE_RING_N : RING_N);
      // dense: the ring in its shell's colour (the shell of its first satellite)
      const c = dense && [...dense.colors.subarray(4 * dense.plane.indexOf(k), 4 * dense.plane.indexOf(k) + 3), 46];
      const segs = pts.slice(1).map(() => ({ a: [0, 0, 0], b: [0, 0, 0], c: c || undefined }));
      return { id, pts, segs, inc: planes[k].inc };
    });
    this.tlRingSegs = this.tlRings.flatMap(r => r.segs);
  }

  // One full orbit as an inertial ring around the Earth, in the (rotating) Earth-fixed frame at time t.
  private computeOrbitRing(tle1: string, tle2: string, t: number, n = RING_N): number[][] {
    const satrec = satellite.twoline2satrec(tle1, tle2);
    const periodMs = (2 * Math.PI / satrec.no) * 60000; // satrec.no = rad/min
    const gmst = satellite.gstime(new Date(t));
    const pts: number[][] = [];
    for (let k = 0; k <= n; k++) {
      const pv = satellite.propagate(satrec, new Date(t + (k / n) * periodMs));
      if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
      pts.push(eciToLngLatAlt(pv.position, gmst)); // same gmst for every sample -> inertial ring
    }
    return pts;
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

    // Earth turns under a fixed (inertial) view: move the map centre west by the rotation since the last frame.
    // On the transform itself: jumpTo would stop MapLibre's gestures (a drag or a zoom couldn't last a frame)
    let d = (gmst - this.tlGmst) * 180 / Math.PI;
    d = ((d + 540) % 360) - 180;
    this.tlGmst = gmst;
    if (!flying && d) {
      const c = this.map.getCenter();
      (this.map as any).transform.setCenter(new LngLat(c.lng - d, c.lat));
      this.map.triggerRepaint();
    }
    if (!flying) this.nightTimeSetter?.(this.tlSim); // the terminator follows the simulated sun
    if (this.constellationOrbitR > 1.5) { // MapLibre's far plane, one globe radius behind the Earth, would clip the far side
      const tr = (this.map as any).transform; // of higher orbits: move it behind them (low orbits keep the default)
      const globeR = tr.worldSize / (2 * Math.PI * Math.cos(tr.center.lat * Math.PI / 180));
      tr.overrideNearFarZ?.(0.5, tr.cameraToCenterDistance + globeR * (1 + this.constellationOrbitR) * 1.05);
    }

    // Satellites (and the scan line across each ground track) at the simulated time
    const halfKm = this.constellationSwathKm / 2;
    const m = halfKm > 250 ? SWATH_ACROSS_N : 1; // narrow swaths are flat enough for one quad across
    const before = new Date(this.tlSim - 5000);
    const arcs: number[][][] = [];
    const dn = this.dense;
    if (dn) { // straight from SGP4 into the next position buffer (not an imager: no scan lines)
      const out = dn.pos[dn.flip ^= 1];
      dn.recs.forEach((rec, k) => {
        const pv = satellite.propagate(rec, date);
        if (pv && pv.position && typeof pv.position !== 'boolean') out.set(eciToLngLatAlt(pv.position, gmst), 3 * k);
      });
    } else this.constellation.forEach((id, k) => {
      const s = this.satellites.get(id)!;
      const p = this.calculateSatellitePosition(s.tle1, s.tle2, id, date);
      s.position = new LngLat(p.longitude, p.latitude);
      s.altitude = p.altitude;
      s.velocity = p.velocity;
      if (!halfKm) return; // not an imager: no scan line
      const q = this.calculateSatellitePosition(s.tle1, s.tle2, id, before);
      const hd = bearingDeg([q.longitude, q.latitude], [p.longitude, p.latitude]); // ground track heading
      arcs[k] = acrossTrack(p.longitude, p.latitude, hd, halfKm, m, GROUND_LIFT_M);
    });
    this.tlScanArcs = arcs;
    // Keep the swaths computed ahead of the satellites and, for a longer window, back over it (a chunk a frame); drop
    // chunks older than the window
    if (halfKm) {
      const ahead = this.tlTrackEnd - this.tlSim < TRACK_CHUNK_MS / 2;
      const first = this.tlChunks.reduce((a, c) => Math.min(a, c.start), this.tlTrackEnd);
      if (ahead || (this.tlWindowMs > TRACK_FADE_MS && first > this.tlSim - this.tlWindowMs)) {
        const chunk = this.swathChunk(ahead ? this.tlTrackEnd : first - TRACK_CHUNK_MS, halfKm, m);
        if (ahead) this.tlTrackEnd = chunk.end;
        this.tlChunks = [...this.tlChunks.filter(c => this.tlSim - c.end < this.tlWindowMs), chunk];
      }
      if (performance.now() - this.coverAt > 500) this.showCoverage();
    }
    // The chunks stop at the last whole sample: the swath from there up to each scan line is rebuilt every frame
    this.tlHeads = [];
    const tk = this.tlTrackBase + Math.floor((this.tlSim - this.tlTrackBase) / TRACK_SAMPLE_MS) * TRACK_SAMPLE_MS;
    const chunk = this.tlChunks.find(c => c.start <= tk && tk < c.end);
    chunk?.rows.forEach((rs, k) => {
      const r = rs[Math.round((tk - chunk.start) / TRACK_SAMPLE_MS)];
      if (arcs[k]) this.tlHeads.push(...stripQuads(r.row, arcs[k]));
    });

    const now = performance.now();
    if (now - this.tlHeavyAt > 50) { // orbit rings at 20 Hz
      this.tlHeavyAt = now;
      this.updateRingSegments(gmst);
      this.tlVersion++;
    }
    this.showClock(this.tlSim);
    this.renderConstellation();
  };

  // Swaths from t0 for 30 min: rows across each ground track, quads between lit rows, and the grid cells they cover
  private swathChunk(t0: number, halfKm: number, m: number) {
    const t1 = t0 + TRACK_CHUNK_MS, n = TRACK_CHUNK_MS / TRACK_SAMPLE_MS;
    const quads: Quad[] = [];
    const cells: number[] = [], ts: number[] = []; // grid cells imaged, and when (as quads' t): the share of the Earth covered
    const rows = this.constellation!.map(id => {
      const s = this.satellites.get(id)!;
      // samples 0..n (the first repeats the previous chunk's last: no gap), plus one past the end for the last heading
      const pts = Array.from({ length: n + 2 }, (_, j) => {
        const date = new Date(t0 + j * TRACK_SAMPLE_MS);
        const p = this.calculateSatellitePosition(s.tle1, s.tle2, id, date);
        const lit = this.constellationNight || SolarCalculator.calculateSolarElevation(p.latitude, p.longitude, date) >= MIN_SUN_ELEV_DEG;
        return { lng: p.longitude, lat: p.latitude, lit };
      });
      const out = pts.slice(0, n + 1).map((p, j) => ({
        lit: p.lit, row: acrossTrack(p.lng, p.lat, bearingDeg([p.lng, p.lat], [pts[j + 1].lng, pts[j + 1].lat]), halfKm, m, GROUND_LIFT_M)
      }));
      out.slice(1).forEach((b, j) => {
        const lit = b.lit && out[j].lit; // images there (optical: sun high enough at the nadir); drawn either way
        const t = (t0 + (j + 1) * TRACK_SAMPLE_MS - this.tlTrackBase) / 1000;
        for (const polygon of stripQuads(out[j].row, b.row)) quads.push({ polygon, t });
        if (!lit) return; // ...and not counted as covered
        stripCells([pts[j].lng, pts[j].lat], [pts[j + 1].lng, pts[j + 1].lat], halfKm, cells);
        while (ts.length < cells.length) ts.push(t);
      });
      return out;
    });
    return { start: t0, end: t1, rows, quads, cells, ts };
  }

  // Coverage button: the swath window shown, and the share of the Earth imaged in it
  private showCoverage() {
    this.coverAt = performance.now();
    const btn = document.getElementById('tl-cover')!;
    const tNow = (this.tlSim - this.tlTrackBase) / 1000;
    const pct = Math.round(100 * coveredShare(this.tlChunks, tNow - this.tlWindowMs / 1000, tNow));
    const span = (ms: number) => (ms < 2 * 3600e3 ? `${ms / 60e3} min` : `${ms / 3600e3} h`);
    const next = COVER_WINDOWS_MS[(COVER_WINDOWS_MS.indexOf(this.tlWindowMs) + 1) % COVER_WINDOWS_MS.length];
    btn.textContent = `Last ${span(this.tlWindowMs)}: ${pct}% of Earth imaged`;
    btn.title = `Swaths of the last ${span(this.tlWindowMs)} cover ${pct}% of the Earth's surface: click for the last ${span(next)}`;
  }

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

  // Camera position in Earth radii (Earth-fixed). MapLibre's camera is 1.5 x the screen height (36.87 deg field of
  // view) from the map centre, tilted back by the pitch, opposite the bearing; the globe radius is
  // 512 * 2^zoom / (2 pi cos(lat)) px.
  private cameraEcef(): number[] {
    const rad = Math.PI / 180;
    const { lng, lat } = this.map.getCenter();
    const pitch = this.map.getPitch() * rad, bearing = this.map.getBearing() * rad;
    const lo = lng * rad, la = lat * rad;
    const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const north = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
    const east = [-Math.sin(lo), Math.cos(lo), 0];
    const R = 512 * 2 ** this.map.getZoom() / (2 * Math.PI * Math.cos(la));
    const dist = 1.5 * this.mapHeight / R;
    return up.map((u, i) => u + dist * (Math.cos(pitch) * u
      - Math.sin(pitch) * (Math.cos(bearing) * north[i] + Math.sin(bearing) * east[i])));
  }

  private renderDense() {
    const dn = this.dense!, pos = dn.pos[dn.flip], v = this.tlVersion, h = this.tlHover >= 0 ? this.tlHover : this.tlPinned;
    const lines = { cullMode: 'none' as const, depthWriteEnabled: false };
    const occluded = { depthCompare: 'less-equal' as const, depthWriteEnabled: false, cullMode: 'none' as const };
    const at = (k: number) => [pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]] as [number, number, number];
    const ring = h >= 0 ? this.tlRings[dn.plane[h]] : null;
    const mates = ring ? [...dn.plane.keys()].filter(k => dn.plane[k] === dn.plane[h]) : [];
    const f = ++this.tlFrame;
    this.constellationLayers = [
      new LineLayer({ // one ring per orbital plane, in its shell's colour
        id: 'constellation-orbits', data: this.tlRingSegs, parameters: lines,
        getSourcePosition: (d: any) => d.a, getTargetPosition: (d: any) => d.b, getColor: (d: any) => d.c,
        getWidth: 1, widthUnits: 'pixels', updateTriggers: { getSourcePosition: v, getTargetPosition: v }
      }),
      new ScatterplotLayer({ // the satellites, fine points hidden by the Earth
        id: 'constellation-dense', parameters: occluded, pickable: true, billboard: true,
        data: { length: dn.recs.length, attributes: { getPosition: { value: pos, size: 3 }, getFillColor: { value: dn.colors, size: 4, normalized: true } } } as any,
        getRadius: 1.8, radiusUnits: 'pixels'
      }),
      ...(ring ? [ // hovered: its whole plane in white, the satellites in line on it, named
        new LineLayer({
          id: 'constellation-plane', data: ring.segs, parameters: lines, updateTriggers: { getSourcePosition: v, getTargetPosition: v },
          getSourcePosition: (d: any) => d.a, getTargetPosition: (d: any) => d.b, getColor: [255, 255, 255, 210], getWidth: 1.6, widthUnits: 'pixels'
        }),
        new ScatterplotLayer({
          id: 'constellation-plane-dots', data: mates, parameters: occluded, billboard: true, updateTriggers: { getPosition: f },
          getPosition: (k: number) => at(k), getRadius: 3, radiusUnits: 'pixels', getFillColor: [255, 255, 255, 255]
        }),
        new TextLayer({
          id: 'constellation-hover', data: [h], parameters: { depthCompare: 'always' as const, cullMode: 'none' as const }, updateTriggers: { getPosition: f },
          getPosition: (k: number) => at(k), getPixelOffset: [0, -LABEL_LIFT_PX - 8], getSize: 12, lineHeight: 1.35,
          getText: (k: number) => {
            const s = this.satellites.get(this.constellation![k])!;
            const lap = Math.round(2 * Math.PI / dn.recs[k].no);
            return `${s.shortname || s.name}\n${ring.inc.toFixed(1)}° plane · ${mates.length} satellites · a lap every ${lap} min`;
          },
          getColor: [255, 255, 255, 255], background: true, getBackgroundColor: [8, 14, 24, 235], backgroundPadding: [7, 4],
          fontFamily: 'Inter, sans-serif', fontWeight: 600, characterSet: 'auto'
        })
      ] : [])
    ];
    this.applyGlobeLayers();
  }

  /** Dense constellation: its planes and shells (inclination, colour, size), biggest first; null otherwise. */
  getConstellationShells(): { planes: number; shells: Array<{ inc: number; color: number[]; n: number }> } | null {
    return this.dense && { planes: this.tlRings.length, shells: this.dense.shells };
  }

  private renderConstellation() {
    if (!this.constellation) return;
    if (this.dense) return this.renderDense();
    const [r, g, b] = this.constellationColor;
    // Satellites sit at their real altitude, tied to their footprint by a sensor cone down to the scan line. They are
    // hidden by the Earth's depth buffer like everything else, so they go behind the limb gradually. A billboard (dot,
    // label) depth-tested in front of the Earth is cut by any nearer ground it overlaps on screen, so there it is drawn
    // on top instead, cross-fading to the depth-tested copy as the line of sight to it reaches the Earth.
    const rad = Math.PI / 180;
    const ecef = (lng: number, lat: number) => [Math.cos(lat * rad) * Math.cos(lng * rad), Math.cos(lat * rad) * Math.sin(lng * rad), Math.sin(lat * rad)];
    const cam = this.cameraEcef();
    if (this.tlDots.length !== this.constellation.length || this.tlDots.some((d, i) => d.id !== this.constellation![i])) {
      this.tlDots = this.constellation.map(id => {
        const s = this.satellites.get(id)!;
        return { id, name: s.shortname || s.name, position: [0, 0, 0], alpha: 1, dist: 0, label: 1 };
      });
    }
    const dots = this.tlDots;
    for (const d of dots) {
      const s = this.satellites.get(d.id)!;
      d.position[0] = s.position.lng; d.position[1] = s.position.lat; d.position[2] = s.altitude * 1000;
      // How high the line of sight camera -> satellite passes above the Earth (if its closest approach lies before
      // the satellite): 1 well clear, 0 once it touches the Earth and beyond
      const sp = ecef(s.position.lng, s.position.lat).map(c => c * (1 + s.altitude / 6371));
      const dv = sp.map((c, i) => c - cam[i]);
      d.dist = Math.hypot(...dv);
      const t = -(cam[0] * dv[0] + cam[1] * dv[1] + cam[2] * dv[2]) / (dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2]);
      const clear = t >= 1 ? Infinity : Math.hypot(...cam.map((c, i) => c + t * dv[i])) - 1;
      const k = Math.min(1, Math.max(0, clear / LIMB_GRAZE));
      d.alpha = k * k * (3 - 2 * k);
    }
    // Declutter: nearest first, a label whose box overlaps one already placed fades out (eased: no popping).
    // Satellites hidden by the Earth (alpha 0) take no room.
    const deck = (this.constellationOverlay as any)?._deck;
    const vp = deck?.viewManager && deck.getViewports()[0]; // none until the overlay has drawn once
    if (vp) {
      const placed: number[][] = [];
      for (const d of [...dots].sort((a, b) => a.dist - b.dist)) {
        const [x, y] = vp.project(d.position);
        const w = d.name.length * 7 + 14, cy = y - LABEL_LIFT_PX; // box of a 12 px label with its padding
        const box = [x - w / 2, cy - 9, x + w / 2, cy + 9];
        const free = !placed.some(o => box[0] < o[2] && o[0] < box[2] && box[1] < o[3] && o[1] < box[3]);
        if (free && d.alpha > 0) placed.push(box);
        d.label += (Number(free) - d.label) * 0.2;
      }
    }
    // Sensor cones: satellite -> its scan line (an arc along the ground), split into bands so the fill fades toward the ground.
    // Flat, closed [x, y, z, ...] rings with _normalize off, so deck doesn't re-cut them on the globe's lng/lat grid.
    const nb = CONE_ALPHA.length;
    const cones: Array<{ polygon: number[]; band: number }> = [], coneEdges: Array<{ a: number[]; b: number[] }> = [];
    dots.forEach((d, k) => {
      const sp = d.position, arc = this.tlScanArcs[k];
      if (!arc) return;
      const lerp = (q: number[], f: number) => [0, 1, 2].map(i => sp[i] + (q[i] - sp[i]) * f);
      for (let band = 0; band < nb; band++) {
        const near = arc.map(q => lerp(q, band / nb)), far = arc.map(q => lerp(q, (band + 1) / nb));
        for (const polygon of stripQuads(near, far)) cones.push({ polygon, band });
      }
      coneEdges.push({ a: [...sp], b: arc[0] }, { a: [...sp], b: arc[arc.length - 1] });
    });
    const f = ++this.tlFrame; // positions/visibility changed: refresh those attributes only
    const moved = { getPosition: f, getSourcePosition: f, getTargetPosition: f, getColor: f, getFillColor: f, getLineColor: f, getBackgroundColor: f };
    const inFront = (rgba: number[]) => (d: any) => [rgba[0], rgba[1], rgba[2], rgba[3] * d.alpha] as any;
    const atLimb = (rgba: number[]) => (d: any) => [rgba[0], rgba[1], rgba[2], rgba[3] * (1 - d.alpha)] as any;
    const labeled = (c: (d: any) => number[]) => (d: any) => { const v = c(d); v[3] *= d.label; return v as any; };
    const v = this.tlVersion;
    // Lines are depth-tested against MapLibre's globe, so whatever is behind the Earth is hidden by it. They don't
    // write depth, so a ring (600 km up) can't cut through a satellite's label: only the Earth hides labels.
    const lines = { cullMode: 'none' as const, depthWriteEnabled: false };
    const onTop = { depthCompare: 'always' as const, cullMode: 'none' as const };
    const occluded = { depthCompare: 'less-equal' as const, depthWriteEnabled: false, cullMode: 'none' as const };
    const copies = [['', onTop, inFront], ['-limb', occluded, atLimb]] as const;
    // Swaths: the precomputed quads, cut at the current time and faded by age on the GPU (smooth, nothing rebuilt per
    // frame), one layer per chunk so a new chunk doesn't re-tessellate the others. A faint one for past passes, a bright
    // one for what each satellite is imaging now. No depth writes: overlapping swaths at the same height hid each other
    // in jagged steps (still hidden by the globe).
    // Past passes paint each pixel once (stencil, cleared every frame in onBeforeRender): where passes overlap, toward
    // the poles, the swath looks as it does at the equator instead of piling up. Newest first, so a faded pass doesn't
    // take a pixel a fresher one covers.
    const tNow = (this.tlSim - this.tlTrackBase) / 1000;
    const once = { ...lines, stencilWriteMask: 0xff, stencilCompare: 'equal' as const, stencilPassOperation: 'increment-clamp' as const,
      stencilFailOperation: 'keep' as const, stencilDepthFailOperation: 'keep' as const };
    const swath = (c: typeof this.tlChunks[number], data: Quad[], id: string, alpha: number, fadeMs: number, softMs = 0, parameters: object = lines) =>
      new SolidPolygonLayer<any, DataFilterExtensionProps<any>>({
        id: `${id}-${c.start}`, data, parameters, _normalize: false, positionFormat: 'XYZ',
        getPolygon: (d: any) => d.polygon, getFillColor: [r, g, b, alpha],
        extensions: [AGE_FILTER, HORIZON], getFilterValue: (d: any) => d.t, filterRange: [tNow - fadeMs / 1000, tNow], filterSoftRange: [tNow - softMs / 1000, tNow]
      });
    const cover = this.tlWindowMs > TRACK_FADE_MS; // a coverage window: every pass alike, not fading
    const [alpha, soft] = cover ? [64, this.tlWindowMs] : [40, 0];
    const newest = [...this.tlChunks].sort((a, b) => b.start - a.start);
    this.constellationLayers = [
      ...(this.constellationSwathKm ? [ // an imager: its swaths, scan line and sensor cone
      ...newest.map(c => swath(c, c.quads, 'constellation-swath', alpha, this.tlWindowMs, soft, once)),
      ...this.tlChunks.filter(c => c.end > this.tlSim - SCAN_MS && c.start <= this.tlSim).map(c => swath(c, c.quads, 'constellation-scan', 170, SCAN_MS)),
      new SolidPolygonLayer({ // both of them, up to the scan line
        id: 'constellation-swath-head', data: this.tlHeads, parameters: lines, _normalize: false, positionFormat: 'XYZ', extensions: [HORIZON],
        getPolygon: (d: any) => d, getFillColor: [r, g, b, 184]
      }),
      new PathLayer({ // the scan line across the track right under each satellite
        id: 'constellation-scanline', data: this.tlScanArcs.filter(Boolean), _pathType: 'open', parameters: lines, positionFormat: 'XYZ', extensions: [HORIZON],
        getPath: (d: any) => d.flat(), getColor: [255, 255, 255, 230], getWidth: 2.5, widthUnits: 'pixels'
      }),
      new SolidPolygonLayer({ // sensor cones: real 3D surfaces, hidden by the Earth through the depth test
        id: 'constellation-cones', data: cones, parameters: lines, _normalize: false, _full3d: true,
        getPolygon: (d: any) => d.polygon, positionFormat: 'XYZ', getFillColor: (d: any) => [r, g, b, CONE_ALPHA[d.band]]
      }),
      new LineLayer({ // cone edges
        id: 'constellation-cone-edges', data: coneEdges, parameters: lines,
        getSourcePosition: (d: any) => d.a, getTargetPosition: (d: any) => d.b,
        getColor: [r, g, b, 120], getWidth: 1, widthUnits: 'pixels'
      })
      ] : []),
      new LineLayer({ // orbit rings
        id: 'constellation-orbits', data: this.tlRingSegs, parameters: lines,
        getSourcePosition: (d: any) => d.a, getTargetPosition: (d: any) => d.b,
        getColor: [r, g, b, 45], getWidth: 1.5, widthUnits: 'pixels',
        updateTriggers: { getSourcePosition: v, getTargetPosition: v }
      }),
      // Glows, then labels, then dots: a label never hides a satellite. Labels share one layer per copy, which draws
      // every box before every text, so overlapping labels would print through each other: the farther one fades out.
      ...copies.flatMap(([suffix, parameters, color]) => [
        new ScatterplotLayer({ // soft glow
          id: `constellation-glow${suffix}`, data: dots, parameters, updateTriggers: moved,
          getPosition: (d: any) => d.position, getRadius: 20, radiusUnits: 'pixels', billboard: true,
          getFillColor: color([r, g, b, 55])
        }),
        new TextLayer({
          id: `constellation-labels${suffix}`, data: dots, parameters, updateTriggers: moved,
          getPosition: (d: any) => d.position, getText: (d: any) => d.name,
          getSize: 12, getColor: labeled(color([255, 255, 255, 255])), getPixelOffset: [0, -LABEL_LIFT_PX],
          background: true, getBackgroundColor: labeled(color([8, 14, 24, 235])), backgroundPadding: [7, 3],
          fontFamily: 'Inter, sans-serif', fontWeight: 600
        }),
        new ScatterplotLayer({ // bright core
          id: `constellation-dots${suffix}`, data: dots, parameters, pickable: true, updateTriggers: moved,
          getPosition: (d: any) => d.position, getRadius: 5.5, radiusUnits: 'pixels', billboard: true,
          getFillColor: color([255, 255, 255, 255]), getLineColor: color([r, g, b, 255]), getLineWidth: 2.5, stroked: true
        })
      ])
    ];
    this.applyGlobeLayers();
  }

  /** A constellation's operational satellites (ids), loading those not loaded yet: fetched once, then cached */
  async constellationMembers(group: Constellation): Promise<string[]> {
    const configs = await this.satelliteDataFetcher.fetchGroup(group);
    return configs.filter(c => this.satellites.has(c.id) || this.addSatelliteFromConfig(c)).map(c => c.id);
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

  private initializeWorker() {
    // Disable worker for now due to module loading issues with importScripts
    // All calculations will use main thread fallback which works reliably
    this.satelliteWorker = null;
  }

  // Prioritize satellites for loading - important ones first
  // prioritizeAllSatellites() method removed - no longer needed since we don't bulk load satellites

  // External satellites are loaded on-demand for search functionality
  // This keeps the app fast when viewing specific satellites

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


  // Tracking view, drawn inside MapLibre's globe like the constellation view: the satellite at its real altitude, a
  // line or sensor cone down to the ground and, for imagers, the swath it paints behind it.
  private renderTracked() {
    const s = this.satellites.get(this.followingSatellite!);
    if (!s?.position) return;
    if (!this.trackedOnGlobe) {
      this.trackedOnGlobe = true;
      this.deck.setProps({ layers: [] });
      document.getElementById('deck-canvas')!.style.visibility = 'hidden';
    }
    const group = constellationOf(s.id);
    const [r, g, b] = group?.color ?? [0, 255, 136];
    const halfKm = (group?.swathKm ?? 0) / 2;
    const now = this.simNow();
    if (this.siblings.of !== s.id) { // its constellation's others, loaded if needed (imagers only: Starlink's would be thousands)
      this.siblings = { of: s.id, ids: [] };
      if (halfKm) this.constellationMembers(group!).then(ids => {
        if (this.siblings.of !== s.id) return;
        this.siblings.ids = ids.filter(id => id !== s.id);
        for (const id of this.siblings.ids) { // their pictures
          const t = this.satellites.get(id);
          if (t?.image && !this.satelliteIcons.has(id)) this.loadSatelliteIcon(id, t.image);
        }
      });
    }
    const mates = this.siblings.ids.filter(id => this.satellites.has(id)).map(id => {
      const m = this.satellites.get(id)!, p = this.calculateSatellitePosition(m.tle1, m.tle2, id, new Date(now));
      return { id, name: m.shortname || m.name, position: [p.longitude, p.latitude, p.altitude * 1000] };
    });
    if (!this.trackLive) this.nightTimeSetter?.(now); // the terminator follows the simulated sun
    this.showClock(now);
    const p = this.smoothTracker.getPredictedPosition();
    // Before the tracker starts (fly-in) compute the position too: the stored one can be at another time (a constellation
    // time-lapse leaves it at its simulated time), which drew the cone away from the swath
    const q = p ?? this.calculateSatellitePosition(s.tle1, s.tle2, s.id, new Date(now));
    if (!p) { s.position = new LngLat(q.longitude, q.latitude); s.altitude = q.altitude; } // the banner reads these
    const sat = [q.longitude, q.latitude, q.altitude * 1000];

    const cam = this.cameraEcef();
    const prev = this.calculateSatellitePosition(s.tle1, s.tle2, s.id, new Date(now - 5000));
    const me = this.imagerMarks(s.id, group, sat, p?.bearing ?? bearingDeg([prev.longitude, prev.latitude], sat), now, cam);
    const px = me.px;
    // Its mates as it: picture, cone, swath (a big constellation, Planet's, just dots: those cost every frame)
    const marked = mates.length <= SIBLING_MARKS_MAX ? mates : [];
    const sibs = marked.map(m => {
      const t = this.satellites.get(m.id)!, q0 = this.calculateSatellitePosition(t.tle1, t.tle2, m.id, new Date(now - 5000));
      return { ...m, ...this.imagerMarks(m.id, group, m.position, bearingDeg([q0.longitude, q0.latitude], m.position), now, cam) };
    });
    const imagers = [{ ...me, position: sat }, ...sibs];
    // Cones only for satellites between the camera's near and far planes (deck's depth in -1..1): one behind the camera,
    // or level with it, would streak across the screen
    const deck = (this.constellationOverlay as any)?._deck, vp = deck?.viewManager && deck.getViewports()[0];
    const coned = imagers.filter((m, i) => !i || (vp && Math.abs(vp.project(m.position)[2]) < 1));

    const lines = { cullMode: 'none' as const, depthWriteEnabled: false };
    const onTop = { depthCompare: 'always' as const, cullMode: 'none' as const };
    const draped = { depthCompare: 'always' as const, cullMode: 'none' as const, depthWriteEnabled: false };
    const behindEarth = { depthCompare: 'less-equal' as const, depthWriteEnabled: false, cullMode: 'none' as const };
    const f = ++this.tlFrame;
    const pictureOf = (id: string) => settings.picture && this.satellites.get(id)?.image ? this.satelliteIcons.get(id) : undefined; // unless turned off (settings)
    const icon = pictureOf(s.id);
    // Sized by its distance: the camera's zoom around it
    const base = this.getSatelliteImageSize(this.smoothCamera.zoom, s.dimensions.width, s.id, s.scaleFactor) * TRACKED_ICON_SCALE;
    const size = base * this.trackedSatelliteSizeMultiplier;
    const fade = this.swarm ? 1 - (performance.now() - this.swarm.t0) / FLY_DURATION_MS : 0;
    if (fade <= 0) this.swarm = null;
    const dots = mates.filter(m => !marked.includes(m) || !pictureOf(m.id));
    // On screen: the tracked one's size (same model; getSatelliteImageSize would make a mate 5x smaller) in perspective,
    // times its nearness relative to it (px / m.px): never bigger (the tracked one is the subject), floored so a far one
    // isn't a speck
    const shownSize = (m: { px: number }) => base * Math.min(1, Math.max(SIBLING_MIN_SCALE, px / m.px));
    this.constellationLayers = [
      ...(this.swarm?.layers.map(l => l.clone({ id: `left-${l.id}`, opacity: fade * l.props.opacity, pickable: false })) ?? []), // the camera dives through it
      ...(me.scanArc ? [
        new SolidPolygonLayer({
          id: 'tracked-swath', parameters: draped, _normalize: false, positionFormat: 'XYZ',
          // its mates' fainter: in one plane their swaths overlap, and translucent fills stacked up to solid colour
          data: imagers.flatMap((m, i) => i ? m.swath.map(q => ({ polygon: q.polygon, alpha: q.alpha * SIBLING_SWATH })) : m.swath),
          getPolygon: (d: any) => d.polygon, getFillColor: (d: any) => [r, g, b, d.alpha]
        }),
        new SolidPolygonLayer({
          id: 'tracked-cone', parameters: lines, _normalize: false, _full3d: true, positionFormat: 'XYZ', getPolygon: (d: any) => d,
          data: coned.flatMap(m => m.scanArc!.slice(1).map((q, i) => [...m.position, ...m.scanArc![i], ...q, ...m.position])),
          getFillColor: [r, g, b, 45], updateTriggers: { getPolygon: f }
        }),
        new PathLayer({ // drawn over everything: only where the camera sees the ground
          id: 'tracked-scanline', data: imagers.filter((m, i) => !i || m.seen).map(m => m.scanArc!.flat()), _pathType: 'open',
          parameters: draped, updateTriggers: { getPath: f },
          getPath: (d: any) => d, positionFormat: 'XYZ', getColor: [255, 255, 255, 230], getWidth: 2.5, widthUnits: 'pixels'
        }),
        new LineLayer({ // the cones' edges
          id: 'tracked-down', parameters: lines, updateTriggers: { getSourcePosition: f, getTargetPosition: f, getWidth: f },
          data: coned.flatMap(m => [{ a: m.position, b: m.scanArc![0], w: m.px }, { a: m.position, b: m.scanArc![SCAN_ARC_N], w: m.px }]),
          getSourcePosition: (d: any) => d.a, getTargetPosition: (d: any) => d.b, getColor: [r, g, b, 160], getWidth: (d: any) => d.w, widthUnits: 'pixels'
        })
      ] : []),
      ...(mates.length ? [ // the constellation's others, hidden by the Earth; a click switches to one
        new ScatterplotLayer({
          id: 'tracked-siblings', data: dots, parameters: behindEarth, pickable: true, billboard: true, updateTriggers: { getPosition: f },
          getPosition: (d: any) => d.position, getRadius: 4, radiusUnits: 'pixels', getFillColor: [255, 255, 255, 230],
          getLineColor: [r, g, b, 255], getLineWidth: 2, lineWidthUnits: 'pixels', stroked: true
        }),
        ...sibs.filter(m => pictureOf(m.id)).map(m => new IconLayer({
          id: `tracked-siblings-${m.id}`, data: [m], parameters: behindEarth, pickable: true, updateTriggers: { getPosition: f, getSize: f },
          iconAtlas: pictureOf(m.id)!.atlas, iconMapping: pictureOf(m.id)!.mapping, getIcon: () => m.id,
          getPosition: (d: any) => d.position, getSize: shownSize(m) * m.px
        })),
        new TextLayer({ // pixel sizes shrink with distance here: scaled back by px, each name just above its picture or dot
          id: 'tracked-sibling-names', parameters: behindEarth, updateTriggers: { getPosition: f, getSize: f, getPixelOffset: f },
          data: mates.map(m => {
            const k = sibs.find(x => x.id === m.id), shown = k && pictureOf(m.id) ? shownSize(k) : 8;
            return { ...m, px: k?.px ?? 1, lift: shown / 2 };
          }),
          getPosition: (d: any) => d.position, getText: (d: any) => d.name, getSize: (d: any) => 11 * d.px, getColor: [255, 255, 255, 170],
          getPixelOffset: (d: any) => [0, -(d.lift + 10) * d.px], fontFamily: 'Inter, sans-serif', fontWeight: 600, ...LABEL_CHIP
        })
      ] : []),
      new TextLayer({ // its own name, above its picture or dot
        id: 'tracked-name', data: [{ position: sat }], parameters: onTop, updateTriggers: { getPosition: f, getSize: f, getPixelOffset: f },
        getPosition: (d: any) => d.position, getText: () => s.shortname || s.name, getSize: 13 * px, getColor: [255, 255, 255, 255],
        getPixelOffset: [0, -((icon ? size / 2 : 16) + 10) * px], fontFamily: 'Inter, sans-serif', fontWeight: 600, ...LABEL_CHIP
      }),
      ...(icon ? [
        new IconLayer({
          id: 'tracked-icon', data: [{ position: sat }], parameters: onTop, updateTriggers: { getPosition: f, getSize: f },
          iconAtlas: icon.atlas, iconMapping: icon.mapping, getIcon: () => s.id, getPosition: (d: any) => d.position, getSize: size * px
        })
      ] : [
        new ScatterplotLayer({ // vector dot: crisp at any size, unlike the old canvas sprite
          id: 'tracked-glow', data: [{ position: sat }], parameters: onTop, updateTriggers: { getPosition: f },
          getPosition: (d: any) => d.position, getRadius: 16 * px, radiusUnits: 'pixels', billboard: true, getFillColor: [r, g, b, 60], antialiasing: false
        }),
        new ScatterplotLayer({
          id: 'tracked-dot', data: [{ position: sat }], parameters: onTop, updateTriggers: { getPosition: f },
          getPosition: (d: any) => d.position, getRadius: 6 * px, radiusUnits: 'pixels', billboard: true,
          getFillColor: [255, 255, 255, 255], getLineColor: [r, g, b, 255], getLineWidth: 2.5 * px, lineWidthUnits: 'pixels', stroked: true,
          antialiasing: false // its smoothing assumes the scaled-down size (MSAA smooths the edge)
        })
      ])
    ];
    this.applyGlobeLayers();
  }

  // An imager's marks at time `now`, at `sat` ([lng, lat, m]) heading `heading`: px, its marks' scale (deck sizes a pixel
  // at the ground point the camera orbits, the satellite is nearer); the swath painted over the last 20 min and the scan
  // line across the track; seen: its ground point faces the camera (swath and scan line are drawn over everything)
  private imagerMarks(id: string, group: Constellation | undefined, sat: number[], heading: number, now: number, cam: number[]) {
    const s = this.satellites.get(id)!, halfKm = (group?.swathKm ?? 0) / 2, rad = Math.PI / 180;
    const ecef = (lng: number, lat: number, r: number) =>
      [r * Math.cos(lat * rad) * Math.cos(lng * rad), r * Math.cos(lat * rad) * Math.sin(lng * rad), r * Math.sin(lat * rad)];
    const away = (v: number[]) => Math.hypot(v[0] - cam[0], v[1] - cam[1], v[2] - cam[2]);
    const { lng: cLng, lat: cLat } = this.map.getCenter();
    const px = away(ecef(sat[0], sat[1], 1 + sat[2] / 6371e3)) / away(ecef(cLng, cLat, 1));
    const swath: Array<{ polygon: number[]; alpha: number }> = [];
    if (!halfKm) return { px, swath, scanArc: null, seen: true };

    // Ground track sampled every 10 s from 20 min ago to 20 min ahead (computed ahead so the swath keeps growing),
    // recomputed once half the lead is used up. An optical swath dims with the light (sun from 10 deg down to 0:
    // no imaging in the dark) to a faint trace, instead of stopping with a hard edge on ground the map still shows lit.
    let tp = this.trackedPaths.get(id);
    if (!tp || tp.end - now < TRACKED_AHEAD_MS / 2 || now < tp.base + TRACKED_PAST_MS) { // last: clock reset
      const base = now - TRACKED_PAST_MS, end = now + TRACKED_AHEAD_MS;
      const line: number[] = [], light: number[] = [];
      for (let t = base; t <= end; t += TRACK_SAMPLE_MS) {
        const date = new Date(t);
        const q = this.calculateSatellitePosition(s.tle1, s.tle2, id, date);
        line.push(unwrapLng(q.longitude, line[line.length - 3]), q.latitude, 0);
        const elev = SolarCalculator.calculateSolarElevation(q.latitude, q.longitude, date);
        light.push(group?.night ? 1 : Math.max(0, Math.min(1, elev / MIN_SUN_ELEV_DEG)));
      }
      const heading = light.map((_, k) => { // ground track heading at each sample
        const a = Math.min(k, light.length - 2);
        return bearingDeg([line[3 * a], line[3 * a + 1]], [line[3 * a + 3], line[3 * a + 4]]);
      });
      tp = { base, end, line, light, heading };
      this.trackedPaths.set(id, tp);
      if (id === this.followingSatellite) { // the tiles where the camera is heading: its track ahead, a point a minute
        const ahead: number[][] = [];
        for (let k = Math.round(TRACKED_PAST_MS / TRACK_SAMPLE_MS); 3 * k < line.length; k += 6) ahead.push([line[3 * k], line[3 * k + 1]]);
        prefetchAround(ahead);
      }
    }
    // Swath half-width drawn: the real one, but at least ~1.5 px so a 5 km swath stays visible zoomed out
    const mpp = 40075016 * Math.cos(sat[1] * rad) / (512 * 2 ** this.map.getZoom()); // metres per pixel at the satellite
    const half = Math.max(halfKm, 1.5 * mpp / 1000);
    const across = (lng: number, lat: number, hd: number, steps: number) => acrossTrack(lng, lat, hd, half, steps);
    const scanArc = across(sat[0], sat[1], heading, SCAN_ARC_N);
    // Swath and scan line are drawn over everything (3D relief would cut them), so the Earth can't hide them past the
    // horizon: only what the camera sees of the ground (point . camera > 1, in Earth radii), a row with both ends in view
    const faces = (q: number[]) => {
      const lo = q[0] * rad, la = q[1] * rad;
      return Math.cos(la) * Math.cos(lo) * cam[0] + Math.cos(la) * Math.sin(lo) * cam[1] + Math.sin(la) * cam[2] > 1;
    };
    const L = tp.line, n = L.length / 3, scanSeen = faces(scanArc[0]) && faces(scanArc[SCAN_ARC_N]);

    // The swath painted over the last 20 min: quads between successive rows, the last one up to the scan line now, each
    // where both its rows are in view (the satellite itself may be past the horizon: what it painted this side stays).
    // Faded with age; full where it images, a faint trace in the dark (no imaging, but the path stays visible);
    // wide swaths (MODIS...) fill the view, so they're fainter.
    const m = half > 250 ? SWATH_ACROSS_N : 1; // narrow swaths are flat enough for one quad across
    const kh = Math.min(n - 1, Math.floor((now - tp.base) / TRACK_SAMPLE_MS)); // last sample before now
    const rows: Array<{ row: number[][]; seen: boolean }> = [];
    for (let k = 0; k <= kh; k++) {
      const row = across(L[3 * k], L[3 * k + 1], tp.heading[k], m);
      rows.push({ row, seen: faces(row[0]) && faces(row[m]) });
    }
    rows.push({ row: across(unwrapLng(sat[0], L[3 * kh]), sat[1], heading, m), seen: scanSeen });
    const base = halfKm > 250 ? 50 : 150;
    for (let k = 0; k + 1 < rows.length; k++) {
      const a = rows[k], b = rows[k + 1];
      const age = (now - tp.base) / TRACK_SAMPLE_MS - k; // in samples
      const alpha = base * (DARK_SWATH + (1 - DARK_SWATH) * tp.light[k]) * Math.max(0, 1 - age * TRACK_SAMPLE_MS / TRACKED_PAST_MS);
      if (alpha > 0 && a.seen && b.seen) for (const polygon of stripQuads(a.row, b.row)) swath.push({ polygon, alpha });
    }
    return { px, swath, scanArc, seen: scanSeen };
  }

  updateLayers(forceUpdate: boolean = false) {
    if (this.constellation) return; // drawn by the time-lapse frame loop
    if (this.followingSatellite && this.showTrackedSatelliteOnly) {
      this.renderTracked();
      return;
    }
    if (this.trackedOnGlobe) { // back to the flat overlay
      this.trackedOnGlobe = false;
      this.map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      this.constellationLayers = [];
      this.applyGlobeLayers();
      document.getElementById('deck-canvas')!.style.visibility = '';
    }
    const now = Date.now();
    const zoom = this.map.getZoom();
    const bounds = this.map.getBounds();
    
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



  // keepClock: from another satellite (its constellation's next), same time and speed
  // Track a satellite chosen on screen (a click, search, a mate): fly to its own view, as the landing does (that waits for
  // the flight to end; a fixed timer here started tracking mid-flight when tearing down a constellation held the flight up)
  followSatellite(satelliteId: string, keepClock = false) {
    const s = this.satellites.get(satelliteId);
    if (s) this.followSatelliteWithAnimation(satelliteId, s.defaultZoom ?? DEFAULT_ZOOM, s.defaultPitch ?? DEFAULT_PITCH, null, null, 2000, false, keepClock);
  }

  // Tracking view time (ms): real time when live, else the time-lapse clock
  simNow(): number {
    return this.trackLive ? Date.now() : this.trackSimT0 + (this.trackPaused ? 0 : (performance.now() - this.trackRealT0) * this.trackSpeed);
  }

  private setTrackTime(t: number) {
    this.trackSimT0 = t;
    this.trackRealT0 = performance.now();
    this.trackLive = false;
    document.getElementById('utc-label')!.textContent = 'Sim UTC';
  }

  private setTrackSpeed(speed: number) {
    this.setTrackTime(this.simNow());
    this.trackSpeed = this.smoothCamera.speed = speed;
  }

  // Tracking starts live, except from a constellation: it keeps the time-lapse's clock (time and speed), so the
  // satellite clicked is where it was and nothing changes speed behind the user's back
  private startTrackClock(satelliteId: string, keepClock = false) {
    if (keepClock && !this.constellation) return;
    const tl = this.constellation ? { t: this.tlSim, speed: this.tlSpeed, paused: !this.tlPlaying } : null;
    this.clearConstellation(satelliteId);
    this.resetTrackClock();
    if (tl) {
      this.setTrackTime(tl.t);
      this.trackSpeed = this.smoothCamera.speed = tl.speed;
      this.trackPaused = tl.paused;
    }
    this.syncTimeControls();
  }

  /** Jump the clock of the current view to t (ms since epoch); null = now (tracking: back to live). */
  setSimTime(t: number | null) {
    if (this.constellation) {
      this.anchorTimelapse(t ?? Date.now());
      return this.syncTimeControls();
    }
    if (t === null) this.resetTrackClock();
    else this.setTrackTime(t);
    this.syncTimeControls();
  }

  /** The current view's clock speed (x real time), and setting it (only one of SPEEDS). */
  getClockSpeed(): number {
    return this.constellation ? this.tlSpeed : this.trackSpeed;
  }

  setClockSpeed(speed: number) {
    if (!SPEEDS.includes(speed)) return;
    if (this.constellation) this.tlSpeed = speed;
    else this.setTrackSpeed(speed);
    this.syncTimeControls();
  }

  /** The current view's clock (ms since epoch). */
  clockNow(): number {
    return this.constellation ? this.tlSim : this.simNow();
  }

  /** Date and time in the time bar, at most 4 times a second. */
  showClock(t = this.clockNow()) {
    if (performance.now() - this.clockUiAt < 250) return;
    this.clockUiAt = performance.now();
    const iso = new Date(t).toISOString();
    document.getElementById('tl-date')!.textContent = iso.slice(0, 10);
    document.getElementById('utc-clock')!.textContent = iso.slice(11, 19);
  }

  /** Number of satellites in the constellation shown (0: none). */
  getConstellationSize(): number {
    return this.constellation?.length ?? 0;
  }

  // The time bar (bottom centre) drives whichever view is shown: play/pause, speed (a click steps x1 -> x10 -> x100 ->
  // x300), back to now (tracking: live; constellation: restart from now)
  private installTimeControls() {
    const $ = (id: string) => document.getElementById(id)!;
    $('tl-play').onclick = () => {
      if (this.constellation) this.tlPlaying = !this.tlPlaying;
      else {
        this.setTrackTime(this.simNow()); // a paused clock is a simulated one
        this.trackPaused = !this.trackPaused;
      }
      this.syncTimeControls();
    };
    $('tl-speed').onclick = () => {
      const next = SPEEDS[(SPEEDS.indexOf(this.constellation ? this.tlSpeed : this.trackSpeed) + 1) % SPEEDS.length];
      if (this.constellation) this.tlSpeed = next;
      else this.setTrackSpeed(next);
      this.syncTimeControls();
    };
    $('tl-reset').onclick = () => this.setSimTime(null);
    $('tl-cover').onclick = () => {
      this.tlWindowMs = COVER_WINDOWS_MS[(COVER_WINDOWS_MS.indexOf(this.tlWindowMs) + 1) % COVER_WINDOWS_MS.length];
      this.showCoverage();
    };
    this.syncTimeControls();
  }

  private syncTimeControls() {
    const playing = this.constellation ? this.tlPlaying : !this.trackPaused;
    const speed = this.constellation ? this.tlSpeed : this.trackSpeed;
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    const play = document.getElementById('tl-play')!, sp = document.getElementById('tl-speed')!, reset = document.getElementById('tl-reset')!;
    play.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor">${playing
      ? '<rect x="2" y="1" width="3" height="10" rx="1"/><rect x="7" y="1" width="3" height="10" rx="1"/>'
      : '<path d="M3 1.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 3 1.5z"/>'}</svg>`;
    play.title = playing ? 'Pause' : 'Play';
    sp.textContent = `×${speed}`;
    sp.title = `Speed ×${speed}: click for ×${next}`;
    reset.title = this.constellation ? 'Restart from now' : 'Back to live';
    for (const b of [play, sp, reset]) b.setAttribute('aria-label', b.title);
    this.showClock();
  }

  private resetTrackClock() {
    if (!this.trackLive) this.nightTimeSetter?.(null);
    this.trackLive = true;
    this.trackPaused = false;
    this.trackSpeed = this.smoothCamera.speed = 1;
    document.getElementById('utc-label')!.textContent = 'UTC';
  }

  // Where the tracking camera will be at time t (ms): smoothCamera's point of view, turned to the satellite's heading
  // (or `bearing`). Fly-ins end exactly there, so tracking takes over without the camera turning or sliding.
  private trackingCamera(sat: SatelliteData, t: number, bearing?: number) {
    const p = predictPosition(satellite.twoline2satrec(sat.tle1, sat.tle2), t)!; // as tracking will: no jump at the hand-off
    const c = this.smoothCamera;
    return framing([p.longitude, p.latitude], p.altitude, bearing ?? p.bearing! + c.headingOffset, c.pov, c.zoom, this.mapHeight).camera;
  }

  /** The tracking view of satellite `id` at time t (its map camera), and the ground point under the satellite */
  landingCamera(id: string, zoom: number, pitch: number, bearing: number | null, t: number) {
    const sat = this.satellites.get(id)!, p = predictPosition(satellite.twoline2satrec(sat.tle1, sat.tle2), t)!;
    const under: [number, number] = [p.longitude, p.latitude];
    return { under, camera: framing(under, p.altitude, bearing ?? p.bearing! + (sat.defaultBearing ?? 0), pitch, zoom, this.mapHeight).camera };
  }

  /** Its picture is loaded (or it has none) */
  iconReady(id: string): boolean {
    const s = this.satellites.get(id);
    return !s?.image || this.satelliteIcons.has(id);
  }

  // bearing: null = automatic (the ground track's heading); speed: null = the clock's default; quiet: no toast
  followSatelliteWithAnimation(satelliteId: string, targetZoom: number, targetPitch: number, bearing: number | null = null, speed: number | null = null,
    duration = FLY_DURATION_MS, quiet = false, keepClock = false) {
    this.startTrackClock(satelliteId, keepClock);
    const pictured = this.satellites.get(satelliteId);
    if (pictured?.image && !this.satelliteIcons.has(satelliteId)) this.loadSatelliteIcon(satelliteId, pictured.image);
    if (speed) this.setTrackSpeed(speed);
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
      
      this.smoothCamera.setUserControlledBearing(bearing !== null, bearing ?? undefined);
      this.smoothCamera.headingOffset = satellite.defaultBearing ?? 0;
      if (bearing === null) this.smoothCamera.startShow(); // a link's own bearing stays put; else the chase camera's drift
      this.smoothCamera.zoom = targetZoom;
      this.smoothCamera.pov = targetPitch;
      const end = this.trackingCamera(satellite, this.simNow() + duration * this.trackSpeed, bearing ?? undefined);
      this.map.flyTo({
        ...end,
        duration,
        essential: true
      });
      
      // Start tracking when the flyTo ends. Ignore a 'moveend' from some earlier camera move that ends
      // mid-flight (it would start tracking and cancel the flyTo); a timer guarantees tracking starts anyway.
      const flyStart = performance.now();
      this.flightUntil = flyStart + duration + 200;
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
        if (performance.now() - flyStart >= duration - 100) finish();
      };
      
      this.map.on('moveend', onFlyMoveEnd);
      setTimeout(finish, duration + 1500); // a flight held up (main thread busy) still ends with its moveend
      
      if (!quiet) this.showMessage(`Tracking ${displayName(satellite)}`, 'success');
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
    
    smoothTracker.clock = () => this.simNow();
    this.smoothTracker = smoothTracker;
    
    // Start the smooth tracker with satellite TLE data
    this.smoothTracker.startTracking(satellite.id, satellite.tle1, satellite.tle2);
    
    // Get initial position and start smooth camera tracking
    const initialPosition = this.smoothTracker.getPredictedPosition();
    this.smoothCamera.source = () => smoothTracker.getPredictedPosition();
    if (initialPosition) {
      this.smoothCamera.startSmoothTracking(initialPosition);
    }  }


  // Get smooth interpolated position for a satellite
  private getSmoothSatellitePosition(satelliteId: string) {
    const now = Date.now();
    return this.orbitalInterpolator.getInterpolatedPosition(satelliteId, now);
  }



  // Name of the constellation on view, or null while tracking a single satellite
  getConstellationName(): string | null {
    return this.constellation && this.constellationName;
  }

  // The tracking camera's zoom (around the satellite, equator-equivalent)
  getTrackingZoom(): number {
    return this.smoothCamera.zoom;
  }

  getFollowingSatellite(): string | null {
    return this.followingSatellite;
  }


  private showMessage(message: string, type: 'success' | 'error' | 'warning' | 'info') {
    document.querySelectorAll('.toast').forEach(t => t.remove()); // the newest replaces the last: they'd overlap
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
      }
      satelliteIndex++;
    }
    
    this.updateLayers();
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

  // Tracked satellite only filter methods
  setShowTrackedSatelliteOnly(enabled: boolean) {
    this.showTrackedSatelliteOnly = enabled;
    this.updateLayers(); // Refresh display
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

// Points across a ground track, along the ground: a great circle through (lng, lat) perpendicular to the heading, from
// -halfKm to +halfKm, at height z. The scan line, the swath's rows and the cone's base are all such arcs, so they meet
// exactly. A straight chord across a 2000 km swath runs ~100 km under the surface, and deck's wide paths are flat.
// ECI (km) at sidereal angle gmst -> [lng, lat, height in m], geodetic in one step (Bowring's latitude): satellite.js's
// eciToGeodetic iterates and costs twice SGP4 itself, too much for 10,000 satellites a frame
function eciToLngLatAlt(p: { x: number; y: number; z: number }, gmst: number): [number, number, number] {
  const A = 6378.137, E2 = 0.00669437999, B = A * Math.sqrt(1 - E2), EP2 = E2 / (1 - E2), deg = 180 / Math.PI;
  const c = Math.cos(gmst), sn = Math.sin(gmst);
  const x = p.x * c + p.y * sn, y = -p.x * sn + p.y * c, z = p.z, rho = Math.hypot(x, y);
  const u = Math.atan2(z * A, rho * B), su = Math.sin(u), cu = Math.cos(u);
  const lat = Math.atan2(z + EP2 * B * su * su * su, rho - E2 * A * cu * cu * cu);
  const sl = Math.sin(lat), N = A / Math.sqrt(1 - E2 * sl * sl);
  return [Math.atan2(y, x) * deg, lat * deg, (rho * Math.cos(lat) + z * sl - A * A / N) * 1000];
}

function acrossTrack(lng: number, lat: number, heading: number, halfKm: number, steps: number, z = 0): number[][] {
  return Array.from({ length: steps + 1 }, (_, i) => [...offsetPoint(lng, lat, heading + 90, halfKm * (2 * i / steps - 1)), z]);
}

// Quads between two rows of points, as closed flat [x, y, z, ...] rings, every lng next to the first one's (no ±180 jump)
function stripQuads(a: number[][], b: number[][]): number[][] {
  const at = (q: number[]) => [unwrapLng(q[0], a[0][0]), q[1], q[2]];
  return a.slice(1).map((_, j) => [a[j], a[j + 1], b[j + 1], b[j], a[j]].flatMap(at));
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
