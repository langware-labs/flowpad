import { describe, expect, it, vi } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';

describe('DockPointer.splitProjectPointer', () => {
  it('returns nulls for empty/undefined/null input', () => {
    expect(DockPointer.splitProjectPointer(undefined)).toEqual({
      projectId: null,
      assetSubPointer: '',
    });
    expect(DockPointer.splitProjectPointer(null)).toEqual({
      projectId: null,
      assetSubPointer: '',
    });
    expect(DockPointer.splitProjectPointer('')).toEqual({
      projectId: null,
      assetSubPointer: '',
    });
  });

  it('parses a bare projectId with no sub-pointer', () => {
    const pid = 'dd682350-c185-52c9-a92b-d0667141b069';
    expect(DockPointer.splitProjectPointer(pid)).toEqual({
      projectId: pid,
      assetSubPointer: '',
    });
  });

  it('splits projectId from a single-segment sub-pointer', () => {
    const pid = 'dd682350-c185-52c9-a92b-d0667141b069';
    expect(DockPointer.splitProjectPointer(`${pid}/editor`)).toEqual({
      projectId: pid,
      assetSubPointer: 'editor',
    });
  });

  it('preserves multi-segment sub-pointers (folders, editor with typeid)', () => {
    const pid = 'dd682350-c185-52c9-a92b-d0667141b069';
    expect(
      DockPointer.splitProjectPointer(`${pid}/editor/markdown-abc123`),
    ).toEqual({
      projectId: pid,
      assetSubPointer: 'editor/markdown-abc123',
    });
    expect(
      DockPointer.splitProjectPointer(`${pid}/folder/markdown-vault1/notes/sub`),
    ).toEqual({
      projectId: pid,
      assetSubPointer: 'folder/markdown-vault1/notes/sub',
    });
  });
});

describe('the workspace host never reaches the asset layer', () => {
  const PID = 'dd682350-c185-52c9-a92b-d0667141b069';
  const ASSET = 'a684848a-af63-4c8a-988e-37a2c01b20b5';
  const HOSTED = `/dock/project/${PID}/process/agentic_process-abc/display/editor/markdown/typeid/markdown-${ASSET}`;

  it('lifts the host out of the pointer, leaving the plain asset sub-pointer', () => {
    const dock = DockPointer.fromUrl(HOSTED);
    // Everything downstream — targetTypeId, the AssetsPage parsers, the stored
    // pointer — sees exactly what a hostless project dock carries.
    expect(DockPointer.splitProjectPointer(dock.pointer)).toEqual({
      projectId: PID,
      assetSubPointer: `editor/markdown/typeid/markdown-${ASSET}`,
    });
    expect(dock.hostProcessId).toBe('agentic_process-abc');
  });

  it('resolves the target entity exactly as the hostless URL does', () => {
    const tail = `editor/markdown/typeid/markdown-${ASSET}`;
    const plain = DockPointer.fromUrl(`/dock/project/${PID}/${tail}`);
    const hosted = DockPointer.fromUrl(`/dock/project/${PID}/process/agentic_process-abc/display/${tail}`);
    expect(String(hosted.targetTypeId)).toBe(String(plain.targetTypeId));
    expect(String(hosted.targetTypeId)).toBe(`markdown-${ASSET}`);
  });

  it('complains loudly but still degrades gracefully if a composite slips through', () => {
    // A stored row or hand-built dock that kept the composite form. Silently it
    // would reach `AssetDocPointer.parse`, get swallowed by `loadAssetRoute`,
    // and leave a blank pane. But this is a READ path — three components call it
    // during render — so it must not throw either: name it, strip it, continue.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      DockPointer.splitProjectPointer(
        `${PID}/process/agentic_process-abc/display/editor/markdown/typeid/markdown-${ASSET}`,
      ),
    ).toEqual({ projectId: PID, assetSubPointer: `editor/markdown/typeid/markdown-${ASSET}` });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/workspace host/i));

    err.mockRestore();
  });
});
