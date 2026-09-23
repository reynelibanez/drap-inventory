import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Escribe un identificador de versión en el service worker: cada build lo cambia y así los navegadores detectan la actualización. */
function serviceWorkerVersion(): Plugin {
  return {
    name: 'sw-build-id',
    apply: 'build',
    closeBundle() {
      const file = fileURLToPath(new URL('./dist/sw.js', import.meta.url));
      if (existsSync(file)) writeFileSync(file, readFileSync(file, 'utf8').replaceAll('__BUILD_ID__', Date.now().toString(36)));
    },
  };
}

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string };

// En desarrollo, la interfaz (5173) reenvía /api al servidor (3000).
export default defineConfig({
  plugins: [react(), serviceWorkerVersion()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version ?? '1.0.0') },
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } } },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
});
