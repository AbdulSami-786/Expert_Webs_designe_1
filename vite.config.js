import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// jsPDF's optional deps (html2canvas, dompurify) are only used by its .html()
// renderer, which this app never calls. Alias them to an empty module so they
// are not bundled. See src/lib/empty-module.js.
const empty = fileURLToPath(new URL('./src/lib/empty-module.js', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the build also works from a sub-path or the desktop app.
  base: './',
  resolve: {
    alias: {
      html2canvas: empty,
      dompurify: empty,
    },
  },
  server: { port: 5173, open: true },
});
