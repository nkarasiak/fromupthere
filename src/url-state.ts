import { resolveSatelliteId } from './config/satellites';

// '' in dev, '/fromupthere' on GitHub Pages (Vite base without trailing slash)
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const routePath = () => window.location.pathname.slice(BASE.length) || '/';

export class URLState {
  private isInitializing = true;

  constructor() {
    // Handle URL rewriting on initialization
    this.handleUrlRewriting();
  }

  private handleUrlRewriting() {
    const path = routePath();
    
    // Handle /satellite-id format - keep the new format, don't rewrite it
    const satelliteMatch = path.match(/^\/([^\/]+)$/);
    if (satelliteMatch && path !== '/') {
      // New format is already correct, just return
      return;
    }
    
    // Handle old /tracker/id format - convert to new format
    const trackerMatch = path.match(/^\/tracker\/([^\/]+)$/);
    if (trackerMatch) {
      const url = new URL(window.location.href);
      url.pathname = `${BASE}/${encodeURIComponent(trackerMatch[1])}`;
      window.history.replaceState({}, '', url.toString());
      return;
    }
    
    // Handle old format ?satellite=id - convert to new format
    const urlParams = new URLSearchParams(window.location.search);
    const satelliteParam = urlParams.get('satellite');
    if (satelliteParam && path === '/') {
      const url = new URL(window.location.href);
      url.pathname = `${BASE}/${encodeURIComponent(satelliteParam)}`;
      url.searchParams.delete('satellite');
      window.history.replaceState({}, '', url.toString());
      return;
    }
    
    // Handle GitHub Pages redirect parameter
    const redirectUrlParams = new URLSearchParams(window.location.search);
    const redirectPath = redirectUrlParams.get('redirect');
    if (redirectPath) {
      // Handle both new /satellite-id and old /tracker/id formats
      const satelliteMatch = redirectPath.match(/^\/([^\/]+)$/);
      const trackerMatch = redirectPath.match(/^\/tracker\/([^\/]+)$/);
      
      if (satelliteMatch && redirectPath !== '/') {
        const satelliteId = decodeURIComponent(satelliteMatch[1]);
        const url = new URL(window.location.href);
        url.pathname = `${BASE}/${encodeURIComponent(satelliteId)}`;
        redirectUrlParams.delete('redirect');
        url.search = redirectUrlParams.toString();
        window.history.replaceState({}, '', url.toString());
      } else if (trackerMatch) {
        const satelliteId = decodeURIComponent(trackerMatch[1]);
        const url = new URL(window.location.href);
        url.pathname = `${BASE}/${encodeURIComponent(satelliteId)}`;
        redirectUrlParams.delete('redirect');
        url.search = redirectUrlParams.toString();
        window.history.replaceState({}, '', url.toString());
      }
    }
  }

  setInitializing(state: boolean) {
    this.isInitializing = state;
  }

  getInitialZoom(): number {
    const urlParams = new URLSearchParams(window.location.search);
    const providedZoom = urlParams.get('zoom');
    
    // If zoom is explicitly provided, use it
    if (providedZoom !== null) {
      return parseFloat(providedZoom);
    }
    
    // If we're on a satellite path (not homepage), provide better defaults
    const path = routePath();
    const satelliteMatch = path.match(/^\/([^\/]+)$/);
    if (satelliteMatch && path !== '/') {
      return 4.7; // Default zoom for satellite tracking
    }
    
    return 0; // Homepage: a small Earth far away, then the opening closes on EDC-07 (main.ts)
  }

  getInitialPitch(): number {
    const urlParams = new URLSearchParams(window.location.search);
    const providedPitch = urlParams.get('pitch');
    
    // If pitch is explicitly provided, use it
    if (providedPitch !== null) {
      return parseFloat(providedPitch);
    }
    
    // If we're on a satellite path (not homepage), provide better defaults
    const path = routePath();
    const satelliteMatch = path.match(/^\/([^\/]+)$/);
    if (satelliteMatch && path !== '/') {
      return 62; // Default pitch for satellite tracking (looking up)
    }
    
    return 0; // Default for homepage
  }

