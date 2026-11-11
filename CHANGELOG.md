# Changelog

All notable changes to the From Up There satellite tracking project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🛰️ Tracking view
- **Real altitude**: the tracked satellite is drawn inside MapLibre's globe (like the constellation view) at its real height, not ~0.5 km above the ground. Imagers get a sensor cone down to a scan line that follows the ground; other satellites a plumb line. Satellites without a picture get a crisp vector dot in their constellation's colour; pictures are half their former size and keep it over the poles.
- **Swath**: painted behind the satellite over the last 20 min, fading with age. Built from cross-track arcs along the ground, so it meets the scan line exactly even for MODIS-wide swaths; dims with the light to a faint trace where it's dark (no imaging); stays on top of 3D relief and stops at the horizon.
- **Satellite as a dot** in its constellation's colour, like the constellation view (its picture is a setting). No plumb line under non-imagers. The banner names the constellation ("Constellation MODIS"); a click opens it (replaces the floating "View constellation" button).
- **Banner order**: the clock and its speed control side by side on the left (Constellation · UTC · Speed), the satellite's figures on the right (Alt · Vel · Pos); the constellation view follows suit (Date · Sim UTC · Speed — name — Sats). Separators no longer vanish in a crowded half.
- **Map credits** (ⓘ, bottom right): an outlined icon instead of a white disc; dark when opened. The "Press / to search" hint moved to the bottom centre (it covered the ⓘ).
- **Pick the date and time**: click the banner clock (or the Date in a constellation) for a UTC date/time field, ±30 days around today; Now goes back to the present.
- **Clock carried between views**: clicking a satellite in a time-lapse keeps its simulated time and speed (it reset to live ×1 without notice); opening a constellation from a satellite in time-lapse continues that clock.
- **Speed ×1 / ×10 / ×100 / ×300** in the banner, with ⟲ back to live: the simulated clock drives the satellite, swath, day/night and the banner clock ("Sim UTC").
- **Camera**: zoom follows latitude so the globe keeps its size near the poles (the satellite no longer leaves the screen; `zoom=` in the URL stays the equator value). Exact position and ground-track heading every frame: no more camera jolts every 15 s, no jitter at ×100.

### 🌐 Constellation view
- **`?group=<id>` overview** (e.g. `edc`, `sentinel-2`, `iceye`, `gps`): every satellite of a constellation at once, on its real orbit. The orbit is seen edge-on over its daylit pass, so the ground track runs down the middle of a globe that fills the screen. Reachable from the search palette (`/`) and a "View constellation" button on member satellites. Click a satellite to track it.
- **Time-lapse**: the camera is fixed in inertial space so the Earth visibly turns under the ring while satellites run round it and paint their swath (EarthDaily 240 km) onto the surface. Play/pause, speed (one value: a click steps ×1 → ×10 → ×100 → ×300) and restart live in the top banner, laid out like the single-satellite one (Date · Sim UTC · constellation · Sats · Speed); its clock shows the simulated time, so only one clock is on screen.
- **Swaths that match the real geometry**: each satellite flies at its real altitude on its orbit ring, tied by a translucent sensor cone to both ends of the scan line it is imaging; its footprint (bright for the last 4 min, faint for the last 90 min) is cut and faded on the GPU so it moves smoothly. Optical swaths are drawn only in daylight (sun ≥ 10° at nadir); Sentinel-1 (radar) images day and night. One faint orbit ring per orbital plane.
- Rendered by a deck.gl `MapboxOverlay` inside MapLibre's globe (the flat overlay cannot sit correctly on the globe at whole-Earth zoom); the far side is hidden by the Earth.
- **43 constellations** (was 4): public EO (Sentinel-1/2/3, Landsat, EarthDaily, MODIS, VIIRS, MetOp, Fengyun-3, CBERS), commercial optical (Planet SuperDove/SkySat/Pelican, Maxar, Pléiades, SPOT, BlackSky, Satellogic, Jilin-1, SuperView, KOMPSAT), SAR (ICEYE, Capella, Umbra, COSMO-SkyMed, TerraSAR-X/PAZ, RCM, SAOCOM, ALOS, StriX, iQPS) and non-imagers (OneWeb, Kuiper, Qianfan, Iridium, Globalstar, ORBCOMM, Spire, GPS, Galileo, GLONASS, BeiDou, geostationary weather). Members are found by name, not listed: several CelesTrak name queries per constellation, a pattern on the satellite id to drop unrelated matches, and only satellites SATCAT marks operational, so launches join and dead satellites (e.g. 60 of 96 Globalstars) leave on their own. Cached 6 h.
- **Opens on the day side with the equator at the centre**: imagers over their orbit's daylit equator crossing (ground track still vertical), non-imagers face-on to their orbit plane from its sunlit side.
- **Swaths follow the Earth's curvature**: scan line, cone base and every swath row are arcs along the ground, so the cone ends exactly on the swath's leading edge (VIIRS/MODIS swaths were flat ribbons standing ~180 km off the surface at the limb). Swath quads are built once per 30 min chunk and faded by age on the GPU (`DataFilterExtension`, replacing `TripsLayer` and `@deck.gl/geo-layers`).
- Non-imagers have no swath or sensor cone; low-inclination belts are seen from 30° north, so the geostationary belt is a ring round the Earth; the zoom fits navigation and geostationary orbits, and MapLibre's far plane is moved behind them so their far side isn't clipped.
- **EarthDaily naming**: EDC-01 to EDC-08 = YAM-10 to YAM-17 (verified by COSPAR designator); `/edc-03` URLs resolve to the right satellite.

