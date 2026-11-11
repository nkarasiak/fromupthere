export interface Command {
  id: string;
  title: string;
  description: string;
  icon: string;
  shortcut?: string;
  execute: () => void | Promise<void>;
  keywords?: string[];
}

export class CommandPalette {
  private palette: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  private satelliteResults: Array<{id: string, name: string, altitude?: number}> = [];
  private filteredSatellites: Array<{id: string, name: string, altitude?: number}> = [];
  private selectedIndex = 0;
  private isOpen = false;
  private virtualScrollOffset = 0;
  private readonly itemHeight = 60; // Height of each satellite item
  private readonly maxVisibleItems = 8; // Max items to render at once
  
  // Callbacks
  private onTrackSatellite?: (satelliteId: string) => void;
  private getSearchDatabase?: () => Map<string, any>;
  private loadSearchDatabase?: () => Promise<void>;
  private getSatelliteConfigs?: () => Array<{ id: string; name?: string; shortname?: string; alternateName?: string }>;
  private searchRemote?: (query: string) => Promise<Array<{ id: string; name: string }>>;
  private getConstellations?: () => Array<{ id: string; name: string }>;
  private dbLoad?: Promise<void>; // catalogue download in flight
  private remoteTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.palette = document.getElementById('command-palette')!;
    this.input = document.getElementById('command-input') as HTMLInputElement;
    this.results = document.getElementById('command-results')!;
    this.setupEventListeners();
  }

  setCallbacks(callbacks: {
    onTrackSatellite?: (satelliteId: string) => void;
    getSatellites?: () => Map<string, any>;
    getSearchDatabase?: () => Map<string, any>;
    loadSearchDatabase?: () => Promise<void>;
    getSatelliteConfigs?: () => Array<{ id: string; name?: string; shortname?: string; alternateName?: string }>;
    searchRemote?: (query: string) => Promise<Array<{ id: string; name: string }>>;
    getConstellations?: () => Array<{ id: string; name: string }>;
  }) {
    this.onTrackSatellite = callbacks.onTrackSatellite;
    this.getSearchDatabase = callbacks.getSearchDatabase;
    this.loadSearchDatabase = callbacks.loadSearchDatabase;
    this.getSatelliteConfigs = callbacks.getSatelliteConfigs;
    this.searchRemote = callbacks.searchRemote;
    this.getConstellations = callbacks.getConstellations;
    
    this.initializeSatellites();
  }

  private initializeSatellites() {
    this.refreshSatelliteList();
  }

  public refreshSatelliteList() {
    // Full catalogue if it loaded; otherwise the known satellites from config (search then goes remote)
    const db = this.getSearchDatabase?.();
    this.satelliteResults = [];
    if (db && db.size > 0) {
      db.forEach((satellite, id) => {
        this.satelliteResults.push({
          id,
          name: satellite.shortname || satellite.alternateName || satellite.name || id,
          altitude: satellite.altitude
        });
      });
    } else {
      (this.getSatelliteConfigs?.() ?? []).forEach(c => {
        this.satelliteResults.push({ id: c.id, name: c.shortname || c.alternateName || c.name || c.id });
      });
    }
    
    // Alphabetical, after the ISS (the default view, preselected) and the constellations
    this.satelliteResults.sort((a, b) => a.name.localeCompare(b.name));
    const iss = this.satelliteResults.findIndex(s => s.id === 'iss-zarya');
    const top = iss >= 0 ? this.satelliteResults.splice(iss, 1) : [];
    this.satelliteResults.unshift(...top, ...(this.getConstellations?.() ?? []));
    
    // Initially show all satellites
    this.filteredSatellites = [...this.satelliteResults];
  }

  private setupEventListeners() {
    // Global keyboard shortcut to open command palette
    document.addEventListener('keydown', (e) => {
      // "/" key to open command palette (only if not typing in an input)
      if (e.key === '/' && !this.isOpen && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        this.open();
        return;
      }
      
      // Handle Escape to close palette from anywhere
      if (e.key === 'Escape' && this.isOpen) {
        e.preventDefault();
        this.close();
        return;
      }
    });

    // Input handling
    this.input.addEventListener('input', () => {
      this.handleInput();
    });


    // Handle navigation keys directly on the input
    this.input.addEventListener('keydown', (e) => {
      
      // Only handle navigation keys, let everything else pass through normally
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.selectPrevious();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectNext();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.executeSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
      // For all other keys - do nothing, let them pass through naturally
    });

    // Click outside to close
    this.palette.addEventListener('click', (e) => {
      if (e.target === this.palette) {
        this.close();
      }
    });

    // Prevent closing when clicking inside the content
    this.palette.querySelector('.command-palette-content')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  private handleInput() {
    const query = this.input.value.trim();
    const lowerQuery = query.toLowerCase();
    
    // Filter satellites based on search query
    if (query === '') {
      // Show all satellites when no search query
      this.filteredSatellites = [...this.satelliteResults];
    } else {
      // Search satellites
      this.filteredSatellites = this.satelliteResults.filter(satellite => {
        const matchesName = satellite.name.toLowerCase().includes(lowerQuery);
        const matchesId = satellite.id.toLowerCase().includes(lowerQuery);
        
        return matchesName || matchesId;
      });
    }
    
    this.selectedIndex = 0;
    this.virtualScrollOffset = 0;
    this.renderSatelliteResults();

    // Ask Celestrak by name too (debounced) so any satellite is findable without the full catalogue
    clearTimeout(this.remoteTimer);
    if (query.length >= 3 && this.searchRemote) {
      this.remoteTimer = setTimeout(async () => {
        const remote = await this.searchRemote!(query);
        if (this.input.value.trim() !== query) return; // user kept typing
        const have = new Set(this.filteredSatellites.map(s => s.id));
        const extra = remote.filter(r => !have.has(r.id));
        if (extra.length === 0) return;
        this.filteredSatellites = [...this.filteredSatellites, ...extra];
        this.renderSatelliteResults();
      }, 300);
    }
  }

  private renderSatelliteResults() {
    this.results.innerHTML = '';
    
    if (this.filteredSatellites.length === 0) {
      const noResults = document.createElement('div');
      noResults.className = 'command-item';
      noResults.innerHTML = `
        <div class="command-icon">❌</div>
        <div class="command-text">
          <div class="command-title">No satellites found</div>
          <div class="command-description">Try a different search term</div>
        </div>
      `;
      this.results.appendChild(noResults);
      return;
    }
    
    // Virtual scrolling implementation
    const totalItems = this.filteredSatellites.length;
    const startIndex = Math.max(0, Math.min(this.virtualScrollOffset, totalItems - this.maxVisibleItems));
    const endIndex = Math.min(startIndex + this.maxVisibleItems, totalItems);
    
    // Create container for virtual scroll
    const container = document.createElement('div');
    container.style.position = 'relative';
    container.style.height = `${totalItems * this.itemHeight}px`;
    
    // Create visible items
    for (let i = startIndex; i < endIndex; i++) {
      const satellite = this.filteredSatellites[i];
      const item = document.createElement('div');
      item.className = `command-item ${i === this.selectedIndex ? 'selected' : ''}`;
      item.style.position = 'absolute';
      item.style.top = `${i * this.itemHeight}px`;
      item.style.width = '100%';
      item.style.height = `${this.itemHeight}px`;
      
      const altitudeInfo = satellite.altitude ? ` • Alt: ${satellite.altitude.toFixed(0)}km` : '';
      
      item.innerHTML = `
        <div class="command-icon">🛰️</div>
        <div class="command-text">
          <div class="command-title">${satellite.name}</div>
          <div class="command-description">${satellite.name}${altitudeInfo}</div>
        </div>
      `;
      
      item.addEventListener('click', () => {
        this.onTrackSatellite?.(satellite.id);
        this.close();
      });
      
      container.appendChild(item);
    }
    
    this.results.appendChild(container);
    
    // Set max height and enable scrolling
    this.results.style.maxHeight = `${this.maxVisibleItems * this.itemHeight}px`;
    this.results.style.overflowY = 'auto';
  }


  private selectNext() {
    const maxIndex = this.filteredSatellites.length - 1;
    if (this.selectedIndex < maxIndex) {
      this.selectedIndex++;
      this.updateVirtualScroll();
      this.renderSatelliteResults();
    }
  }

  private selectPrevious() {
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this.updateVirtualScroll();
      this.renderSatelliteResults();
    }
  }

  private updateVirtualScroll() {
    // Ensure selected item is visible in virtual scroll
    if (this.selectedIndex < this.virtualScrollOffset) {
      this.virtualScrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.virtualScrollOffset + this.maxVisibleItems) {
      this.virtualScrollOffset = this.selectedIndex - this.maxVisibleItems + 1;
    }
  }

  private executeSelected() {
    if (this.filteredSatellites.length === 0 || this.selectedIndex >= this.filteredSatellites.length) {
      return;
    }
    
    const selectedSatellite = this.filteredSatellites[this.selectedIndex];
    this.onTrackSatellite?.(selectedSatellite.id);
    this.close();
  }

  public async open() {
    this.isOpen = true;
    this.palette.classList.add('active');
    this.input.value = '';
    
    // List what we have now; the full catalogue (seconds to download) fills in when it arrives
    this.refreshSatelliteList();
    this.dbLoad ??= this.loadSearchDatabase?.()
      .then(() => {
        if (!this.isOpen) return;
        this.refreshSatelliteList();
        if (this.input.value.trim()) this.handleInput(); // re-filter what the user typed meanwhile
        else { this.filteredSatellites = [...this.satelliteResults]; this.renderSatelliteResults(); }
      })
      .catch(error => console.warn('Failed to load search database in command palette:', error))
      .finally(() => { this.dbLoad = undefined; });
    
    // Prevent canvas from stealing focus
    const canvas = document.getElementById('deck-canvas') as HTMLCanvasElement;
    if (canvas) {
      canvas.setAttribute('tabindex', '-1');
    }
    
    // Blur any currently active element first
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    
    // Focus the input
    this.input.focus();
    
    // Wait for CSS animation to complete and ensure focus
    setTimeout(() => {
      this.input.focus();
      if (document.activeElement !== this.input) {
        this.input.click();
      }
    }, 350);
    
    this.selectedIndex = 0;
    this.virtualScrollOffset = 0;
    this.filteredSatellites = [...this.satelliteResults];
    this.renderSatelliteResults();
  }

  private close() {
    this.isOpen = false;
    this.palette.classList.remove('active');
    this.input.value = '';
    this.input.blur();
    
    // Restore canvas focus capability
    const canvas = document.getElementById('deck-canvas') as HTMLCanvasElement;
    if (canvas) {
      canvas.setAttribute('tabindex', '0');
    }
  }
}
