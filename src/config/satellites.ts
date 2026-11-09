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
  // EarthDaily Constellation: EDC-01..08 = YAM-10..17 (verified by COSPAR designator vs CelesTrak; EDC-09/10 not launched). URL ids stay yam-NN (Celestrak names).
  {
    id: 'yam-10',
    name: 'EDC-01',
    alternateName: 'EarthDaily EDC-01 (YAM-10)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
    scaleFactor: 1.5
  },
  {
    id: 'yam-11',
    name: 'EDC-02',
    alternateName: 'EarthDaily EDC-02 (YAM-11)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
    scaleFactor: 1.5
  },
  {
    id: 'yam-12',
    name: 'EDC-03',
    alternateName: 'EarthDaily EDC-03 (YAM-12)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
    scaleFactor: 1.5
  },
  {
    id: 'yam-13',
    name: 'EDC-04',
    alternateName: 'EarthDaily EDC-04 (YAM-13)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
    scaleFactor: 1.5
  },
  {
    id: 'yam-14',
    name: 'EDC-05',
    alternateName: 'EarthDaily EDC-05 (YAM-14)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
    scaleFactor: 1.5
  },
  {
    id: 'yam-15',
    name: 'EDC-06',
    alternateName: 'EarthDaily EDC-06 (YAM-15)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
    scaleFactor: 1.5
  },
  {
    id: 'yam-16',
    name: 'EDC-07',
    alternateName: 'EarthDaily EDC-07 (YAM-16)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
    scaleFactor: 1.5
  },
  {
    id: 'yam-17',
    name: 'EDC-08',
    alternateName: 'EarthDaily EDC-08 (YAM-17)',
    image: 'static/images/earthdaily_yam10.webp',
    defaultZoom: 4.7,
    defaultPitch: 62,
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

// Let URLs use a config satellite's display name too: /edc-03 -> yam-12
export const resolveSatelliteId = (slug: string): string =>
  SATELLITE_CONFIGS.find(c => c.name?.toLowerCase().replace(/[^a-z0-9]/g, '-') === slug.toLowerCase())?.id ?? slug;


// Constellations viewable together (?group=<id>). `query` is ONE Celestrak name search that returns all members.
export interface Constellation { id: string; name: string; query: string; members: string[]; color: [number, number, number]; swathKm: number }
export const CONSTELLATIONS: Constellation[] = [
  { id: 'edc', name: 'EarthDaily', query: 'YAM-', members: Array.from({ length: 8 }, (_, i) => `yam-${10 + i}`), color: [0, 214, 255], swathKm: 240 }, // EarthDaily docs: 240 km swath
  { id: 'sentinel-2', name: 'Sentinel-2', query: 'SENTINEL-2', members: ['sentinel-2a', 'sentinel-2b', 'sentinel-2c'], color: [90, 150, 255], swathKm: 290 }, // MSI nominal swath
  { id: 'sentinel-1', name: 'Sentinel-1', query: 'SENTINEL-1', members: ['sentinel-1a', 'sentinel-1c', 'sentinel-1d'], color: [170, 130, 255], swathKm: 250 }, // 1B was lost in 2021; IW mode swath
  { id: 'landsat', name: 'Landsat', query: 'LANDSAT', members: ['landsat-8', 'landsat-9'], color: [255, 176, 64], swathKm: 185 }
];
export const constellationOf = (satelliteId: string | null) =>
  CONSTELLATIONS.find(g => satelliteId !== null && g.members.includes(satelliteId));
