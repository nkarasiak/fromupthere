// Performance manager for adaptive quality and monitoring
export class PerformanceManager {
  private frameRates: number[] = [];
  private lastFrameTime = 0;
  private frameCount = 0;
  private adaptiveQuality = 'high';
  private performanceMetrics = {
    avgFPS: 60,
    minFPS: 60,
    satelliteCount: 0,
    renderTime: 0
  };

  // Adaptive quality levels
  private qualitySettings = {
    'ultra': {
      maxSatellites: 3000,
      updateInterval: 100, // 10fps
      lodSkipFactor: 1,
      iconQuality: 'high'
    },
    'high': {
      maxSatellites: 2000,
      updateInterval: 150, // 6.7fps
      lodSkipFactor: 2,
      iconQuality: 'high'
    },
    'medium': {
      maxSatellites: 1000,
      updateInterval: 200, // 5fps
      lodSkipFactor: 5,
      iconQuality: 'medium'
    },
    'low': {
      maxSatellites: 500,
      updateInterval: 300, // 3.3fps
      lodSkipFactor: 10,
      iconQuality: 'low'
    },
    'potato': {
      maxSatellites: 200,
      updateInterval: 500, // 2fps
      lodSkipFactor: 20,
      iconQuality: 'none'
    }
  };

  constructor() {}

  updateFrameRate() {
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      const frameDelta = now - this.lastFrameTime;
      const fps = 1000 / frameDelta;
      
      this.frameRates.push(fps);
      if (this.frameRates.length > 60) { // Keep last 60 frames
        this.frameRates.shift();
      }
      
      this.frameCount++;
      
      // Update metrics every 60 frames
      if (this.frameCount % 60 === 0) {
        this.updateMetrics();
        this.adaptQuality();
      }
    }
    this.lastFrameTime = now;
  }

  private updateMetrics() {
    if (this.frameRates.length === 0) return;
    
    this.performanceMetrics.avgFPS = this.frameRates.reduce((a, b) => a + b, 0) / this.frameRates.length;
    this.performanceMetrics.minFPS = Math.min(...this.frameRates);
  }

  private adaptQuality() {
    const { avgFPS, minFPS } = this.performanceMetrics;
    
    // Aggressive quality reduction if performance is poor
    if (minFPS < 15 || avgFPS < 20) {
      this.adaptiveQuality = 'potato';
    } else if (minFPS < 20 || avgFPS < 25) {
      this.adaptiveQuality = 'low';
    } else if (minFPS < 25 || avgFPS < 30) {
      this.adaptiveQuality = 'medium';
    } else if (minFPS < 30 || avgFPS < 40) {
      this.adaptiveQuality = 'high';
    } else {
      this.adaptiveQuality = 'ultra';
    }
    
    // Performance monitoring
  }

  getQualitySettings() {
    return this.qualitySettings[this.adaptiveQuality as keyof typeof this.qualitySettings];
  }

  setSatelliteCount(count: number) {
    this.performanceMetrics.satelliteCount = count;
  }

  // Get LOD skip factor based on zoom and quality
  getLODSkip(zoom: number): number {
    const settings = this.getQualitySettings();
    const baseSkip = settings.lodSkipFactor;
    
    // More aggressive culling at low zoom levels
    if (zoom <= 1) return Math.max(baseSkip * 10, 50);
    if (zoom <= 2) return Math.max(baseSkip * 5, 25);
    if (zoom <= 3) return Math.max(baseSkip * 3, 10);
    if (zoom <= 4) return Math.max(baseSkip * 2, 5);
    
    return baseSkip;
  }

  // Dynamic update interval based on performance
  getUpdateInterval(): number {
    const settings = this.getQualitySettings();
    const { avgFPS } = this.performanceMetrics;
    
    // Slow down updates if FPS is low
    if (avgFPS < 20) {
      return settings.updateInterval * 2;
    } else if (avgFPS < 30) {
      return settings.updateInterval * 1.5;
    }
    
    return settings.updateInterval;
  }

  // Get maximum number of satellites to render
  getMaxSatellites(): number {
    return this.getQualitySettings().maxSatellites;
  }
}