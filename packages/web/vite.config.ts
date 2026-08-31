import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs separately; proxying keeps the browser on one origin.
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },
});
