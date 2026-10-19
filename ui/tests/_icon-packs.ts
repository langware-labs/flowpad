import fs from 'node:fs';
import path from 'node:path';
import { loadIconPacks, type IconPackSpec } from '@sdk/icons';

/**
 * Load the shipped icon packs into the SDK registry, as bootstrap does.
 *
 * The app gets these from `GET /api/v1/graph/bootstrap` before its first
 * render, so every icon predicate has them. A test tier with no backend does
 * not — and the predicates would then answer "unknown" for every name the packs
 * define, which is a property of the fixture, not of the code under test.
 *
 * Read off disk rather than hand-written: these are the same manifests the
 * backend publishes, so a test can never disagree with production about what a
 * pack contains.
 */
export function loadShippedIconPacks(): IconPackSpec[] {
  const root = path.resolve(__dirname, '../../flow_sdk/server/icons');
  const packs: IconPackSpec[] = [];

  for (const dir of fs.readdirSync(root)) {
    const manifest = path.join(root, dir, 'icon_pack.json');
    if (!fs.existsSync(manifest)) continue;
    const pack = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as IconPackSpec;

    // `served` is derived by the backend from the pack's directory; mirror that
    // here so a bundle pack vouches for exactly the files it ships, and a typo
    // still fails in tests the way it fails in production.
    if (!pack.icons?.length && pack.base) {
      const assets = path.join(root, dir, path.basename(pack.base));
      if (fs.existsSync(assets)) {
        pack.served = fs
          .readdirSync(assets)
          .filter((f) => f.endsWith('.svg'))
          .map((f) => f.replace(/\.svg$/, ''))
          .sort();
      }
    }
    packs.push(pack);
  }

  packs.sort((a, b) => a.kind.localeCompare(b.kind));
  loadIconPacks(packs);
  return packs;
}