### 🌗 Day / night
- One continuous globe: NASA VIIRS city lights are faded in over the day imagery by the sun's elevation at every pixel (soft twilight terminator), replacing the per-satellite basemap swap. Accurate sun position (equation of time included). Follows the simulated clock in the time-lapse.

### ⚙️ Settings
- **`?` (or `H`) opens a settings panel**, kept in this browser: constellation time-lapse speed (default ×100), satellite picture on the globe instead of a dot, and the keyboard shortcuts (replaces the 5 s help popup).

### 🔧 Fixes
- Night side blinked every few seconds during the time-lapse: the day/night buffers cross-faded through ~50 % opacity, letting the day imagery through. They now swap instantly.
- Search palette lists at once (ISS first and preselected, then Sentinel-2, Sentinel-1, Landsat, EarthDaily) instead of staying empty until the full catalogue downloads.
- Satellite search palette no longer empty when CelesTrak rate-limits the full catalogue (403): falls back to known satellites and name queries; selecting loads the satellite on demand.
- Deep links to any satellite load a single targeted CelesTrak query (cached) instead of the 47k-line `active` file.
- Camera defaults to zoom 4.7 / pitch 62 everywhere (URL params still win); fixed races that cancelled the fly-in (stale deck zoom, early tracking start).
- The fly-in to a satellite ends on its heading and ground point, so the camera no longer turns and slides a second after arriving.
- Multisampling enabled on the map canvas (aliasing).
- Swaths no longer lag their satellite or appear where none flew (deck re-cut globe paths without their per-vertex timestamps/colours).
- MapLibre 5.24: no more tile explosion (2 fps) on the globe at high pitch.
- Sentinel-2B showed as "sennel-2b - MSI".
- Switching from a constellation to one of its satellites no longer draws the satellite at the time-lapse's simulated position for the first seconds.
- Overlapping satellite labels: the farther of two overlapping labels fades out (a far label's text printed through a near label's box), and dots are drawn above labels so none is hidden.
- Constellation time-lapse holds 60 fps at ×300: no per-frame forced layout (cached map height), the empty flat overlay is no longer redrawn and composited, night tiles re-render at most every 3 s of real time.
- Constellation view keeps `pitch` from the URL on reload.
- Lint runs again (`.eslintrc.json` extended a config that doesn't exist).
- Constellation view tilted (Ctrl-drag) or rotated: swaths, rings and satellites stay on the globe, and a satellite and its label slide behind the limb when the Earth blocks the line of sight to them, hidden progressively (deck.gl 9.1 → 9.4: its globe ignored pitch and bearing).
- GitHub Pages subpath (`/fromupthere/`): icon paths, routing and 404 redirect.

## [0.3.0] - 2025-01-06

### 🌍 New Features
- **Automatic Night Mode Basemap**: Basemap now automatically switches between day and night tiles based on satellite's local solar time
  - **Solar Calculator**: New utility calculates solar elevation and local time at satellite positions
  - **Real-time Switching**: Basemap changes automatically when satellite passes from day to night or vice versa
  - **Local Time Logging**: Console logs satellite's local time in 24-hour format with solar elevation and day/night status every 5 seconds
  - **Smart Detection**: Uses astronomical calculations to determine if sun is above or below horizon at satellite's location

### 🎛️ UI Improvements  
- **Simplified Cockpit**: Removed cockpit hide/show button - cockpit is now always visible
  - **No More Toggle**: Removed C key shortcut and show cockpit button
  - **Cleaner Interface**: Eliminated unnecessary UI complexity and related CSS

### 🛰️ Satellite Enhancements
- **Larger Default Satellites**: Increased default satellite scale factor from 1.0x to 2.0x for better visibility
  - **More Visible**: All satellites now appear twice as large by default
  - **Customizable**: Individual satellites can still override with custom scaleFactor values

### 🔧 Technical Improvements
- **Code Cleanup**: Removed unused cockpit hiding functionality and related event handlers
- **Type Safety**: All changes maintain full TypeScript compliance
- **Performance**: Optimized basemap switching logic to only update when day/night state changes

## [0.2.4] - 2025-01-06

### 🧹 Code Cleanup
- **Removed Unreferenced UI Elements**: Cleaned up 151 lines of dead code referencing non-existent HTML elements
  - **Pitch Slider**: Removed pitch slider and related event listeners
  - **Unused Buttons**: Removed references to toggle-basemap, track-iss, show-starlink, pause-updates, satellite-tracked-only
  - **Filter System**: Removed filter functionality for non-existent filter checkboxes and count elements
  - **Dead Methods**: Removed updateSatelliteTrackedOnlyButton and related unused functionality

### ⚡ Performance Improvements
- **Bundle Size Reduction**: Main bundle reduced from 94.43 kB to 91.06 kB (-3.37 kB)
- **Cleaner Codebase**: Removed all references to non-existent HTML elements
- **Better Maintainability**: Simplified code structure with only functional elements

### 🛠️ Technical Improvements
- Cleaned up `main.ts`, `deck-satellite-tracker.ts`, and `cockpit.component.ts`
- Improved type safety by removing references to non-existent DOM elements
- Streamlined event listener setup and UI update logic

## [0.2.3] - 2025-01-06

### ✨ New Features
- **User-Controllable Camera Bearing**: Users can now override automatic satellite direction tracking
  - **Horizontal Drag Control**: Drag horizontally while tracking a satellite to manually control viewing angle
  - **Automatic Mode**: Bearing automatically follows satellite movement direction by default
  - **Manual Override**: First horizontal drag activates manual control with visual feedback
  - **Reset to Auto**: Press `B` key to return to automatic satellite direction following

### 🎮 User Experience
- **Intuitive Controls**: Natural mouse drag interaction for bearing control while tracking
- **Visual Feedback**: Clear messages when switching between automatic and manual bearing modes
- **Seamless Transition**: Automatic reset to auto mode when tracking new satellites
- **Responsive Design**: Only activates on significant horizontal movement to prevent accidental activation

### 🛠️ Technical Improvements
- Enhanced `SmoothCamera` class with user bearing control state management
- Improved mouse interaction logic with bearing override detection
- Better camera state synchronization between automatic and manual modes

## [0.2.2] - 2025-08-06

### ✨ New Features
- **Fullscreen Mode**: Press `F` key to toggle fullscreen mode for immersive satellite tracking experience
- **Enhanced Keyboard Controls**: Added fullscreen toggle with visual confirmation messages

### 🎮 User Experience
- **Seamless Fullscreen**: Quick keyboard access to fullscreen without UI buttons
- **Visual Feedback**: Clear confirmation messages when entering/exiting fullscreen mode

## [0.2.1] - 2025-08-06

### 🐛 Bug Fixes
- **Fixed Satellite URL Routing**: Resolved issue where `/yam-10` and other satellite URLs were incorrectly redirecting to `iss-zarya`
- **Improved GitHub Pages SPA Handling**: Updated URL state management to properly handle redirect parameters from GitHub Pages 404 fallback

### 🛠️ Technical Improvements
- Enhanced URL routing logic to prevent default ISS redirect when processing GitHub Pages redirects
- Better handling of Single Page Application (SPA) routing on static hosting platforms

## [0.2.0] - 2025-01-06

### 🚀 Major Features Added
- **Command Palette Search System**: Press `/` to search across 12,000+ satellites
- **On-Demand Satellite Loading**: Satellites loaded only when needed for optimal performance
- **Search Database**: Full Celestrak database cached for instant search results
- **Virtual Scrolling**: Handle large search results efficiently

### ✨ Enhanced Satellite Tracking
- **Smart Camera System**: Automatic bearing, zoom, and pitch adjustment per satellite
- **Satellite-Specific View Settings**: Configure default camera settings per satellite
- **Improved Search Matching**: Search by name, ID, type, and alternate names
- **Real-Time Position Updates**: More accurate orbital position calculations

### 🎨 User Experience Improvements
- **Modern Command Palette Interface**: Clean, keyboard-navigable satellite search
- **Performance Optimizations**: Faster rendering with Level-of-Detail (LOD) system
- **Enhanced Visual Feedback**: Better loading states and search result display
- **Responsive Design**: Improved mobile and desktop experience

### 🛠️ Technical Improvements
- **Modular Architecture**: Better separation of concerns with TypeScript interfaces
- **Search Database Management**: Efficient caching and loading of satellite data
- **Memory Optimization**: Reduced memory usage with smart data management
- **Error Handling**: Improved error handling for network and data issues

### 🐛 Bug Fixes
- Fixed command palette showing only tracked satellite instead of full database
- Resolved satellite image rendering and scaling issues
- Fixed orbital calculations for high-altitude satellites
- Improved TLE data parsing and validation

## [0.1.0] - 2025-01-05

### 🎉 Initial Release Features

#### Core Functionality
- **Real-Time Satellite Tracking**: Live orbital positions using TLE data from Celestrak
- **3D Visualization**: WebGL-powered rendering with Deck.gl
- **Interactive Controls**: Mouse-driven Earth rotation and zoom
- **Satellite Selection**: Basic search and tracking functionality

#### Supported Satellites
- **International Space Station (ISS)**: Featured with custom icon and TLE data
- **Earth Observation**: Landsat, MODIS, Sentinel constellation support
- **Navigation Systems**: GPS, Galileo, GLONASS satellites
- **Communication**: Starlink and commercial satellite tracking
- **Scientific**: Space telescopes and research satellites

#### Technical Foundation
- **TypeScript**: Full type safety and modern development practices
- **Vite Build System**: Fast development and optimized production builds
- **Satellite.js Integration**: Accurate orbital mechanics calculations
- **MapLibre GL**: Interactive base mapping system
- **Custom Satellite Icons**: Visual differentiation for major satellites

#### User Interface
- **Minimalist Cockpit**: Essential tracking information display
- **Real-Time Metrics**: Altitude, speed, and position updates
- **Responsive Design**: Desktop and mobile compatibility
- **Keyboard Shortcuts**: Power user accessibility

### Initial Data Sources
- Celestrak TLE data for orbital elements
- NORAD General Perturbations database
- Custom satellite imagery and metadata
- Real-time orbital propagation calculations

---

## Development Notes

### Version Numbering
- **Major** (X.0.0): Breaking changes, major feature releases
- **Minor** (0.X.0): New features, enhancements, significant improvements
- **Patch** (0.0.X): Bug fixes, minor improvements, documentation updates

### Recent Development Focus
The project has focused on performance optimization and user experience improvements, particularly around search functionality and satellite data management. The addition of the command palette and on-demand loading represents a major step forward in handling large datasets efficiently.

### Upcoming Roadmap
- Enhanced orbit visualization
- Real-time satellite pass predictions
- Advanced filtering and categorization
- Satellite constellation grouping
- Historical orbital data analysis
- Mobile app considerations

### Contributing
See README.md for contribution guidelines and development setup instructions.

---

**Changelog Format**: This changelog follows semantic versioning and focuses on user-facing changes. Technical implementation details are documented in commit messages and code comments.