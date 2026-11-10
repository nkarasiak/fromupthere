// Web Worker for satellite position calculations
// This moves expensive TLE calculations off the main thread
import * as satellite from 'satellite.js';

interface SatelliteCalcRequest {
  id: string;
  tle1: string;
  tle2: string;
  timestamp: number;
}

interface SatelliteCalcResult {
  id: string;
  longitude: number;
  latitude: number;
  altitude: number;
  velocity: number;
  timestamp: number;
}

// Cache satellite records to avoid re-parsing TLE
const satelliteRecords = new Map<string, any>();

// Batch processing for better performance
const calculationQueue: SatelliteCalcRequest[] = [];
let isProcessing = false;

self.onmessage = function(e) {
  const { type, data } = e.data;

  switch (type) {
    case 'CALCULATE_POSITIONS':
      // Add to queue for batch processing
      calculationQueue.push(...data);
      processBatch();
      break;
    
    case 'CALCULATE_SINGLE':
      const result = calculateSatellitePosition(data);
      self.postMessage({ type: 'POSITION_RESULT', data: result });
      break;
  }
};

async function processBatch() {
  if (isProcessing || calculationQueue.length === 0) return;
  
  isProcessing = true;
  const batch = calculationQueue.splice(0, 100); // Process 100 at a time
  const results: SatelliteCalcResult[] = [];

  for (const request of batch) {
    const result = calculateSatellitePosition(request);
    if (result) {
      results.push(result);
    }
  }

  // Send results back to main thread
  self.postMessage({ type: 'BATCH_RESULTS', data: results });

  isProcessing = false;

  // Continue processing if more items in queue
  if (calculationQueue.length > 0) {
    setTimeout(processBatch, 0); // Non-blocking continuation
  }
}

function calculateSatellitePosition(request: SatelliteCalcRequest): SatelliteCalcResult | null {
  try {
    const { id, tle1, tle2, timestamp } = request;
    
    // Get or create satellite record (expensive operation cached)
    const cacheKey = `${tle1}-${tle2}`;
    let satrec = satelliteRecords.get(cacheKey);
    if (!satrec) {
      satrec = satellite.twoline2satrec(tle1, tle2);
      satelliteRecords.set(cacheKey, satrec);
    }
    
    const currentTime = new Date(timestamp);
    const positionAndVelocity = satellite.propagate(satrec, currentTime);
    
    if (positionAndVelocity.position && typeof positionAndVelocity.position !== 'boolean') {
      const gmst = satellite.gstime(currentTime);
      const positionGd = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
      
      const velocity = positionAndVelocity.velocity && typeof positionAndVelocity.velocity !== 'boolean' ? 
        Math.sqrt(
          Math.pow(positionAndVelocity.velocity.x, 2) + 
          Math.pow(positionAndVelocity.velocity.y, 2) + 
          Math.pow(positionAndVelocity.velocity.z, 2)
        ) : 0;
      
      return {
        id,
        longitude: satellite.degreesLong(positionGd.longitude),
        latitude: satellite.degreesLat(positionGd.latitude),
        altitude: positionGd.height,
        velocity,
        timestamp
      };
    }
  } catch (error) {
  }
  
  return null;
}