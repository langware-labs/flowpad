import react from '@vitejs/plugin-react-swc';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { sharedAliases } from './vite.shared';

/**
 * Builds `examples/icon-gallery` — the icon showcase.
 *
 * It lives here for the reason `vite.sdk.config.ts` gives: ts_sdk and the
 * examples have no toolchain of their own, and `ui` already has vite and
 * already resolves `@sdk`. Standing up a second dependency tree for one static
 * page would be a tree to keep in step forever.
 *
 * The page talks to a running backend — that is the point of it. The API origin
 * is injected the same way the served app gets it, via
 * `globalThis.__FLOWPAD_API_URL__` (see `load_config`), so no URL is baked in.
 */
const repoRoot = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, repoRoot, '') };
  const apiUrl = env.VITE_API_URL || `http://localhost:${env.LOCAL_SERVER_PORT || 8000}`;

  return {
    root: path.resolve(repoRoot, 'examples/icon-gallery'),
    envDir: repoRoot,
    plugins: [react()],
    resolve: {
      alias: {
        ...sharedAliases(__dirname),
        // The page lives outside `ui/`, so node resolution from its own
        // directory finds no `node_modules`. Point the few runtime packages at
        // ui's copy rather than standing up a second dependency tree.
        react: path.resolve(__dirname, 'node_modules/react'),
        'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
        // The page registers lucide as the SDK's bundle renderer, which is the
        // thing that keeps a bundle glyph tree-shaken instead of fetched.
        'lucide-react': path.resolve(__dirname, 'node_modules/lucide-react'),
      },
      dedupe: ['react', 'react-dom', 'lucide-react'],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
      'process.env': '{}',
      __API_URL__: JSON.stringify(apiUrl),
      __AUTH_PROVIDER__: JSON.stringify(env.AUTH_PROVIDER || 'local'),
      __DEPLOY_ENV__: JSON.stringify(env.DEPLOY_ENV || 'local'),
    },
    server: { port: Number(env.ICON_GALLERY_PORT || 4310), strictPort: false },
    build: { outDir: path.resolve(repoRoot, 'examples/icon-gallery/dist'), emptyOutDir: true },
  };
});
