/**
 * SEO Manager for dynamic meta tag updates based on tracked satellites
 */
export class SEOManager {
  private static readonly DEFAULT_IMAGE = '/static/images/og-preview.png';
  private static readonly BASE_URL = 'https://nkarasiak.github.io/fromupthere';

  /**
   * Update page meta tags when tracking a specific satellite
   */
  static updateMetaForSatellite(satelliteData: {
    id: string;
    name?: string;
    alternateName?: string;
    type?: string;
    altitude?: number;
    image?: string;
  }) {
    const satelliteName = satelliteData.name || satelliteData.alternateName || satelliteData.id;
    const title = `${satelliteName} - Live Satellite Tracker | From Up There`;
    const description = `Track ${satelliteName} in real-time with precise orbital position${satelliteData.altitude ? ` at ${Math.round(satelliteData.altitude)}km altitude` : ''}. Live 3D visualization and satellite tracking data.`;
    const url = `${this.BASE_URL}/${encodeURIComponent(satelliteData.id)}`;
    const image = satelliteData.image ? `${this.BASE_URL}/${satelliteData.image}` : `${this.BASE_URL}${this.DEFAULT_IMAGE}`;

    // Update document title
    document.title = title;

    // Update meta tags
    this.updateMetaTag('name', 'title', title);
    this.updateMetaTag('name', 'description', description);
    this.updateMetaTag('property', 'og:title', title);
    this.updateMetaTag('property', 'og:description', description);
    this.updateMetaTag('property', 'og:url', url);
    this.updateMetaTag('property', 'og:image', image);
    this.updateMetaTag('property', 'twitter:title', title);
    this.updateMetaTag('property', 'twitter:description', description);
    this.updateMetaTag('property', 'twitter:url', url);
    this.updateMetaTag('property', 'twitter:image', image);

    // Update canonical URL
    this.updateCanonicalUrl(url);

    // Update structured data
    this.updateStructuredData(satelliteName, description, url, image);
  }

  /**
   * Update or create a meta tag
   */
  private static updateMetaTag(attribute: string, value: string, content: string) {
    let element = document.querySelector(`meta[${attribute}="${value}"]`) as HTMLMetaElement;
    
    if (!element) {
      element = document.createElement('meta');
      element.setAttribute(attribute, value);
      document.head.appendChild(element);
    }
    
    element.setAttribute('content', content);
  }

  /**
   * Update canonical URL
   */
  private static updateCanonicalUrl(url: string) {
    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement;
    
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    
    canonical.setAttribute('href', url);
  }

  /**
   * Update structured data for the current page
   */
  private static updateStructuredData(name: string, description: string, url: string, image: string) {
    // Remove existing structured data
    const existingScript = document.querySelector('script[type="application/ld+json"]');
    if (existingScript) {
      existingScript.remove();
    }

    // Create new structured data
    const structuredData = {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": `${name} Tracker - From Up There`,
      "alternateName": "Real-Time Satellite Tracker",
      "description": description,
      "url": url,
      "applicationCategory": "EducationalApplication",
      "operatingSystem": "Web Browser",
      "image": image,
      "offers": {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "USD"
      },
      "creator": {
        "@type": "Organization",
        "name": "From Up There"
      },
      "keywords": `${name.toLowerCase()} tracker, satellite tracker, real-time tracking, 3D visualization`
    };

    const script = document.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.textContent = JSON.stringify(structuredData, null, 2);
    document.head.appendChild(script);
  }

}