import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the built admin dashboard also opens from a local file or any sub-folder.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5300, strictPort: true },
});