  // The landing page (no satellite, no place in the URL) is EarthDaily's constellation, as ?group=edc
  getInitialGroup(): string | null {
    const group = new URLSearchParams(window.location.search).get('group');
    return group ?? (this.getInitialSatellite() || this.getInitialCoordinates() ? null : 'edc');
  }

  navigateToGroup(groupId: string) {
    const url = new URL(window.location.href);
    url.pathname = `${BASE}/`;
    url.search = `?group=${encodeURIComponent(groupId)}`;
    window.history.pushState({}, '', url.toString());
  }

  // A number from the URL, or null when absent or not a number (bearing=auto)
  getNumber(key: string): number | null {
    const v = new URLSearchParams(window.location.search).get(key);
    return v === null || !Number.isFinite(parseFloat(v)) ? null : parseFloat(v);
  }

  getInitialSatellite(): string | null {
    // First check if we're on a /satellite-id path
    const path = routePath();
    const satelliteMatch = path.match(/^\/([^\/]+)$/);
    if (satelliteMatch && path !== '/') {
      return resolveSatelliteId(decodeURIComponent(satelliteMatch[1]));
    }
    
    // Fall back to query parameters
    const urlParams = new URLSearchParams(window.location.search);
    // Support both 'satellite' and 'name' parameters for satellite ID
    return urlParams.get('satellite') || urlParams.get('name');
  }

  getInitialCoordinates(): [number, number] | null {
    const urlParams = new URLSearchParams(window.location.search);
    const x = urlParams.get('x');
    const y = urlParams.get('y');
    
    if (x && y) {
      return [parseFloat(x), parseFloat(y)];
    }
    return null;
  }

  // bearing: 'auto', degrees, or null (north up); speed: null for the view's default
  updateURL(zoom: number, followingSatellite: string | null, pitch: string | null, bearing: string | null, speed: string | null) {
    if (this.isInitializing) {
      // Skipping URL update during initialization
      return;
    }
    
    const url = new URL(window.location.href);
    const originalUrl = url.toString();
    
    let urlChanged = false;
    
    // Handle satellite tracking with pretty URLs
    const currentPath = routePath();
    const isCurrentlySatellitePath = currentPath.match(/^\/([^\/]+)$/) && currentPath !== '/';
    const currentSatellite = isCurrentlySatellitePath ? decodeURIComponent(currentPath.substring(1)) : url.searchParams.get('satellite');
    
    if (followingSatellite !== currentSatellite) {
      if (followingSatellite) {
        // Use pretty URL format /satellite-id
        url.pathname = `${BASE}/${encodeURIComponent(followingSatellite)}`;
      } else {
        // No satellite tracking, go back to home
        url.pathname = `${BASE}/`;
      }
      // Clear satellite query parameter when using path-based routing
      url.searchParams.delete('satellite');
      if (followingSatellite) url.searchParams.delete('group');
      urlChanged = true;
    }
    
    // View parameters as query strings (null: left out); x,y are never kept
    const put = (key: string, value: string | null) => value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value);
    put('x', null);
    put('y', null);
    put('zoom', zoom.toFixed(1));
    put('pitch', pitch);
    put('bearing', bearing);
    put('speed', speed);
    urlChanged = true;

    // Only update URL if something actually changed
    if (urlChanged && url.toString() !== originalUrl) {
      window.history.replaceState({}, '', url.toString());
    }
  }

  removeInvalidSatellite() {
    const url = new URL(window.location.href);
    // If we're on a satellite path, go back to home
    if (routePath().match(/^\/([^\/]+)$/) && routePath() !== '/') {
      url.pathname = `${BASE}/`;
    }
    url.searchParams.delete('satellite');
    window.history.replaceState({}, '', url.toString());
  }

  setupURLSharing(map: any, updateCallback: () => void) {
    map.on('moveend', () => updateCallback());
    map.on('zoomend', () => updateCallback());
    map.on('pitchend', () => updateCallback());
    map.on('rotateend', () => updateCallback());
  }

  navigateToSatellite(satelliteId: string) {
    // Use pretty URL format /satellite-id
    const url = new URL(window.location.href);
    url.pathname = `${BASE}/${encodeURIComponent(satelliteId)}`;
    url.search = ''; // Clear query parameters
    window.history.pushState({}, '', url.toString());
  }

}