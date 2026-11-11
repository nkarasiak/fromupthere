import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/fromupthere/' : '/',
  publicDir: 'public',
  plugins: [
    checker({
      typescript: true,
    }),
    visualizer({
      filename: 'dist/stats.html',
      open: false,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  server: {
    port: 3000,
    host: true,
    open: true,
    hmr: {
      overlay: true,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'esnext',
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: {
          'deck-gl': ['@deck.gl/core', '@deck.gl/layers', '@deck.gl/extensions', '@deck.gl/aggregation-layers', '@deck.gl/mapbox'],
          'maplibre': ['maplibre-gl'],
          'satellite': ['satellite.js'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  optimizeDeps: {
    include: ['@deck.gl/core', '@deck.gl/layers', 'maplibre-gl', 'satellite.js'],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
  },
})