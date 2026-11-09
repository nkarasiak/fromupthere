import { SatelliteConfig } from '../types/satellite';

export const SATELLITE_CONFIGS: SatelliteConfig[] = [
  // Scientific satellites - metadata only, TLE data comes from gp.txt
  {
    id: 'iss-zarya',
    alternateName: 'International Space Station',
    image: 'static/images/ISS.png',
    tle1: '1 25544U 98067A   25216.88307209  .00003454  00000+0  67688-4 0  9997',
    tle2: '2 25544  51.6362  65.7123 0001818 143.6625 298.7323 15.50331059522717',
    scaleFactor: 3.0
  },
  // NASA Earth observation satellites (MODIS) - metadata only
  {
    id: 'terra',
    alternateName: 'MODIS Terra',
    image: 'static/images/nasa_modis_terra.png'
  },
  {
    id: 'aqua',
    alternateName: 'MODIS Aqua',
    image: 'static/images/nasa_modis_aqua.png',
  },

  // NASA Landsat satellites
  {
    id: 'landsat-8',
    image: 'static/images/nasa_landsat8.png'
  },
  {
    id: 'landsat-9',
    alternateName: 'Landsat 9 | Next',
    image: 'static/images/nasa_landsat9.png'
  },

  // Sentinel Earth observation constellation
  {
    id: 'sentinel-1a',
    alternateName: 'sentinel-1a - SAR',
    image: 'static/images/esa_sentinel1.png'
  },
  {
    id: 'sentinel-1b',
    alternateName: 'sentinel-1b - SAR',
    image: 'static/images/esa_sentinel1.png'
  },
  {
    id: 'sentinel-1c',
    alternateName: 'sentinel-1c - SAR',
    image: 'static/images/esa_sentinel1.png'
  },
  {
    id: 'sentinel-2a',
    alternateName: 'sentinel-2a - MSI',
    image: 'static/images/esa_sentinel2.png'
  },
  {
    id: 'sentinel-2b',
    alternateName: 'sennel-2b - MSI',
    image: 'static/images/esa_sentinel2.png'
  },
  {
    id: 'sentinel-2c',
    alternateName: 'sentinel-2c - MSI',
    image: 'static/images/esa_sentinel2.png'
  },
  // EarthDaily Constellation (EDC-01..08 = YAM-10..17; 10 planned). EDC-08 = YAM-17 is inferred from launch date.
  {
    id: 'yam-10',
    name: 'YAM-10',
    alternateName: 'EarthDaily YAM-10',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  },
  {
    id: 'yam-11',
    name: 'YAM-11',
    alternateName: 'EarthDaily YAM-11',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  },
  {
    id: 'yam-12',
    name: 'YAM-12',
    alternateName: 'EarthDaily YAM-12',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  },
  {
    id: 'yam-13',
    name: 'YAM-13',
    alternateName: 'EarthDaily YAM-13',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  },
  {
    id: 'yam-14',
    name: 'YAM-14',
    alternateName: 'EarthDaily YAM-14',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  },
  {
    id: 'yam-15',
    name: 'YAM-15',
    alternateName: 'EarthDaily YAM-15',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  },
  {
    id: 'yam-16',
    name: 'YAM-16',
    alternateName: 'EarthDaily YAM-16',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  },
  {
    id: 'yam-17',
    name: 'YAM-17',
    alternateName: 'EarthDaily YAM-17',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 3,
    defaultPitch: 60,
    scaleFactor: 1.5
  }
];

// Starlink constellation generator for realistic mega-constellation
function generateStarlinkConstellation(): SatelliteConfig[] {
  const starlinks: SatelliteConfig[] = [];
  let satelliteId = 1000;
  
  // Starlink Shell 1: 53.0° inclination, ~550km altitude
  // Reduce the number to avoid TLE formatting issues and improve performance
  for (let plane = 0; plane < 10; plane++) { // Reduced from 72 to 10 planes
    for (let position = 0; position < 12; position++) { // Reduced from 22 to 12 satellites per plane
      starlinks.push({
        id: `starlink-${satelliteId}`,
        image: 'static/images/starlink.png'
      });
      
      satelliteId++;
      if (satelliteId > 1200) break; // Limit for performance (200 satellites total)
    }
    if (satelliteId > 1200) break;
  }
  
  return starlinks;
}

// Generate the massive Starlink constellation
const STARLINK_CONSTELLATION = generateStarlinkConstellation();

// Export combined satellite configuration
export const SATELLITE_CONFIGS_WITH_STARLINK = [...SATELLITE_CONFIGS, ...STARLINK_CONSTELLATION];