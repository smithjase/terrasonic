import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/terrasonic/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
