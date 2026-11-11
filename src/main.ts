import { Map as MapLibreMap, AttributionControl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DeckSatelliteTracker } from './deck-satellite-tracker';
import { globeZoomShift } from './smooth-camera';
import { URLState } from './url-state';
import { CommandPalette } from './command-palette';
import { installNightShading } from './night-layer';
import { installSettings } from './settings';
import { CONSTELLATIONS, Constellation, constellationOf } from './config/satellites';
import { SearchComponent } from './components/search.component';
import { CockpitComponent } from './components/cockpit.component';
import { displayName } from './types/satellite';
import { SEOManager } from './seo-manager';

class SatelliteTracker3D {
  private map!: MapLibreMap;
  private satelliteTracker!: DeckSatelliteTracker;
  private isGlobeMode = true; // Start with globe projection
  private urlState = new URLState();
  private commandPalette!: CommandPalette;
  private nightShading?: { setTime(ms: number | null): void };
  private searchComponent!: SearchComponent;
  private _cockpitComponent!: CockpitComponent;
  private initialZoom!: number;
  private isInitializing = true;
  private lastURLState = { zoom: 0, pitch: 0, bearing: 0, satellite: '' }; // Track URL-relevant changes
  private lastFollowingSatellite: string | null = null; // Track when satellite changes

