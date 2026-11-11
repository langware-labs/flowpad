/** An artifact chip or the received-file dialog's Open always lands somewhere: a shared file on that
 *  file, any other artifact in WorldView. It used to be a dead click (`/dock/artifact/<id>` has no view). */
import { describe, expect, it } from 'vitest';

import { ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { buildDockPointer } from '@src/navigation/entity-pointer';

const ID = 'a7b3e2e5-f9e5-411b-9fa5-5cb907efec08';

describe('where an artifact opens', () => {
  it('a shared file opens as that file', () => {
    const path = '/w/proj/shared/x/page.html';
    const row = { type: 'artifact', id: ID, kind: 'content.file.text', asset_ref: path };
    expect(buildDockPointer(row, undefined)).toEqual(DockPointer.forAssetEditor('file', path));
  });

  it('any other artifact opens in WorldView', () => {
    expect(buildDockPointer({ type: 'artifact', id: ID }, undefined)?.viewType).toBe(ViewType.WORLDVIEW);
  });
});
