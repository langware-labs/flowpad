/**
 * Every shipped data source has a glyph of its own.
 *
 * The provider picker is a grid of icons — it is the one screen whose whole job is telling
 * providers apart — and two failure modes are invisible until someone looks at it:
 *
 * 1. **A name nothing resolves.** Resolution falls back to a generic glyph, so a typo, or a
 *    lucide release dropping a brand glyph, renders a generic page icon that still *looks*
 *    deliberate. `Slack` is one upstream removal away from exactly that.
 * 2. **Two providers wearing the same glyph.** Three of these ship a mailbox; when they all
 *    drew lucide's `Mail` the grid said nothing about which row was which.
 *
 * Both are asserted against the manifests on disk, so a new provider is covered the moment
 * it lands rather than when someone next opens the dialog.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getIconPacks, resolveIcon } from '@sdk/icons';
import { isLucideName } from '@src/lib/icon-value';

const MANIFEST_ROOT = join(
  __dirname,
  '../../../flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_source',
);

type Manifest = { name: string; title?: string; icon_name?: string };

const manifests: Manifest[] = readdirSync(MANIFEST_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => JSON.parse(readFileSync(join(MANIFEST_ROOT, e.name, 'data_source.json'), 'utf8')));

describe('provider icons', () => {
  it('finds the shipped manifests', () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(manifests.length).toBeGreaterThanOrEqual(12);
  });

  it.each(manifests.map((m) => [m.name, m.icon_name ?? ''] as const))(
    '%s resolves its icon_name (%s) to a real glyph',
    (name, iconName) => {
      expect(iconName, `${name} declares no icon_name`).not.toBe('');
      expect(
        resolveIcon(iconName, getIconPacks()).kind,
        `${name}'s icon_name "${iconName}" resolves to nothing, so the picker draws the generic ` +
          `document glyph — add it to a pack under flow_sdk/server/icons, or name one lucide serves`,
      ).not.toBe('none');
    },
  );

  it('gives every provider a glyph no other provider wears', () => {
    const byIcon = new Map<string, string[]>();
    for (const m of manifests) {
      const key = m.icon_name ?? '';
      byIcon.set(key, [...(byIcon.get(key) ?? []), m.name]);
    }
    const shared = [...byIcon.entries()].filter(([, names]) => names.length > 1);
    expect(
      shared.map(([icon, names]) => `${icon}: ${names.join(', ')}`),
      'these providers are indistinguishable in the picker',
    ).toEqual([]);
  });
});

/**
 * The same two failure modes, one screen over: the CONNECTION catalogue.
 *
 * `provider_registry.py` publishes an icon NAME per OAuth provider, and the Add
 * dialog is the grid whose whole job is telling providers apart. Nothing checked
 * that those names resolve, and two of them did not: lucide has no `Google` and
 * no `Microsoft` glyph, so both tiles fell through to the generic key — a tile
 * that says "no icon found" where a person is choosing between providers.
 *
 * Read off the Python rather than restated here, for the reason the manifest
 * block gives: a provider added tomorrow is covered the moment it lands.
 */
const REGISTRY = join(__dirname, '../../../flow_sdk/core/oauth/provider_registry.py');
const providerIcons = [...readFileSync(REGISTRY, 'utf8').matchAll(/^\s*icon="([^"]+)",/gm)].map((m) => m[1]);

describe('connection provider icons', () => {
  it('finds the published icon names', () => {
    expect(providerIcons.length).toBeGreaterThanOrEqual(6);
  });

  it.each(providerIcons)('%s resolves to a real glyph', (name) => {
    // `isLucideName` is what the dialog and the table both gate on before
    // calling `lucideByName`; a name that fails it never reaches a glyph at all
    // and the caller draws its generic fallback instead.
    expect(isLucideName(name), `${name} resolves to nothing — the tile draws a generic fallback`).toBe(true);
    // `not.toBe(FileText)` used to catch a name falling through to the generic
    // glyph. Resolution now returns a component bound to the tag, so identity
    // can never equal FileText and that assertion would pass vacuously — ask
    // the resolver instead, which is the question the test was really asking.
    expect(resolveIcon(name, getIconPacks()).kind, `${name} resolves to nothing`).not.toBe('none');
  });

  it('gives every provider a glyph of its own', () => {
    // Two providers wearing one mark is the other invisible failure: the grid
    // renders, and says nothing about which row is which.
    expect(new Set(providerIcons).size).toBe(providerIcons.length);
  });
});
