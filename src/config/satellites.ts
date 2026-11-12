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
    alternateName: 'sentinel-2b - MSI',
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
    defaultZoom: 5.5, // the landing view (main.ts): behind it, a little to its right, EDC-05 on the left
    defaultPitch: 60, // EDC-05 (far ahead in the same orbit) just peeks over the horizon
    defaultBearing: 9,
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


// Constellations viewable together (?group=<id>). `queries`: Celestrak name searches (case-insensitive substring),
// merged; `match`, tested on the satellite id (slug of its name), drops whatever else they catch. Only satellites
// Celestrak's SATCAT lists as operational are shown, so new launches join and dead ones leave without editing this.
// swathKm: the main imager's nominal swath; 0 = not an Earth imager (no swath, no sensor cone).
// night: images day and night (SAR, or thermal IR); other swaths are drawn in daylight only
export interface Constellation { id: string; name: string; queries: string[]; match: RegExp; color: [number, number, number]; swathKm: number; night?: boolean }
export const CONSTELLATIONS: Constellation[] = [
  // Public Earth observation
  { id: 'sentinel-2', name: 'Sentinel-2', queries: ['SENTINEL-2'], match: /^sentinel-2[a-z]$/, color: [90, 150, 255], swathKm: 290 }, // MSI
  { id: 'sentinel-1', name: 'Sentinel-1', queries: ['SENTINEL-1'], match: /^sentinel-1[a-z]$/, color: [170, 130, 255], swathKm: 250, night: true }, // IW mode
  { id: 'sentinel-3', name: 'Sentinel-3', queries: ['SENTINEL-3'], match: /^sentinel-3[a-z]$/, color: [80, 200, 170], swathKm: 1270 }, // OLCI
  { id: 'landsat', name: 'Landsat', queries: ['LANDSAT'], match: /^landsat-\d+$/, color: [255, 176, 64], swathKm: 185 },
  { id: 'edc', name: 'EarthDaily', queries: ['YAM-'], match: /^yam-1[0-7]$/, color: [0, 214, 255], swathKm: 240 }, // EDC-01..08; YAM-2..9 are other Loft Orbital buses
  { id: 'modis', name: 'MODIS', queries: ['TERRA', 'AQUA'], match: /^(terra|aqua)$/, color: [120, 220, 120], swathKm: 2330, night: true }, // thermal bands at night
  { id: 'viirs', name: 'VIIRS (JPSS)', queries: ['SUOMI NPP', 'JPSS'], match: /^(suomi-npp|noaa-\d+-jpss-\d+)$/, color: [255, 120, 90], swathKm: 3060, night: true },
  { id: 'metop', name: 'MetOp', queries: ['METOP'], match: /^metop-[a-c]$/, color: [230, 200, 90], swathKm: 2900, night: true }, // AVHRR (Metop-SG has none)
  { id: 'fengyun-3', name: 'Fengyun-3', queries: ['FENGYUN 3'], match: /^fengyun-3[a-z]$/, color: [240, 90, 90], swathKm: 2900, night: true }, // MERSI
  { id: 'cbers', name: 'CBERS / Amazonia', queries: ['CBERS', 'AMAZONIA'], match: /^(cbers|amazonia)-/, color: [100, 210, 90], swathKm: 866 }, // WFI
  // Commercial optical
  { id: 'planet-dove', name: 'Planet SuperDove', queries: ['FLOCK'], match: /^flock-/, color: [80, 190, 255], swathKm: 32 },
  { id: 'skysat', name: 'Planet SkySat', queries: ['SKYSAT'], match: /^skysat-/, color: [60, 160, 230], swathKm: 6 },
  { id: 'pelican', name: 'Planet Pelican', queries: ['PELICAN'], match: /^pelican-\d+$/, color: [40, 130, 210], swathKm: 10 }, // approximate: Planet doesn't publish it
  { id: 'maxar', name: 'Maxar WorldView', queries: ['WORLDVIEW', 'LEGION', 'GEOEYE'], match: /^(worldview|legion|geoeye)-/, color: [255, 140, 60], swathKm: 13 },
  { id: 'pleiades', name: 'Pléiades', queries: ['PLEIADES'], match: /^pleiades-/, color: [220, 110, 200], swathKm: 20 }, // Neo: 14
  { id: 'spot', name: 'SPOT', queries: ['SPOT'], match: /^spot-\d+$/, color: [200, 140, 230], swathKm: 60 },
  { id: 'blacksky', name: 'BlackSky', queries: ['GLOBAL-'], match: /^global-\d+$/, color: [190, 190, 200], swathKm: 5 },
  { id: 'satellogic', name: 'Satellogic', queries: ['NUSAT'], match: /^nusat-/, color: [120, 230, 200], swathKm: 5 },
  { id: 'jilin-1', name: 'Jilin-1', queries: ['JILIN'], match: /^jilin-/, color: [255, 90, 120], swathKm: 17 }, // GF03 (Kuanfu: ~140)
  { id: 'superview', name: 'SuperView', queries: ['SUPERVIEW'], match: /^superview-/, color: [255, 160, 160], swathKm: 12 },
  { id: 'kompsat', name: 'KOMPSAT', queries: ['KOMPSAT'], match: /^(arirang-(?!5)|kompsat-)/, color: [100, 170, 255], swathKm: 15 }, // optical ones (KOMPSAT-5 is SAR)
  // SAR
  { id: 'iceye', name: 'ICEYE', queries: ['ICEYE'], match: /^iceye-/, color: [150, 220, 255], swathKm: 30, night: true }, // stripmap
  { id: 'capella', name: 'Capella', queries: ['CAPELLA'], match: /^capella-/, color: [255, 200, 120], swathKm: 10, night: true },
  { id: 'umbra', name: 'Umbra', queries: ['UMBRA'], match: /^umbra-/, color: [180, 180, 255], swathKm: 10, night: true },
  { id: 'cosmo-skymed', name: 'COSMO-SkyMed', queries: ['COSMO-SKYMED', 'CSG'], match: /^(cosmo-skymed|csg)-/, color: [120, 200, 255], swathKm: 40, night: true }, // Himage stripmap
  { id: 'terrasar-x', name: 'TerraSAR-X / PAZ', queries: ['TERRASAR-X', 'TANDEM-X', 'PAZ'], match: /^(terrasar-x|tandem-x|paz)$/, color: [255, 220, 100], swathKm: 30, night: true },
  { id: 'rcm', name: 'RADARSAT Constellation', queries: ['RCM'], match: /^rcm-\d+$/, color: [255, 100, 100], swathKm: 350, night: true }, // medium resolution 50 m
  { id: 'saocom', name: 'SAOCOM', queries: ['SAOCOM'], match: /^saocom-/, color: [130, 200, 255], swathKm: 320, night: true }, // TOPSAR wide
  { id: 'alos', name: 'ALOS', queries: ['ALOS'], match: /^alos-\d/, color: [255, 150, 200], swathKm: 200, night: true }, // ALOS-4 stripmap (ALOS-2: 50)
  { id: 'strix', name: 'Synspective StriX', queries: ['STRIX'], match: /^strix-/, color: [150, 255, 180], swathKm: 20, night: true },
  { id: 'iqps', name: 'iQPS', queries: ['QPS-SAR'], match: /^qps-sar-/, color: [255, 180, 80], swathKm: 7, night: true },
  // Not Earth imagers: communications, navigation, geostationary weather
  { id: 'starlink', name: 'Starlink', queries: ['STARLINK'], match: /^starlink-\d+$/, color: [79, 209, 255], swathKm: 0 },
  { id: 'oneweb', name: 'OneWeb', queries: ['ONEWEB'], match: /^oneweb-\d+$/, color: [80, 140, 255], swathKm: 0 },
  { id: 'kuiper', name: 'Amazon Kuiper', queries: ['KUIPER'], match: /^kuiper-/, color: [255, 170, 50], swathKm: 0 },
  { id: 'qianfan', name: 'Qianfan', queries: ['QIANFAN'], match: /^qianfan-/, color: [255, 80, 80], swathKm: 0 },
  { id: 'iridium', name: 'Iridium', queries: ['IRIDIUM'], match: /^iridium-\d+$/, color: [120, 200, 255], swathKm: 0 },
  { id: 'globalstar', name: 'Globalstar', queries: ['GLOBALSTAR'], match: /^globalstar-/, color: [255, 210, 80], swathKm: 0 },
  { id: 'orbcomm', name: 'ORBCOMM', queries: ['ORBCOMM'], match: /^orbcomm-/, color: [160, 230, 120], swathKm: 0 },
  { id: 'spire', name: 'Spire', queries: ['LEMUR'], match: /^lemur-/, color: [200, 160, 255], swathKm: 0 },
  { id: 'gps', name: 'GPS', queries: ['NAVSTAR'], match: /^navstar-/, color: [90, 200, 120], swathKm: 0 },
  { id: 'galileo', name: 'Galileo', queries: ['GALILEO'], match: /galileo/, color: [80, 130, 255], swathKm: 0 },
  { id: 'glonass', name: 'GLONASS', queries: ['GLONASS'], match: /glonass/, color: [240, 90, 90], swathKm: 0 },
  { id: 'beidou', name: 'BeiDou', queries: ['BEIDOU'], match: /beidou/, color: [255, 190, 60], swathKm: 0 },
  { id: 'weather-geo', name: 'Geostationary weather', queries: ['GOES', 'HIMAWARI', 'METEOSAT', 'FENGYUN 4', 'GEO-KOMPSAT', 'INSAT-3D', 'ELEKTRO-L'],
    match: /goes|himawari|meteosat|fengyun-4|geo-kompsat|insat-3d|elektro-l/, color: [120, 220, 255], swathKm: 0 }
];
export const constellationOf = (satelliteId: string | null) =>
  CONSTELLATIONS.find(g => satelliteId !== null && g.match.test(satelliteId));
