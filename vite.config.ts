import { defineConfig } from 'vite';

// relative base so the build works from any static host path (GitHub Pages, Netlify, a USB stick...)
export default defineConfig({
  base: './',
});
