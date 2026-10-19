/**
 * Git sharing — the source-level gate that decides which Share dialogs show the
 * Git toggle, plus the conversation default.
 *
 * The toggle renders iff the ShareSource sets ``gitPreflightRef`` (the asset
 * TypeId the backend preflights). Only asset/artifact shares set it — never
 * sessions, forwards, collaboration invites, or raw files. And a NEW conversation
 * defaults Git sharing OFF.
 */
import { describe, expect, it } from 'vitest';
import { Artifact, Conversation, TypeId } from '@sdk';
import {
  agenticProcessShareSource,
  artifactShareSource,
  collaborateShareSource,
  fileShareSource,
  folderShareSource,
  genericEntityShareSource,
  messageForwardShareSource,
} from '@src/hooks/share-sources';

const SKILL_ID = '11111111-aaaa-4bbb-9ccc-000000000001';
const ART_ID = '22222222-aaaa-4bbb-9ccc-000000000002';
const PROC_ID = '33333333-aaaa-4bbb-9ccc-000000000003';
const NODE_ID = '44444444-aaaa-4bbb-9ccc-000000000004';
const FOLDER_ID = '55555555-aaaa-4bbb-9ccc-000000000005';

describe('git share source gating', () => {
  it('generic file-backed asset shares expose the Git toggle', () => {
    const src = genericEntityShareSource(new TypeId('skill', SKILL_ID));
    expect(src.gitPreflightRef?.toString()).toBe(new TypeId('skill', SKILL_ID).toString());
  });

  it('artifact shares expose the Git toggle without auto-forcing git', () => {
    const artifact = new Artifact({ id: ART_ID, name: 'app', path: '/repo/app', origin: null });
    const src = artifactShareSource(artifact);
    expect(src.gitPreflightRef?.toString()).toBe(artifact.typeId.toString());
    // Auto-force removed: the source never statically selects git mode; the
    // dialog's toggle + backend preflight drive it.
    expect(src.shareConfig?.transferMode).toBeUndefined();
  });

  it('session, forward, collaboration, and raw-file shares never show the toggle', () => {
    expect(agenticProcessShareSource(new TypeId('agentic_process', PROC_ID)).gitPreflightRef).toBeUndefined();
    expect(messageForwardShareSource({ label: 'fwd' }).gitPreflightRef).toBeUndefined();
    expect(collaborateShareSource(null).gitPreflightRef).toBeUndefined();
    expect(
      fileShareSource({ computeNodeTypeId: new TypeId('compute_node', NODE_ID), absPath: '/x/y.txt' })
        .gitPreflightRef,
    ).toBeUndefined();
  });

  it('a folder share pins git as POLICY, so no toggle is offered', async () => {
    const src = folderShareSource(new TypeId('folder', FOLDER_ID), { label: 'widgets' });
    // Pinned: the bytes always travel as a git origin…
    expect(src.shareConfig?.transferMode).toBe('git');
    // …and precisely because it isn't optional, no preflight ref → the dialog's
    // `gitCapable` is false → no toggle, and the conversation's
    // git_sharing_enabled preference is left untouched. Mandatory ≠ preference.
    expect(src.gitPreflightRef).toBeUndefined();
  });

  it('a folder share carries the folder as both an asset ref and shared context', async () => {
    const ref = new TypeId('folder', FOLDER_ID).toString();
    const src = folderShareSource(new TypeId('folder', FOLDER_ID), { label: 'widgets' });
    const prepared = await src.prepare!({ recipientEmails: ['bob@example.test'] });
    expect(prepared.assetReferences).toEqual([ref]);
    expect(prepared.sharedContextEntities).toEqual([ref]);
  });

  it('a new conversation defaults Git sharing off', () => {
    expect(new Conversation().git_sharing_enabled).toBe(false);
    expect(new Conversation({ git_sharing_enabled: true }).git_sharing_enabled).toBe(true);
  });
});
