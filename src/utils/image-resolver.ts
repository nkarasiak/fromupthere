/**
 * Dynamic satellite image resolver
 * Automatically checks for images named after satellite IDs
 * Supports .png and .webp formats
 */

const IMAGE_EXTENSIONS = ['png', 'webp'];
const IMAGE_BASE_PATH = 'static/images/';

// Cache for resolved images to avoid repeated checks
const imageCache = new Map<string, string | undefined>();

/**
 * Checks if an image exists at the given URL
 * Uses a HEAD request to avoid downloading the full image
 */
async function checkImageExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Resolves an image path for a satellite ID
 * Tries different extensions: .png, .webp
 * Returns undefined if no image is found
 */
export async function resolveSatelliteImage(satelliteId: string): Promise<string | undefined> {
  // Check cache first
  if (imageCache.has(satelliteId)) {
    return imageCache.get(satelliteId) || undefined;
  }

  // Try different image extensions
  for (const extension of IMAGE_EXTENSIONS) {
    const imagePath = `${IMAGE_BASE_PATH}${satelliteId}.${extension}`;
    const fullUrl = `${import.meta.env.BASE_URL}${imagePath}`;
    
    if (await checkImageExists(fullUrl)) {
      imageCache.set(satelliteId, imagePath);
      return imagePath;
    }
  }

  // No image found, cache the result
  imageCache.set(satelliteId, undefined);
  return undefined;
}

/**
 * Resolves satellite image synchronously using pre-cached results
 * Should be called after resolveSatelliteImage has been called for the satellite
 */
export function getSatelliteImageSync(satelliteId: string): string | undefined {
  return imageCache.get(satelliteId) || undefined;
}

/**
 * Preloads images for multiple satellite IDs
 * Useful for batch processing satellite configurations
 */
export async function preloadSatelliteImages(satelliteIds: string[]): Promise<Map<string, string | undefined>> {
  const results = new Map<string, string | undefined>();
  
  // Process in batches to avoid overwhelming the server
  const BATCH_SIZE = 10;
  for (let i = 0; i < satelliteIds.length; i += BATCH_SIZE) {
    const batch = satelliteIds.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (id) => {
      const imagePath = await resolveSatelliteImage(id);
      results.set(id, imagePath);
      return { id, imagePath };
    });
    
    await Promise.all(promises);
  }
  
  return results;
}

/**
 * Clears the image resolution cache
 * Useful for testing or when images are added/removed
 */
export function clearImageCache(): void {
  imageCache.clear();
}

/**
 * Gets all cached image results
 * Useful for debugging
 */
export function getImageCache(): Map<string, string | undefined> {
  return new Map(imageCache);
}