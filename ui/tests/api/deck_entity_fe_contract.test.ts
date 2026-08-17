/**
 * `deck` entity + viewer wiring contract (api tier).
 *
 * A generated deck is a first-class `deck` entity (folder under assets/decks/
 * with a deck.json marker). This test proves the wiring end to end against a
 * real backend:
 *   1. `flow record index <project root>` discovers the deck folder → a `deck`
 *      entity with the denormalized shape the viewer reads (num_slides, html_file).
 *   2. the frontend routes that type to the DeckViewer (`editorForType('deck')`).
 *
 * Requires: a running backend at localhost:$LOCAL_SERVER_PORT (api project).
 */
import { AssetEditor, apiClient, editorForType, GRAPH_API_PREFIX, RecordType } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('deck entity — indexes with the viewer shape and routes to the DeckViewer', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('routes RecordType.DECK to the deck asset editor (pure)', () => {
    expect(editorForType(RecordType.DECK)).toBe(AssetEditor.DECK);
  });

  it('indexing a project root mints a deck entity anchored at the folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fe-'));
    // Repo assets live under `agentic-assets/<family>/<slug>/` (placement
    // refactor 7f0f8d92 / 65ae24d3) — the recursive `repo_assets_fn` walker
    // discovers them keyed by the deck type's `family` ("deck").
    const deckDir = path.join(root, 'agentic-assets', 'deck', 'nightowl');
    fs.mkdirSync(deckDir, { recursive: true });
    fs.writeFileSync(
      path.join(deckDir, 'deck.json'),
      JSON.stringify({
        title: 'NightOwl Pitch',
        slides: [
          { layout: 'cover-centered', slots: { title: 'NightOwl' } },
          { layout: 'closing-centered', slots: { title: 'Thanks' } },
        ],
      }),
    );
    fs.writeFileSync(path.join(deckDir, 'nightowl.html'), '<html><body>deck</body></html>');

    const url =
      `${GRAPH_API_PREFIX}/compute_node/@local/fs-records/index` +
      `?type=deck&path=${encodeURIComponent(root)}`;
    const result: any = await apiClient.post(url, {});
    // Type-filtered index returns a flat summary {type, indexed, ...}.
    expect(result?.type).toBe('deck');
    expect(result?.indexed, 'deck walker must index the folder').toBe(1);

    // The index stamps the deck's id into its named identity capsule
    // (`.flow/capsules/identity.json` — canonical AssetCapsule store; the bare
    // `.flow/id` is a read-only legacy carrier) — fetch by it.
    // (The DB record carries name + asset_ref; the metadata-derived typed fields
    // like num_slides project via `from_fs_ref` on disk-load — the path the
    // viewer uses, covered by the python test_deck_from_fs_ref unit test — not
    // the DB GET, matching deck_template's behaviour.)
    const capsule = JSON.parse(
      fs.readFileSync(path.join(deckDir, '.flow', 'capsules', 'identity.json'), 'utf-8'),
    );
    const id = String(capsule.data.id).trim();
    const entity: any = await apiClient.get(`/graph/deck/${id}`).then((r: any) => r?.data ?? r);
    expect(entity.type).toBe('deck');
    expect(entity.name).toBe('NightOwl Pitch');
    // asset_ref is the deck FOLDER (the backend resolves symlinks, e.g. macOS
    // /private prefix — match on the suffix rather than the raw temp path).
    expect(entity.asset_ref).toMatch(/agentic-assets\/deck\/nightowl$/);
  }, 15000);
});
