/**
 * `browserDoorUrl(endpoint)` — a shared app's landing opens the app through the hub's `open` door;
 * an endpoint no browser can enter has no door, and keeps the generic landing's destination.
 */
import { describe, expect, it } from 'vitest';
import { browserDoorUrl } from '@sdk';

const ID = '99999999-8888-4777-8666-555555555555';

describe('browserDoorUrl', () => {
  it.each(['app', 'admin'] as const)('opens a %s endpoint through its door', (subkind) => {
    expect(browserDoorUrl({ id: ID, subkind })).toMatch(new RegExp(`/service_endpoint/${ID}/open$`));
  });

  it.each(['system', 'agent', 'service'] as const)('gives a %s endpoint no door', (subkind) => {
    expect(browserDoorUrl({ id: ID, subkind })).toBeNull();
  });
});
