import { config } from 'dotenv';
import path from 'path';
import { defineConfig } from 'vite';
// import { analyzer } from 'vite-bundle-analyzer';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import dts from 'vite-plugin-dts';
import { version } from './package.json';

const envPath = path.resolve(__dirname, '..', '..', '..', '.env.local');
config({ path: envPath });
const sentryDsn = process.env.SENTRY_DSN || '';
const sentryOrg = process.env.SENTRY_ORG || '';
const sentryProject = process.env.SENTRY_PROJECT || process.env.DEPLOY_ENV;
const backend_scheme = process.env.SERVICE_URLS_CONFIG__BACKEND_SCHEME || 'http';
const backend_host = process.env.SERVICE_URLS_CONFIG__BACKEND_HOST || 'localhost';
console.log('##### SDK ####');
const backend_port =
  process.env.SERVICE_URLS_CONFIG__BACKEND_PORT ||
  (process.env.DEPLOY_ENV && process.env.DEPLOY_ENV !== 'local' ? null : '8000');
const backend_url = `${backend_scheme}://${backend_host}${backend_port ? `:${backend_port}` : ''}`;
console.log('vite config AUTH_PROVIDER = ', process.env.AUTH_PROVIDER);
console.log('vite config DEPLOY_ENV = ', process.env.DEPLOY_ENV);
console.log('vite config BACKEND_URL = ', backend_url);
console.log('vite config API_URL_WL = ', process.env.API_URL_WL);
console.log('vite config SENTRY_DSN = ', sentryDsn);
console.log('vite config SENTRY_PROJECT = ', sentryProject);
console.log('vite config SENTRY_ORG = ', sentryOrg);
console.log('vite config FLOWPAD_APP_HOST = ', process.env.MICRO_APP_DOMAIN_CONFIG__APP_DOMAIN);

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV),
    __API_URL__: JSON.stringify(backend_url),
    __API_URL_WL__: JSON.stringify(process.env.API_URL_WL),
    __AUTH_PROVIDER__: JSON.stringify(process.env.AUTH_PROVIDER),
    __DEPLOY_ENV__: JSON.stringify(process.env.DEPLOY_ENV),
    __SENTRY_DSN__: JSON.stringify(sentryDsn),
    __SENTRY_PROJECT__: JSON.stringify(sentryProject),
    __FLOWPAD_APP_HOST__: JSON.stringify(process.env.MICRO_APP_DOMAIN_CONFIG__APP_DOMAIN),
    __FLOWPAD_APP_PORT__: JSON.stringify(process.env.MICRO_APP_DOMAIN_CONFIG__PORT),
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      name: 'FlowpadSdk',
      fileName: 'flowpad-sdk',
    },
    minify: process.env.DEPLOY_ENV !== 'local' ? 'esbuild' : false,
    sourcemap: true,
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
      },
      onwarn(warning, warn) {
        // Suppress dynamic import warnings for known circular dependencies
        if (warning.message?.includes('is dynamically imported') && warning.message?.includes('context.ts')) {
          return;
        }
        warn(warning);
      },
    },
  },
  plugins: [
    // Creates .d.ts files so all hierarchy imports are available
    dts({
      insertTypesEntry: true,
      rollupTypes: true,
    }),
    // analyzer()
    // Only run Sentry plugin during build
    sentryDsn !== '' &&
      sentryVitePlugin({
        org: sentryOrg,
        project: sentryProject,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        bundleSizeOptimizations: {
          excludeReplayWorker: true,
        },
      }),
  ],
});
