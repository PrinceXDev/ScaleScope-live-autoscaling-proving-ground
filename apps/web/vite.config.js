import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    // GSAP and uPlot are both large-ish and change rarely; splitting them out
    // means a code edit doesn't invalidate them in the browser cache, which
    // matters when you're redeploying every few minutes during a build.
    rollupOptions: {
      output: {
        manualChunks: {
          gsap: ['gsap', '@gsap/react'],
          charts: ['uplot'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY || 'http://localhost:3000', changeOrigin: true },
    },
  },
});
