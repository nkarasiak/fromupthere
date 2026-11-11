# From Up There 🛰️

A real-time 3D satellite tracking application that visualizes satellites in Earth's orbit with stunning graphics and real-time data.

![From Up There - Satellite Tracker](https://img.shields.io/badge/Status-Active-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)
![WebGL](https://img.shields.io/badge/WebGL-990000?logo=webgl&logoColor=white)
![Deck.gl](https://img.shields.io/badge/Deck.gl-5B5BD6?logo=uber&logoColor=white)

## ✨ Features

### 🎯 Real-Time Satellite Tracking
- **Live orbital positions** calculated using Two-Line Element (TLE) data from Celestrak
- **12,000+ satellites** from multiple constellations and agencies
- **Precise orbital mechanics** with satellite.js for accurate positioning
- **Real-time updates** with smooth interpolation between positions

### 🔍 Advanced Search & Discovery
- **Command palette** (`/` key) for instant satellite search across all 12k+ satellites
- **Smart search** by name, ID, type, or alternate names
- **On-demand loading** - satellites loaded only when needed for optimal performance
- **Virtual scrolling** for handling large search results efficiently

### 🎨 Immersive 3D Visualization
- **WebGL-powered rendering** with Deck.gl for high-performance graphics
- **Custom satellite icons** for major satellites (ISS, Starlink, Sentinel, etc.)
- **Dynamic scaling** with 2x larger default satellite size for better visibility
- **Orbit visualization** showing satellite trajectories
- **Automatic day/night basemap** that switches based on satellite's local solar time
- **Level-of-detail (LOD) system** for smooth performance with thousands of satellites

### 📱 Intuitive Interface
- **Minimalist cockpit design** with essential tracking information
- **Smart camera system** with automatic bearing, zoom, and pitch adjustment per satellite
- **Responsive controls** optimized for both desktop and mobile
- **Keyboard shortcuts** for power users

### 🛰️ Satellite Categories
- **International Space Station (ISS)** with detailed tracking
- **Earth Observation** - Landsat, MODIS, Sentinel constellation
- **Navigation** - GPS, Galileo, GLONASS systems  
- **Communication** - Starlink and other commercial satellites
- **Scientific** - Space telescopes and research satellites

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm
- Modern web browser with WebGL support

### Installation

```bash
# Clone the repository
git clone https://github.com/nkarasiak/fromupthere.git
cd fromupthere

# Install dependencies
npm install

# Start development server
npm run dev
```

The application will be available at `http://localhost:5173`

### Building for Production

```bash
# Type check and build
npm run build

# Preview production build
npm run preview
```

## 🎮 Usage

### Basic Controls
- **Mouse drag** - Rotate the Earth view
- **Mouse wheel** - Zoom in/out
- **`/` key** - Open command palette for satellite search
- **Click satellite name** - Quick search access

### Satellite Tracking
1. **Search**: Press `/` or click the tracking area to open command palette
2. **Select**: Type to search and select any satellite from 12k+ available
3. **Track**: Automatic camera tracking with optimal viewing angles
4. **Monitor**: Real-time altitude, speed, and position updates

### Advanced Features
- **Orbit visualization**: Toggle satellite orbital paths
- **Performance settings**: Automatic LOD adjustment for smooth performance
- **Type filtering**: Filter satellites by category (communication, scientific, etc.)

## 🛠️ Technology Stack

### Core Technologies
- **[TypeScript](https://www.typescriptlang.org/)** - Type-safe development
- **[Vite](https://vitejs.dev/)** - Fast build tool and development server
- **[Deck.gl](https://deck.gl/)** - WebGL-powered data visualization
- **[MapLibre GL](https://maplibre.org/)** - Interactive maps
- **[satellite.js](https://github.com/shashwatak/satellite-js)** - Satellite orbital calculations

### Key Libraries
- **@deck.gl/core** - 3D rendering engine
- **@deck.gl/layers** - Visualization layers (ScatterplotLayer, IconLayer)
- **@deck.gl/extensions** - GPU data filter (swath age fade)
- **@luma.gl/core** - WebGL abstraction

### Architecture Highlights
- **Modular design** with TypeScript interfaces and services
- **Performance optimization** with virtual scrolling, LOD, and lazy loading
- **Real-time calculations** using SGP4/SDP4 orbital propagation models
- **Responsive UI** with CSS Grid and Flexbox

## 📊 Data Sources

- **TLE Data**: [Celestrak](https://celestrak.org/) - Real-time orbital elements
- **Satellite Database**: GP (General Perturbations) format from NORAD
- **Images**: Custom satellite icons and imagery

## 🎯 Project Structure

```
src/
├── components/          # UI components (search, cockpit)
├── config/             # Satellite configurations and metadata
├── deck-satellite-tracker.ts  # Core tracking engine
├── command-palette.ts  # Search interface
├── main.ts            # Application entry point
├── positioning/       # Orbital calculations
├── rendering/         # WebGL rendering logic
├── services/          # Data fetching services
├── styles/            # CSS modules
├── types/             # TypeScript interfaces
└── utils/             # Helper utilities
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests.

### Development Guidelines
- Follow TypeScript best practices
- Maintain performance-focused code
- Test across different browsers
- Document new features

## 📄 License

This project is open source. Please check the license file for details.

## 🔗 Links

- **Live Demo**: [From Up There](https://fromupthere.com) _(if deployed)_
- **Issues**: [GitHub Issues](https://github.com/nkarasiak/fromupthere/issues)
- **Celestrak API**: [https://celestrak.org/](https://celestrak.org/)

## 🙏 Acknowledgments

- **Celestrak** for providing accurate TLE data
- **Deck.gl team** for the amazing WebGL framework
- **satellite.js contributors** for orbital mechanics calculations
- **Space agencies** (NASA, ESA, etc.) for satellite imagery and data

---

**Built with ❤️ for space enthusiasts and developers**

*Track satellites, explore orbits, and marvel at human space technology from your browser.*