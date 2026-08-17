import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { generateSW } from './scripts/generate-service-worker';

function offlineServiceWorker(): Plugin {
  return {
    name: 'agentwithu-offline-service-worker',
    apply: 'build',
    closeBundle() {
      generateSW();
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineServiceWorker()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
