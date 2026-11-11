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
    
    // Default to ISS tracker if on homepage with no satellite specified and no redirect parameter
    if (path === '/' && !urlParams.get('satellite') && !urlParams.get('name') && !urlParams.get('redirect') && !urlParams.get('group')) {
      const url = new URL(window.location.href);
      url.pathname = `${BASE}/iss-zarya`;
      url.searchParams.set('zoom', '4.7');
      url.searchParams.set('pitch', '62');
      window.history.replaceState({}, '', url.toString());
      return;
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
    
    return 5; // Default for homepage
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

  getInitialGroup(): string | null {
    return new URLSearchParams(window.location.search).get('group');
  }

  navigateToGroup(groupId: string) {
    const url = new URL(window.location.href);
    url.pathname = `${BASE}/`;
    url.search = `?group=${encodeURIComponent(groupId)}`;
    window.history.pushState({}, '', url.toString());
  }

  getInitialBearing(): number {
    const urlParams = new URLSearchParams(window.location.search);
    return parseFloat(urlParams.get('bearing') || '0');
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

  updateURL(zoom: number, followingSatellite: string | null, pitch?: number, bearing?: number) {
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
    
    // For parameters like zoom, pitch, bearing, use query strings
    // Always remove x,y coordinates from URL (don't store them)
    url.searchParams.delete('x');
    url.searchParams.delete('y');
    
    // Update zoom only if significantly different (increased threshold)
    const currentUrlZoomStr = url.searchParams.get('zoom');
    const currentUrlZoom = currentUrlZoomStr ? parseFloat(currentUrlZoomStr) : null;
    if (currentUrlZoom === null || Math.abs(zoom - currentUrlZoom) > 0.1) {
      url.searchParams.set('zoom', zoom.toFixed(1));
      urlChanged = true;
    }
    
    // Update pitch if provided and significantly different
    if (pitch !== undefined) {
      const currentUrlPitchStr = url.searchParams.get('pitch');
      const currentUrlPitch = currentUrlPitchStr ? parseFloat(currentUrlPitchStr) : 0;
      
      if (pitch < 1) {
        // Remove pitch parameter if it's very small
        if (currentUrlPitchStr) {
          url.searchParams.delete('pitch');
          urlChanged = true;
        }
      } else if (Math.abs(pitch - currentUrlPitch) > 1) {
        url.searchParams.set('pitch', pitch.toFixed(0));
        urlChanged = true;
      }
    }
    
    // Update bearing if provided and significantly different
    if (bearing !== undefined) {
      const currentUrlBearingStr = url.searchParams.get('bearing');
      const currentUrlBearing = currentUrlBearingStr ? parseFloat(currentUrlBearingStr) : 0;
      // Normalize bearing to 0-360 range
      const normalizedBearing = ((bearing % 360) + 360) % 360;
      const normalizedCurrentBearing = ((currentUrlBearing % 360) + 360) % 360;
      
      if (Math.abs(normalizedBearing) < 1) {
        // Remove bearing parameter if it's very small
        if (currentUrlBearingStr) {
          url.searchParams.delete('bearing');
          urlChanged = true;
        }
      } else if (Math.abs(normalizedBearing - normalizedCurrentBearing) > 1) {
        url.searchParams.set('bearing', normalizedBearing.toFixed(0));
        urlChanged = true;
      }
    }
    
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