import { Map as MapLibreMap, AttributionControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DeckSatelliteTracker } from './deck-satellite-tracker';
import { URLState } from './url-state';
import { CommandPalette } from './command-palette';
import { installNightShading } from './night-layer';
import { ESRI_TILES, prefetchAround, prefetched } from './tile-prefetch';
import { openingCamera, OPENING } from './opening';
import { installSettings, settings } from './settings';
import { CONSTELLATIONS, Constellation, constellationOf } from './config/satellites';
import { SearchComponent } from './components/search.component';
import { CockpitComponent } from './components/cockpit.component';
import { displayName } from './types/satellite';
import { SEOManager } from './seo-manager';

const UNIFORM_TILES_DIST = 3; // see addDayBasemap

class SatelliteTracker3D {
  private map!: MapLibreMap;
  private satelliteTracker!: DeckSatelliteTracker;
  private isGlobeMode = true; // Start with globe projection
  private urlState = new URLState();
  private commandPalette!: CommandPalette;
  private nightShading?: ReturnType<typeof installNightShading>;
  private opening = false; // a satellite to land on: the opening first (opening.ts)
  private openingUnderway = false; // its orbit came, the opening runs (it ends the opening itself)
  private searchComponent!: SearchComponent;
  private _cockpitComponent!: CockpitComponent;
  private initialZoom!: number;
  private isInitializing = true;
  private lastURLState = {}; // what the URL keeps, to skip unchanged updates
  private lastFollowingSatellite: string | null = null; // Track when satellite changes

  constructor() {
    this.initializeMap();
    this.satelliteTracker = new DeckSatelliteTracker(this.map);
    this.satelliteTracker.setOnTrackingChangeCallback(() => { this.updateURL(); this.updateConstellationSlot(); });
    installSettings();
    this.installTimePicker();
    this.installShowGroup();
    this.satelliteTracker.setOnSatellitesLoadedCallback(() => {
      // Refresh command palette when satellites are loaded
      this.commandPalette?.refreshSatelliteList();
    });
    this.setupEventListeners();
    this.setupURLSharing();
    this.setupCommandPalette();
    this.setupSearchComponent();
    this.setupCockpitComponent();
    this.startTracking();
    
    // Temporary debugging - expose tracker to console
    (window as any).satelliteTracker = this.satelliteTracker;
  }

