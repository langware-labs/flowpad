import { defineConfig } from 'vite';

/**
 * OPTIONAL dev server. The app needs no build — production is `flow app serve`,
 * where Flowpad serves this folder from its own origin.
 *
 * A dev server is a different origin, so the SDK would lose both the injected
 * API origin and the session cookies. The proxy restores same-origin: `/sdk`
 * and `/api` are forwarded to the backend, so the exact same `import
 * '/sdk/flowpad-sdk.js'` works here too.
 *
 * FLOWPAD_BACKEND is supplied by the environment (`flow context` knows the
 * instance's port). Never hardcode a backend URL in app code — it breaks on
 * every other instance and in cloud.
 */
const backend = process.env.FLOWPAD_BACKEND || 'http://localhost:9007';

export default defineConfig({
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/sdk': { target: backend, changeOrigin: true },
    },
  },
});
