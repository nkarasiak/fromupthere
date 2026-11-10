import { SatelliteBrowserService } from '../satellite-browser.service';
import { CategoryInfo } from '../types';

export class CategoryBrowserComponent {
  private browserService: SatelliteBrowserService;
  private container: HTMLElement;

  constructor(browserService: SatelliteBrowserService, container: HTMLElement) {
    this.browserService = browserService;
    this.container = container;
  }

  render(): void {
    const categories = this.browserService.getCategories();
    
    this.container.innerHTML = `
      <div class="browser-header">
        <h1>Satellite Browser</h1>
        <p>Explore satellites by category, search by name, or browse individual satellites</p>
        <div class="satellite-status">
          <span id="satellite-count-display">Loading satellites...</span>
        </div>
      </div>
      
      <div class="categories-grid">
        ${categories.map(category => this.renderCategoryCard(category)).join('')}
      </div>
    `;

    this.attachEventListeners();
    this.updateSatelliteCount();
  }

  private updateSatelliteCount(): void {
    const dataService = this.browserService.getSatelliteDataService();
    
    // Update count display
    const updateCount = () => {
      const stats = dataService.getStats();
      const countDisplay = this.container.querySelector('#satellite-count-display');
      
      if (stats && countDisplay) {
        const isOnlineLoaded = dataService.isOnlineSatellitesLoaded();
        if (isOnlineLoaded) {
          countDisplay.textContent = `${stats.total} satellites loaded (${stats.static} static + ${stats.online} online)`;
          const element = countDisplay as HTMLElement;
          element.style.background = '#f0fff0';
          element.style.borderColor = '#90ee90';
          element.style.color = '#006400';
        } else {
          countDisplay.textContent = `${stats.total} satellites loaded, fetching more online...`;
        }
      }
    };

    updateCount();
    
    // Listen for satellite updates
    dataService.addEventListener('satellites-updated', () => {
      updateCount();
      
      // Also refresh category counts
      const categories = this.browserService.getCategories();
      const categoriesGrid = this.container.querySelector('.categories-grid');
      if (categoriesGrid) {
        categoriesGrid.innerHTML = categories.map(category => this.renderCategoryCard(category)).join('');
        this.attachEventListeners();
      }
    });
    
    // Also update count periodically for the first 30 seconds as fallback
    let attempts = 0;
    const updateInterval = setInterval(() => {
      updateCount();
      attempts++;
      
      // Stop updating after 15 attempts (30 seconds) or when online loading is complete
      const isOnlineLoaded = dataService.isOnlineSatellitesLoaded();
      if (attempts >= 15 || isOnlineLoaded) {
        clearInterval(updateInterval);
      }
    }, 2000);
  }

  private renderCategoryCard(category: CategoryInfo): string {
    return `
      <div class="category-card" data-category="${category.id}">
        <div class="category-icon">
          ${this.getCategoryIcon(category.id)}
        </div>
        <h3>${category.name}</h3>
        <p>${category.description}</p>
        <div class="category-stats">
          <span class="satellite-count">${category.count} satellite${category.count !== 1 ? 's' : ''}</span>
        </div>
      </div>
    `;
  }

  private getCategoryIcon(categoryId: string): string {
    const icons: Record<string, string> = {
      'earth-observation': '🌍',
      'communication': '📡',
      'scientific': '🔬',
      'navigation': '🧭',
      'weather': '🌤️'
    };
    return icons[categoryId] || '🛰️';
  }

  private attachEventListeners(): void {
    const categoryCards = this.container.querySelectorAll('.category-card');
    categoryCards.forEach(card => {
      card.addEventListener('click', (e) => {
        const categoryId = (e.currentTarget as HTMLElement).dataset.category;
        if (categoryId) {
          this.onCategorySelected(categoryId);
        }
      });
    });
  }

  private onCategorySelected(categoryId: string): void {
    // Dispatch custom event for parent components to handle
    const event = new CustomEvent('category-selected', {
      detail: { categoryId }
    });
    this.container.dispatchEvent(event);
  }
}