  private initializeMap() {
    // Get initial view from URL parameters (zoom, pitch, bearing, and satellite tracking)
    this.initialZoom = this.urlState.getInitialZoom();
    const initialPitch = this.urlState.getInitialPitch();
    const initialBearing = this.urlState.getNumber('bearing') ?? 0;
    const initialCoordinates = this.urlState.getInitialCoordinates();
    const initialSatellite = this.urlState.getInitialSatellite();
    
    // Always start at global view for smooth flyTo animation to satellites
    // If specific coordinates are provided AND no satellite is specified, use them
    const initialCenter: [number, number] = (!initialSatellite && initialCoordinates) ? initialCoordinates : [0, 0];
    this.opening = !this.urlState.getInitialGroup() && !(!initialSatellite && initialCoordinates);
    if (!this.opening) document.body.classList.remove('opening');
    else setTimeout(() => { if (!this.openingUnderway) this.endOpening(); }, 20000); // its orbit never came...: the Earth

    this.map = new MapLibreMap({
      container: 'map',
      style: {
        version: 8,
        sources: {},
        layers: [],
        // Thin limb glow + haze seen from orbit; fades out as we zoom toward the ground. Lit by the real sun (night-layer.ts).
        sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.45, 6, 0.3, 9, 0] }
      },
      center: initialCenter,
      // the opening: the bare globe whole, until the satellite's orbit comes and the camera goes over to it
      zoom: this.opening ? 1 : initialSatellite ? 4 : this.initialZoom, // Start at safe zoom level to avoid terrain tile errors
      pitch: initialPitch, // Use pitch from URL
      bearing: initialBearing, // Use bearing from URL
      attributionControl: false, // Disable default attribution control to avoid duplicates
      maxPitch: 85, // Allow up to 85 degrees tilt for 3D terrain viewing
      minZoom: -2, // room for geostationary orbits in the constellation view
      pitchWithRotate: false, // Disable pitch-with-rotate to avoid conflicts
      dragRotate: false, // Disable default drag rotate
      touchPitch: false, // Disable touch pitch
      canvasContextAttributes: { antialias: true } // smooth globe limb and overlay lines (MapLibre defaults to no MSAA)
    });

    // Disable MapLibre navigation control to avoid conflicts with Deck.gl
    // We'll handle pitch separately through the custom slider
    // const navControl = new NavigationControl();
    // this.map.addControl(navControl, 'top-right');
    
    // Add attribution control and ensure it's collapsed by default
    const attributionControl = new AttributionControl({ compact: true });
    this.map.addControl(attributionControl, 'bottom-right');
    
    // Force collapse the attribution after it's added with a slight delay
    setTimeout(() => {
      const attributionContainer = document.querySelector('.maplibregl-ctrl-attrib');
      if (attributionContainer) {
        attributionContainer.classList.remove('maplibregl-compact-show');
        attributionContainer.classList.add('maplibregl-compact');
      }
    }, 100);
    
    // Initialize with day basemap
    this.map.on('load', () => {
      this.addDayBasemap();
      this.nightShading = installNightShading(this.map, this.getFirstSatelliteLayerId());
      this.satelliteTracker.setNightTimeSetter(t => this.nightShading?.setTime(t));
      if (this.opening) { // hidden, still loading: the opening shows the bare globe and its atmosphere
        for (const id of ['esri-world-imagery-lowres', 'esri-world-imagery']) this.map.setPaintProperty(id, 'raster-opacity', 0);
        this.nightShading.setShown(0);
      }
      this.add3DTerrain();
      
      // Apply working pitch override from test page
      setTimeout(() => {
        this.applyPitchOverride();
      }, 500);
    });
    
    // Set up globe projection after style loads
    this.map.on('style.load', () => {
      this.setGlobeProjection();
    });
    
  }

  private addDayBasemap() {
    // Add Esri World Imagery as day basemap source and layer
    if (!this.map.getSource('esri-world-imagery')) {
      this.map.addSource('esri-world-imagery', {
        type: 'raster',
        tiles: [ESRI_TILES],
        // Declared 128 px (they're 256): MapLibre asks a level more detailed, so when the camera climbs and it drops a level,
        // the coarser tiles still match the screen's resolution instead of turning visibly blurry. ~4x the requests.
        tileSize: 128,
        minzoom: 1,
        maxzoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
      });
      // Esri's levels differ in colour (each is built from other imagery), so a pitched view mixing two or three of them
      // showed patches. One level, the centre's, up to UNIFORM_TILES_DIST x the distance to the centre; lower only beyond,
      // toward the horizon (all one level to it would be thousands of tiles with the camera low)
      (this.map.getSource('esri-world-imagery') as any).calculateTileZoom = (centerZoom: number, d2: number, dz: number, dCenter: number) =>
        centerZoom + Math.min(0, Math.log2(UNIFORM_TILES_DIST * dCenter / Math.hypot(d2, dz)));
    }
    
    // Low-res underlay (<= 16 tiles for the whole Earth, same URLs so they share the HTTP cache): the globe is never
    // black and the sharp tiles fade in over a blurry Earth instead of popping in square by square.
    if (!this.map.getSource('esri-world-imagery-lowres')) {
      this.map.addSource('esri-world-imagery-lowres', {
        type: 'raster',
        tiles: [ESRI_TILES],
        tileSize: 256,
        maxzoom: 2
      });
      this.map.addLayer({
        id: 'esri-world-imagery-lowres',
        type: 'raster',
        source: 'esri-world-imagery-lowres',
        paint: { 'raster-saturation': -0.25, 'raster-contrast': 0.1 }
      }, this.getFirstSatelliteLayerId());
    }

    if (!this.map.getLayer('esri-world-imagery')) {
      this.map.addLayer({
        id: 'esri-world-imagery',
        type: 'raster',
        source: 'esri-world-imagery',
        // Esri's low-zoom bathymetry is a saturated teal; pull it toward the deep navy seen from orbit
        paint: { 'raster-saturation': -0.25, 'raster-contrast': 0.1, 'raster-fade-duration': 600 }
      }, this.getFirstSatelliteLayerId());
    }
  }

  private add3DTerrain() {
    try {
      // Add terrain source using Terrarium terrain data (free)
      this.map.addSource('terrain', {
        type: 'raster-dem',
        tiles: [
          'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
        ],
        minzoom: 4,
        maxzoom: 15,
        tileSize: 256,
        encoding: 'terrarium' // Terrarium encoding format
      });

      // From orbit, true-scale relief is invisible and globe terrain draws lighter/darker tile patches over the
      // ocean; switch it on only once the camera is close enough to see mountains.
      const syncTerrain = () => {
        const want = this.map.getZoom() >= 8;
        if (want === !!this.map.getTerrain()) return;
        try {
          this.map.setTerrain(want ? { source: 'terrain', exaggeration: 1 } : null);
        } catch (error) {
          console.warn('Failed to toggle terrain:', error);
        }
      };
      syncTerrain();
      this.map.on('zoomend', syncTerrain);

      // Apply pitch override after terrain is added
      setTimeout(() => {
        this.applyPitchOverride();
      }, 100);
    } catch (error) {
      console.warn('Failed to add 3D terrain:', error);
    }
  }

  private setGlobeProjection() {
    try {
      this.map.setProjection({ type: 'globe' });
    } catch (error) {
      this.isGlobeMode = false;
    }
  }

  private toggleProjection() {
    try {
      if (this.isGlobeMode) {
        this.map.setProjection({ type: 'mercator' });
        this.isGlobeMode = false;
        this.showMessage('🗺️ Mercator projection enabled', 'info');
      } else {
        this.map.setProjection({ type: 'globe' });
        this.isGlobeMode = true;
        this.showMessage('🌍 Globe projection enabled', 'info');
      }
    } catch (error) {
      this.showMessage('⚠️ Projection switch failed', 'error');
    }
  }

  private toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        this.showMessage('🖥️ Fullscreen enabled', 'info');
      }).catch(() => {
        this.showMessage('⚠️ Fullscreen failed', 'error');
      });
    } else {
      document.exitFullscreen().then(() => {
        this.showMessage('🖥️ Fullscreen disabled', 'info');
      }).catch(() => {
        this.showMessage('⚠️ Exit fullscreen failed', 'error');
      });
    }
  }

  // Tilt the view by `deg`: while tracking, the camera's point of view on the satellite (it can go below it)
  private tilt(deg: number) {
    const cam = this.satelliteTracker.getSmoothCamera();
    if (cam.isTracking()) cam.pov = Math.min(180, Math.max(0, cam.pov + deg));
    else this.map.setPitch(Math.min(85, Math.max(0, this.map.getPitch() + deg)));
  }

  // Turn the view by `deg`: while tracking, the camera keeps that bearing (manual) until B
  private turn(deg: number) {
    const smoothCamera = this.satelliteTracker.getSmoothCamera();
    if (!this.satelliteTracker.getFollowingSatellite()) {
      this.map.setBearing(this.map.getBearing() + deg);
      return;
    }
    const newBearing = (smoothCamera.heading + deg) % 360; // the camera's bearing at the satellite
    if (!smoothCamera.isUserControlledBearing()) {
      smoothCamera.setUserControlledBearing(true, newBearing);
      this.showMessage('🧭 Manual bearing control active (Press B to reset)', 'info');
    } else {
      smoothCamera.updateUserBearing(newBearing);
    }
  }

  private resetBearingToAutomatic() {
    const followingSatellite = this.satelliteTracker.getFollowingSatellite();
    if (followingSatellite) {
      const smoothCamera = this.satelliteTracker.getSmoothCamera();
      smoothCamera.setUserControlledBearing(false);
      this.showMessage('🧭 Bearing reset to automatic', 'info');
      this.updateURL();
    }
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

  private getFirstSatelliteLayerId(): string | undefined {
    // Return the first satellite layer ID to ensure basemap layers are below satellites
    const satelliteLayers = ['satellites-main', 'satellites-iss-icon', 'satellites-starlink-icon', 'satellites-sentinel-icon'];
    for (const layerId of satelliteLayers) {
      if (this.map.getLayer(layerId)) {
        return layerId;
      }
    }
    return undefined;
  }

  private setupEventListeners() {

    // Add keyboard shortcut for projection toggle
    document.addEventListener('keydown', (e) => {
      // Only respond to shortcuts if no input elements are focused and the settings panel is closed (its Esc closes it)
      if (document.activeElement?.tagName === 'INPUT' || document.querySelector('dialog[open]')) {
        return;
      }
      
      if (e.key === 'g' || e.key === 'G') {
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          this.toggleProjection();
        }
      }
      
      // F key to toggle fullscreen
      if (e.key === 'f' || e.key === 'F') {
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          this.toggleFullscreen();
        }
      }
      
      // Escape key to stop satellite tracking
      if (e.key === 'Escape') {
        e.preventDefault();
        this.satelliteTracker.stopFollowing();
      }
      
      // B key to reset bearing to automatic mode
      if (e.key === 'b' || e.key === 'B') {
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          this.resetBearingToAutomatic();
        }
      }

      // Left / right: the previous / next satellite of the tracked one's constellation (EDC-01 ... EDC-08, around)
      const id = this.satelliteTracker.getFollowingSatellite(), group = constellationOf(id);
      if (!e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && id && group) {
        e.preventDefault();
        this.stepSatellite(id, group, e.key === 'ArrowRight' ? 1 : -1);
      }

      // Ctrl + arrows move the point of view (held down, they repeat): up/down climbs above the satellite or comes down
      // level with it (the pitch), left/right turns around it
      const step = (e.ctrlKey || e.metaKey) && { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -2], ArrowRight: [0, 2] }[e.key];
      if (step) {
        e.preventDefault();
        if (step[0]) this.tilt(step[0]);
        if (step[1]) this.turn(step[1]);
      }
    });
    
    
    // Add custom Ctrl+drag pitch handling that uses MapLibre directly
    this.setupCustomPitchControl();
  }

  private startTracking() {
    this.map.on('load', () => {
      // ?group=<id> opens a constellation overview instead of tracking one satellite
      const group = CONSTELLATIONS.find(g => g.id === this.urlState.getInitialGroup());
      if (group) {
        this.satelliteTracker.enableExternalSatelliteLoading();
        this.openConstellation(group);
        setInterval(() => this.updateUI(), 1000); // as when tracking: a click on a satellite starts tracking it
        return;
      }

      // The landing page: EDC-07 (YAM-16), with the rest of EarthDaily's constellation imaging around it
      const satelliteToTrack = this.urlState.getInitialSatellite() ?? 'yam-16';
      
      // Enable external satellite loading for search functionality
      this.satelliteTracker.enableExternalSatelliteLoading();
      // Keep showing only tracked satellite for performance
      this.satelliteTracker.setShowTrackedSatelliteOnly(true);
      
      // Check if satellite is in config and has TLE data for instant loading
      const configSatellite = this.satelliteTracker.getSatelliteConfigs().find(sat => sat.id === satelliteToTrack);
      
      if (configSatellite && configSatellite.tle1 && configSatellite.tle2) {
        
        // Load config satellite immediately (no API dependency)
        const satelliteLoaded = this.satelliteTracker.loadConfigSatelliteById(satelliteToTrack);
        
        if (satelliteLoaded) {
          // Start layers and background updates immediately
          this.satelliteTracker.updateLayers();
          this.satelliteTracker.startBackgroundUpdates();
          
          // Satellites will be loaded on-demand when searching
          
          if (this.opening) {
            this.open(satelliteToTrack);
            return;
          }
          // Start satellite tracking immediately
          setTimeout(() => {
            const satellite = this.satelliteTracker.getSatellites().get(satelliteToTrack);
            // The URL's view wins (a shared link), then the satellite's own defaults
            const url = (key: string) => this.urlState.getNumber(key);
            if (satellite && satellite.position) {
              this.satelliteTracker.followSatelliteWithAnimation(
                satelliteToTrack,
                url('zoom') ?? satellite.defaultZoom ?? 4.7,
                url('pitch') ?? satellite.defaultPitch ?? 62,
                url('bearing'),
                url('speed')
              );
            } else {
              console.warn(`⚠️ Satellite "${satelliteToTrack}" not found or has no position`);
            }
            
          }, 100); // Very short delay for satellite tracking
          
          setTimeout(() => {
            this.urlState.setInitializing(false);
            this.isInitializing = false;
          }, 3500); // flyTo lasts 3s: stay "initializing" until it ends so the URL never records a mid-flight zoom
        }
      } else {
        // For non-config satellites, load just the specific satellite first
        setTimeout(async () => {
          // Re-enable external satellite loading for specific satellite requests
          this.satelliteTracker.enableExternalSatelliteLoading();
          
          // Try to load just the specific satellite we need
          const targetSatellite = await this.satelliteTracker.loadSpecificSatellite(satelliteToTrack);
          
          if (targetSatellite) {
            // Start layers and updates with just this satellite
            this.satelliteTracker.updateLayers();
            this.satelliteTracker.startBackgroundUpdates();
            
            // Satellites will be loaded on-demand when searching
            
            if (this.opening) {
              this.open(satelliteToTrack);
              return;
            }
            // Track the satellite immediately
            setTimeout(() => {
              const satellite = this.satelliteTracker.getSatellites().get(satelliteToTrack);
              this.satelliteTracker.followSatelliteWithAnimation( // as above: the URL's view, then the satellite's defaults
                satelliteToTrack,
                this.urlState.getNumber('zoom') ?? satellite?.defaultZoom ?? 4.7,
                this.urlState.getNumber('pitch') ?? satellite?.defaultPitch ?? 62,
                this.urlState.getNumber('bearing'),
                this.urlState.getNumber('speed')
              );
            }, 100);
            
            setTimeout(() => {
              this.urlState.setInitializing(false);
              this.isInitializing = false;
            }, 3500);
          } else {
            // Fallback: if specific satellite not found, load ISS and all satellites
            this.endOpening(); // nothing to open on: the Earth now, not a black screen
            const issLoaded = this.satelliteTracker.loadConfigSatelliteById('iss-zarya');
            if (issLoaded) {
              this.satelliteTracker.updateLayers();
              this.satelliteTracker.startBackgroundUpdates();
              this.satelliteTracker.followSatelliteWithAnimation('iss-zarya', 4.7, 62);
              
              // Satellites will be loaded on-demand when searching
            } else {
              this.urlState.removeInvalidSatellite();
            }
            
            setTimeout(() => {
              this.urlState.setInitializing(false);
              this.isInitializing = false;
            }, 4000);
          }
        }, 500);
      }
      
      this.updateUI();
      setInterval(() => this.updateUI(), 1000); // HUD readouts: the ISS covers ~8 km every second
    });
  }

  private async stepSatellite(id: string, group: Constellation, step: number) {
    const t = this.satelliteTracker, ids = await t.constellationMembers(group);
    const name = (k: string) => t.getSatellites().get(k)!.name;
    ids.sort((a, b) => name(a).localeCompare(name(b), 'en', { numeric: true }));
    const next = ids[(ids.indexOf(id) + step + ids.length) % ids.length];
    if (!next || next === id || t.getFollowingSatellite() !== id) return; // alone, or the user moved on meanwhile
    t.followSatellite(next, true);
    this.updateSEOForSatellite(next);
  }

  private async openConstellation(group: Constellation, pushUrl = false) {
    this.isInitializing = true;
    this.urlState.setInitializing(true);
    if (pushUrl) this.urlState.navigateToGroup(group.id);
    const shown = await this.satelliteTracker.showConstellation(group, pushUrl ? 0 : this.urlState.getInitialPitch());
    if (!shown) this.showMessage(`Could not load the ${group.name} constellation`, 'error');
    if (!shown && this.satelliteTracker.loadConfigSatelliteById('iss-zarya')) {
      this.satelliteTracker.followSatelliteWithAnimation('iss-zarya', 4.7, 62); // load failed: fall back to the ISS
    } else if (shown && !pushUrl) {
      const speed = this.urlState.getNumber('speed');
      if (speed) this.satelliteTracker.setClockSpeed(speed);
    }
    setTimeout(() => { this.urlState.setInitializing(false); this.isInitializing = false; }, 3500);
    this.updateUI();
    this.updateConstellationSlot();
  }

  // Click the clock in the time bar to pick the simulated date and time, in UTC like the clock.
  // A native popover with a datetime-local field: Enter or Go jumps there, Now goes back to the present.
  // While tracking a constellation's satellite, moving the pointer shows a button back to the whole constellation; it
  // hides again once the pointer rests (not while it is on the button)
  private installShowGroup() {
    const btn = document.getElementById('show-group') as HTMLButtonElement;
    let idle: ReturnType<typeof setTimeout>;
    const hide = () => { if (!btn.matches(':hover')) btn.classList.remove('show'); };
    addEventListener('pointermove', () => {
      const group = constellationOf(this.satelliteTracker.getFollowingSatellite());
      btn.classList.toggle('show', !!group);
      if (!group) return;
      btn.textContent = `Show the ${group.name} constellation`;
      btn.onclick = () => { btn.classList.remove('show'); this.openConstellation(group, true); };
      clearTimeout(idle);
      idle = setTimeout(hide, 2500);
    });
  }

  private installTimePicker() {
    const DAY = 24 * 3600e3, RANGE = 30 * DAY; // ponytail: TLEs drift by tens of km a month from their epoch; widen with archived TLEs
    const pop = document.createElement('form');
    pop.id = 'time-picker';
    pop.popover = 'auto';
    pop.innerHTML = `<label>Date and time (UTC) <input type="datetime-local" step="1" required></label>
      <div><button type="button" value="now">Now</button><button>Go</button></div>`;
    document.body.appendChild(pop);
    const input = pop.querySelector('input')!;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 19);
    pop.onsubmit = e => {
      e.preventDefault();
      const t = Date.parse(input.value + 'Z');
      if (Number.isNaN(t)) return;
      this.satelliteTracker.setSimTime(t);
      pop.hidePopover();
    };
    pop.querySelector<HTMLButtonElement>('button[value=now]')!.onclick = () => {
      this.satelliteTracker.setSimTime(null);
      pop.hidePopover();
    };
    document.getElementById('time-set')!.addEventListener('click', () => {
      input.min = iso(Date.now() - RANGE);
      input.max = iso(Date.now() + RANGE);
      input.value = iso(this.satelliteTracker.clockNow());
      pop.showPopover();
      input.focus();
    });
  }

  // Around the name in the dock: a tracked satellite's constellation before it, as a breadcrumb (a click opens the
  // constellation), or a constellation's size after it
  // The opening (opening.ts): the bare globe, held until the landing view is loaded out of sight (or OPENING.MAX_MS), then
  // the imagery fades in and the camera dives to the satellite; the top bar comes once it has arrived
  // The night lights first, the day imagery half a beat behind: together, the day showed through the half-faded night side
  private reveal(ms: number) {
    for (const layer of ['esri-world-imagery-lowres', 'esri-world-imagery']) {
      this.map.setPaintProperty(layer, 'raster-opacity-transition', { duration: ms, delay: ms / 2 });
      this.map.setPaintProperty(layer, 'raster-opacity', 1);
    }
    this.nightShading?.setShown(1, ms);
  }

  // The opening gave up (no satellite, an error, too long): just the Earth, as it is, never a black screen
  private endOpening() {
    if (!document.body.classList.contains('opening')) return;
    if (this.map.getLayer('esri-world-imagery')) this.reveal(0);
    document.body.classList.remove('opening');
    this.urlState.setInitializing(false);
    this.isInitializing = false;
  }

  private async open(id: string) {
    try {
      await this.openOn(id);
    } catch (error) {
      console.error('Opening failed:', error);
      this.endOpening();
    }
  }

  private async openOn(id: string) {
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)), url = (key: string) => this.urlState.getNumber(key);
    for (let i = 0; i < 40 && !this.satelliteTracker.getSatellites().get(id)?.position; i++) await sleep(50); // its first position
    const sat = this.satelliteTracker.getSatellites().get(id);
    const reveal = (ms: number) => this.reveal(ms);
    if (!sat?.position) { // nothing to land on: just the Earth
      this.endOpening();
      return console.warn(`Satellite "${id}" not found or has no position`);
    }
    this.openingUnderway = true;
    const zoom = url('zoom') ?? sat.defaultZoom ?? 4.7, pitch = url('pitch') ?? sat.defaultPitch ?? 62;
    // Its position is known only now (its orbit is fetched, up to ~20 s when CelesTrak throttles): over to it from the
    // whole globe, then creeping closer while the landing view loads
    const { under, camera } = this.satelliteTracker.landingCamera(id, zoom, pitch, url('bearing'), Date.now() + OPENING.MIN_MS + OPENING.DIVE_MS);
    const centre = camera.center;
    prefetchAround([under, centre, [2 * centre[0] - under[0], 2 * centre[1] - under[1]]]); // and on toward the horizon
    this.map.easeTo({ ...openingCamera(camera), duration: OPENING.APPROACH_MS });
    await sleep(OPENING.APPROACH_MS);
    this.map.easeTo({ ...openingCamera(camera, true), duration: OPENING.MAX_MS, easing: t => t });
    await Promise.race([sleep(OPENING.MAX_MS), (async () => {
      await Promise.all([sleep(OPENING.MIN_MS), prefetched()]);
      while (!this.map.areTilesLoaded() || !this.satelliteTracker.iconReady(id)) await sleep(100);
    })()]);
    reveal(OPENING.REVEAL_MS);
    await sleep(OPENING.REVEAL_MS * 0.6);
    this.satelliteTracker.followSatelliteWithAnimation(id, zoom, pitch, url('bearing'), url('speed'), OPENING.DIVE_MS, true);
    await sleep(OPENING.DIVE_MS + 300);
    document.body.classList.remove('opening');
    this.urlState.setInitializing(false);
    this.isInitializing = false;
  }

  private updateConstellationSlot() {
    const parent = document.getElementById('tracked-parent')!, count = document.getElementById('tracked-count')!;
    parent.textContent = count.textContent = '';
    const n = this.satelliteTracker.getConstellationSize();
    const dense = this.satelliteTracker.getConstellationShells(), key = document.getElementById('constellation-key')!;
    key.hidden = !dense;
    if (dense) {
      key.innerHTML = '<span>Each ring is one orbital plane: its satellites follow each other around it.</span><span></span>';
      key.lastElementChild!.append(...dense.shells.filter(s => s.n >= 20).map(s => { // a handful of strays isn't a shell
        const item = document.createElement('span'), line = document.createElement('i');
        line.style.background = `rgb(${s.color})`;
        item.append(line, `${Math.round(s.inc)}° · ${s.n.toLocaleString('en')}`);
        return item;
      }));
    }
    if (n) {
      count.textContent = `· ${n.toLocaleString('en')} satellite${n > 1 ? 's' : ''}${dense ? ` · ${dense.planes} planes` : ''}`;
      return;
    }
    const group = constellationOf(this.satelliteTracker.getFollowingSatellite());
    if (!group) return;
    const btn = document.createElement('button');
    btn.textContent = group.name;
    btn.title = `View the ${group.name} constellation`;
    btn.onclick = () => this.openConstellation(group, true);
    const sep = document.createElement('span');
    sep.textContent = '›';
    sep.setAttribute('aria-hidden', 'true');
    parent.append(btn, sep);
  }

  private updateURL() {
    // Skip URL updates during initialization to prevent premature updates
    if (this.isInitializing) {
      // Skipping URL update during initialization
      return;
    }
    
    if (this.satelliteTracker.getSmoothCamera().onShow()) return; // drifting on its own: the URL keeps where it began
    const followingSatellite = this.satelliteTracker.getFollowingSatellite() || '';
    // While tracking, the URL keeps the camera's zoom around the satellite (the map's own zoom is derived from it)
    const z = followingSatellite ? this.satelliteTracker.getTrackingZoom() : this.map.getZoom();
    const zoom = Math.round(z * 10) / 10; // Round to 1 decimal
    const pitch = Math.round(followingSatellite ? this.satelliteTracker.getSmoothCamera().pov : this.map.getPitch());
    // Tracking: 'auto' (the camera turns with the ground track) unless the user turned it, then its heading at the
    // satellite; elsewhere the map's bearing, left out when north is up
    const cam = this.satelliteTracker.getSmoothCamera();
    const deg = (b: number) => String((Math.round(b) % 360 + 360) % 360);
    const bearing = followingSatellite ? (cam.isUserControlledBearing() ? deg(cam.heading) : 'auto') // swaying: still 'auto'
      : deg(this.map.getBearing()) === '0' ? null : deg(this.map.getBearing());
    const speed = this.satelliteTracker.getClockSpeed();
    const defaultSpeed = this.satelliteTracker.getConstellationName() ? settings.speed : 1;
    const state = { zoom, pitch, bearing, speed: speed === defaultSpeed ? null : String(speed), satellite: followingSatellite };
    if (JSON.stringify(state) === JSON.stringify(this.lastURLState)) return; // nothing the URL keeps has changed
    this.lastURLState = state;
    this.urlState.updateURL(zoom, followingSatellite, followingSatellite || pitch >= 1 ? String(pitch) : null, state.bearing, state.speed);
  }

  private setupURLSharing() {
    this.urlState.setupURLSharing(this.map, () => this.updateURL());
    document.getElementById('tl-speed')!.addEventListener('click', () => this.updateURL()); // the camera may not move
  }

  private setupCommandPalette() {
    this.commandPalette = new CommandPalette();
    
    // Set up command palette callbacks
    this.commandPalette.setCallbacks({
      onTrackSatellite: async (satelliteId: string) => {
        if (satelliteId.startsWith('group:')) {
          const group = CONSTELLATIONS.find(g => g.id === satelliteId.slice(6));
          if (group) await this.openConstellation(group, true);
          return;
        }
        // Load satellite from search database if not already active
        if (!this.satelliteTracker.getSatellites().has(satelliteId)) {
          // Not in the (possibly empty) search database -> fetch just this satellite
          if (!this.satelliteTracker.loadSatelliteFromSearchDatabase(satelliteId)) {
            await this.satelliteTracker.loadSpecificSatellite(satelliteId);
          }
        }
        this.satelliteTracker.followSatellite(satelliteId);
        
        // Update SEO meta tags for the tracked satellite
        this.updateSEOForSatellite(satelliteId);
      },
      getSatellites: () => {
        return this.satelliteTracker.getSatellites();
      },
      getSearchDatabase: () => {
        return this.satelliteTracker.getSearchDatabase();
      },
      loadSearchDatabase: async () => {
        await this.satelliteTracker.loadAllSatellitesForSearch();
      },
      getSatelliteConfigs: () => this.satelliteTracker.getSatelliteConfigs(),
      getConstellations: () => CONSTELLATIONS.map(g => ({ id: `group:${g.id}`, name: `${g.name} constellation` })),
      searchRemote: (q: string) => this.satelliteTracker.searchRemote(q)
    });
  }

  private setupSearchComponent() {
    this.searchComponent = new SearchComponent();
    
    // Set up search component callbacks - same as command palette
    this.searchComponent.setCallbacks({
      onSatelliteSelect: (satelliteId: string) => {
        this.satelliteTracker.followSatellite(satelliteId);
        
        // Update SEO meta tags for the tracked satellite
        this.updateSEOForSatellite(satelliteId);
      },
      getSatellites: () => {
        return this.satelliteTracker.getSatellites();
      }
    });
  }

  private setupCockpitComponent() {
    this._cockpitComponent = new CockpitComponent();
    // Pass the command palette instance so it can open it
    this._cockpitComponent.setCommandPalette(this.commandPalette);
    // Reference it to satisfy TypeScript unused variable check
    void this._cockpitComponent;
  }

  /**
   * Update SEO meta tags when tracking a specific satellite
   */
  private updateSEOForSatellite(satelliteId: string) {
    // Get satellite data from active satellites or search database
    let satellite = this.satelliteTracker.getSatellites().get(satelliteId);
    if (!satellite) {
      satellite = this.satelliteTracker.getSearchDatabase().get(satelliteId);
    }

    if (satellite) {
      SEOManager.updateMetaForSatellite({
        id: satelliteId,
        name: satellite.name,
        alternateName: satellite.alternateName,
        type: satellite.type,
        altitude: satellite.altitude,
        image: satellite.image
      });

      // Update URL state to reflect the tracked satellite
      this.urlState.navigateToSatellite(satelliteId);
    } else {
      console.warn(`Could not find satellite data for SEO update: ${satelliteId}`);
    }
  }

  private applyPitchOverride() {
    const map = this.map as any;
    
    try {
      // Standard API - this is the correct way to set max pitch
      map.setMaxPitch(85);
      
    } catch (error) {
    }
  }

  private setupCustomPitchControl() {
    let isDragging = false;
    let lastY = 0;
    let lastX = 0;
    
    
    // Attach to document to catch all events
    document.addEventListener('mousedown', (e) => {
      const isTracking = this.satelliteTracker.getFollowingSatellite() !== null;
      
      // In tracking mode: any drag works, otherwise need Ctrl
      if (isTracking || e.ctrlKey || e.metaKey) {
        isDragging = true;
        lastY = e.clientY;
        lastX = e.clientX;
        e.preventDefault();
      }
    });
    
    document.addEventListener('mousemove', (e) => {
      const isTracking = this.satelliteTracker.getFollowingSatellite() !== null;
      
      // In tracking mode: any drag works, otherwise need Ctrl  
      if (isDragging && (isTracking || e.ctrlKey || e.metaKey)) {
        const deltaY = lastY - e.clientY;
        const deltaX = e.clientX - lastX;
        
        this.tilt(deltaY * 0.3); // Control pitch with vertical mouse movement
        
        if (Math.abs(deltaX) > 1) this.turn(deltaX * 0.5); // bearing with horizontal movement (only a significant one)
        
        lastY = e.clientY;
        lastX = e.clientX;
        e.preventDefault();
      }
    });
    
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
      }
    });
    
  }

  private updateUI() {
    const satellites = this.satelliteTracker.getSatellites();
    const followingSatellite = this.satelliteTracker.getFollowingSatellite();

    // Update status displays
    const trackedAltitudeElement = document.getElementById('tracked-altitude');
    const trackedNameElement = document.getElementById('tracked-name');
    const trackedSpeedElement = document.getElementById('tracked-speed');
    
    // Update search component with current following satellite
    this.searchComponent?.setFollowingSatellite(followingSatellite);
    
    // Only update search input when the satellite actually changes
    if (followingSatellite !== this.lastFollowingSatellite) {
      this.lastFollowingSatellite = followingSatellite;
      
      if (followingSatellite) {
        const trackedSatellite = satellites.get(followingSatellite);
        if (trackedSatellite) {
          // Update search input with current satellite name only when satellite changes
          this.searchComponent?.updateSearchInput(displayName(trackedSatellite));
        }
      } else {
        // Clear search input only when stopping tracking
        this.searchComponent?.updateSearchInput('');
      }
    }
    
    // The satellite's figures (in the dock) only while tracking one
    const constellation = this.satelliteTracker.getConstellationName();
    document.body.classList.toggle('tracking-mode', !constellation && !!followingSatellite);
    if (constellation) {
      if (trackedNameElement) trackedNameElement.textContent = constellation;
    } else if (followingSatellite) {
      const trackedSatellite = satellites.get(followingSatellite);
      if (trackedSatellite) {
        if (trackedAltitudeElement) trackedAltitudeElement.textContent = trackedSatellite.altitude.toFixed(0);
        if (trackedNameElement) trackedNameElement.textContent = displayName(trackedSatellite);
        if (trackedSpeedElement) trackedSpeedElement.textContent = trackedSatellite.velocity.toFixed(2);
      }
    } else {
      // No satellite being tracked - show defaults
      if (trackedAltitudeElement) trackedAltitudeElement.textContent = '---';
      if (trackedNameElement) trackedNameElement.textContent = '---';
      if (trackedSpeedElement) trackedSpeedElement.textContent = '---';
    }
    if (!constellation && !followingSatellite) this.satelliteTracker.showClock(); // nothing else is drawing (and ticking the clock)
  }
}

new SatelliteTracker3D();