  constructor() {
    this.initializeMap();
    this.satelliteTracker = new DeckSatelliteTracker(this.map);
    this.satelliteTracker.setOnTrackingChangeCallback(() => { this.updateURL(); this.updateConstellationSlot(); });
    installSettings();
    this.installTimePicker();
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
    const initialBearing = this.urlState.getInitialBearing();
    const initialCoordinates = this.urlState.getInitialCoordinates();
    const initialSatellite = this.urlState.getInitialSatellite();
    
    // Always start at global view for smooth flyTo animation to satellites
    // If specific coordinates are provided AND no satellite is specified, use them
    const initialCenter: [number, number] = (!initialSatellite && initialCoordinates) ? initialCoordinates : [0, 0];
    
    
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
      zoom: initialSatellite ? 4 : this.initialZoom, // Start at safe zoom level to avoid terrain tile errors
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
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        minzoom: 1,
        maxzoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
      });
    }
    
    // Low-res underlay (<= 16 tiles for the whole Earth, same URLs so they share the HTTP cache): the globe is never
    // black and the sharp tiles fade in over a blurry Earth instead of popping in square by square.
    if (!this.map.getSource('esri-world-imagery-lowres')) {
      this.map.addSource('esri-world-imagery-lowres', {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
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

  private resetBearingToAutomatic() {
    const followingSatellite = this.satelliteTracker.getFollowingSatellite();
    if (followingSatellite) {
      const smoothCamera = this.satelliteTracker.getSmoothCamera();
      smoothCamera.setUserControlledBearing(false);
      this.showMessage('🧭 Bearing reset to automatic', 'info');
    }
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

      // Restore satellite tracking from URL if specified, otherwise default to ISS
      const satelliteToTrack = this.urlState.getInitialSatellite() || 'iss-zarya';
      const isDefaultISS = !this.urlState.getInitialSatellite(); // True if we're defaulting to ISS
      
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
          
          // Start satellite tracking immediately
          setTimeout(() => {
            const zoomToUse = isDefaultISS ? 4.7 : this.initialZoom;
            const pitchToUse = isDefaultISS ? 62 : this.urlState.getInitialPitch();
            
            
            const satellite = this.satelliteTracker.getSatellites().get(satelliteToTrack);
            
            // Use satellite-specific zoom and pitch if available
            const finalZoomToUse = satellite?.defaultZoom ?? zoomToUse;
            const finalPitchToUse = satellite?.defaultPitch ?? pitchToUse;
            
            console.log(`🎯 Tracking satellite "${satelliteToTrack}" with:`, {
              zoom: finalZoomToUse,
              pitch: finalPitchToUse,
              altitude: satellite?.altitude,
              position: satellite?.position ? `${satellite.position.lat.toFixed(2)}, ${satellite.position.lng.toFixed(2)}` : 'undefined'
            });
            
            if (satellite && satellite.position) {
              this.satelliteTracker.followSatelliteWithAnimation(
                satelliteToTrack, 
                finalZoomToUse,
                finalPitchToUse
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
            
            const zoomToUse = this.initialZoom;
            const pitchToUse = this.urlState.getInitialPitch();
            
            // Track the satellite immediately
            setTimeout(() => {
              this.satelliteTracker.followSatelliteWithAnimation(
                satelliteToTrack, 
                zoomToUse,
                pitchToUse
              );
            }, 100);
            
            setTimeout(() => {
              this.urlState.setInitializing(false);
              this.isInitializing = false;
            }, 3500);
          } else {
            // Fallback: if specific satellite not found, load ISS and all satellites
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

  private async openConstellation(group: Constellation, pushUrl = false) {
    this.isInitializing = true;
    this.urlState.setInitializing(true);
    if (pushUrl) this.urlState.navigateToGroup(group.id);
    if (!(await this.satelliteTracker.showConstellation(group, pushUrl ? 0 : this.urlState.getInitialPitch())) && this.satelliteTracker.loadConfigSatelliteById('iss-zarya')) {
      this.satelliteTracker.followSatelliteWithAnimation('iss-zarya', 4.7, 62); // load failed: fall back to the ISS
    }
    setTimeout(() => { this.urlState.setInitializing(false); this.isInitializing = false; }, 3500);
    this.updateUI();
    this.updateConstellationSlot();
  }

  // Click the banner clock (or the time-lapse date) to pick the simulated date and time, in UTC like the clock.
  // A native popover with a datetime-local field: Enter or Go jumps there, Now goes back to the present.
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
    document.getElementById('banner-display')!.addEventListener('click', e => {
      if (!(e.target as Element).closest('#utc-item, #tl-date-item')) return;
      input.min = iso(Date.now() - RANGE);
      input.max = iso(Date.now() + RANGE);
      input.value = iso(this.satelliteTracker.clockNow());
      pop.showPopover();
      input.focus();
    });
  }

  // While tracking a member of a constellation, the banner names it: a click opens the constellation
  private updateConstellationSlot() {
    document.querySelectorAll('.group-slot').forEach(e => e.remove());
    const group = constellationOf(this.satelliteTracker.getFollowingSatellite());
    if (!group) return;
    const t = document.createElement('template');
    t.innerHTML = `<div class="banner-item banner-extra group-slot"><span class="banner-label">Constellation</span>
      <button class="banner-value" title="View the ${group.name} constellation"></button></div>
      <div class="banner-separator banner-extra group-slot"></div>`;
    const btn = t.content.querySelector('button')!;
    btn.textContent = group.name;
    btn.onclick = () => this.openConstellation(group, true);
    document.querySelector('#banner-display .banner-left')!.prepend(...Array.from(t.content.children)); // the left has room
  }

  private updateURL() {
    // Skip URL updates during initialization to prevent premature updates
    if (this.isInitializing) {
      // Skipping URL update during initialization
      return;
    }
    
    const followingSatellite = this.satelliteTracker.getFollowingSatellite() || '';
    // While tracking, the URL keeps the equator-equivalent zoom (the camera shifts it with the latitude)
    const z = this.map.getZoom() - (followingSatellite ? globeZoomShift(this.map.getCenter().lat) : 0);
    const zoom = Math.round(z * 10) / 10; // Round to 1 decimal
    const pitch = Math.round(this.map.getPitch());
    const bearing = Math.round(this.map.getBearing());
    
    // Only update URL if values that are actually stored in URL have changed
    const hasChanged = 
      Math.abs(zoom - this.lastURLState.zoom) > 0.1 ||
      Math.abs(pitch - this.lastURLState.pitch) > 1 ||
      Math.abs(bearing - this.lastURLState.bearing) > 1 ||
      followingSatellite !== this.lastURLState.satellite;
    
    if (!hasChanged) {
      return; // No URL-relevant changes
    }
    
    // Update stored state
    this.lastURLState = { zoom, pitch, bearing, satellite: followingSatellite };
    
    this.urlState.updateURL(zoom, followingSatellite, pitch, bearing);
  }

  private setupURLSharing() {
    this.urlState.setupURLSharing(this.map, () => this.updateURL());
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
        
        // Control pitch with vertical mouse movement
        const currentPitch = this.map.getPitch();
        const newPitch = Math.min(85, Math.max(0, currentPitch + deltaY * 0.3));
        this.map.setPitch(newPitch);
        
        // Control bearing with horizontal mouse movement (only in tracking mode)
        if (isTracking && Math.abs(deltaX) > 1) { // Only activate on significant horizontal movement
          const smoothCamera = this.satelliteTracker.getSmoothCamera();
          const currentBearing = this.map.getBearing();
          const newBearing = (currentBearing + deltaX * 0.5) % 360;
          
          // Enable user-controlled bearing mode and show feedback on first use
          if (!smoothCamera.isUserControlledBearing()) {
            smoothCamera.setUserControlledBearing(true, newBearing);
            this.showMessage('🧭 Manual bearing control active (Press B to reset)', 'info');
          } else {
            smoothCamera.updateUserBearing(newBearing);
          }
          
          this.map.setBearing(newBearing);
        }
        
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
    const trackedPositionElement = document.getElementById('tracked-position');
    
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
    
    // Constellation view: the bar shows the constellation; per-satellite readouts are hidden (see cockpit.css)
    const constellation = this.satelliteTracker.getConstellationName();
    document.getElementById('banner-display')?.classList.toggle('constellation-mode', !!constellation);
    if (constellation) {
      if (trackedNameElement) trackedNameElement.textContent = constellation;
    } else if (followingSatellite) {
      const trackedSatellite = satellites.get(followingSatellite);
      if (trackedSatellite) {
        if (trackedAltitudeElement) trackedAltitudeElement.textContent = trackedSatellite.altitude.toFixed(0);
        if (trackedNameElement) trackedNameElement.textContent = displayName(trackedSatellite);
        if (trackedSpeedElement) trackedSpeedElement.textContent = trackedSatellite.velocity.toFixed(2);
        if (trackedPositionElement) trackedPositionElement.textContent = formatLatLng(trackedSatellite.position.lat, trackedSatellite.position.lng);
      }
    } else {
      // No satellite being tracked - show defaults
      if (trackedAltitudeElement) trackedAltitudeElement.textContent = '---';
      if (trackedNameElement) trackedNameElement.textContent = '---';
      if (trackedSpeedElement) trackedSpeedElement.textContent = '---';
      if (trackedPositionElement) trackedPositionElement.textContent = '---';
    }
    const utcClock = document.getElementById('utc-clock');
    if (utcClock && !constellation) utcClock.textContent = new Date(this.satelliteTracker.simNow()).toISOString().slice(11, 19);
  }
}

new SatelliteTracker3D();

const formatLatLng = (lat: number, lng: number) =>
  `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
