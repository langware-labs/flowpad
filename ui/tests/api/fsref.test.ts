/**
 * FSRef API tests — via compute node fs action over HTTP.
 *
 * DoF matrix: Ref type (dir, file-direct, file-nested) x State (new, partial, full) x Op (exists, read, write, ls, delete)
 * Direct disk validation uses independent fsManager calls (not the FSRef under test).
 */

import { ComputeNode, TypeId, fsManager, apiClient, GRAPH_API_PREFIX } from '@sdk';
import { Skill } from '@sdk/entities/skill';
import { FSRef } from '@sdk/fs/FSRef';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const COMPUTE_NODE_TYPEID = new TypeId('compute_node', '@local');

describe('FSRef', () => {
  const signupInfo = getTestSignupInfo();
  let basePath: string;

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
    basePath = `/tmp/flow-test-fsref-${Date.now()}`;
  });

  afterEach(async () => {
    try {
      await fsManager.delete(COMPUTE_NODE_TYPEID, basePath);
    } catch {
      // dir may not exist — ignore
    }
  });

  // -------------------------------------------------------------------------
  // Dir ref
  // -------------------------------------------------------------------------

  describe('dir ref', () => {
    it('exists() → false when dir missing (new state)', async () => {
      const ref = new FSRef(basePath, COMPUTE_NODE_TYPEID);
      expect(await ref.exists()).toBe(false);
    });

    it('exists() → true after mkdir', async () => {
      await fsManager.mkdir(COMPUTE_NODE_TYPEID, basePath);
      const ref = new FSRef(basePath, COMPUTE_NODE_TYPEID);
      expect(await ref.exists()).toBe(true);
    });

    it('ls() → empty when dir missing (new state)', async () => {
      const ref = new FSRef(basePath, COMPUTE_NODE_TYPEID);
      const items = await ref.ls();
      expect(items).toHaveLength(0);
    });

    it('ls() → includes child after write', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await ref.write('# content');
      const dirRef = new FSRef(basePath, COMPUTE_NODE_TYPEID);
      const items = await dirRef.ls();
      expect(items.some(r => r.path.endsWith('SKILL.md'))).toBe(true);
    });

    it('delete() on missing dir is noop', async () => {
      const ref = new FSRef(basePath, COMPUTE_NODE_TYPEID);
      await ref.delete();
      expect(await ref.exists()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // File ref — new state (dir missing, file missing)
  // -------------------------------------------------------------------------

  describe('file ref — new state', () => {
    it('exists() → false', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      expect(await ref.exists()).toBe(false);
    });

    it('read() throws', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await expect(ref.read()).rejects.toThrow();
    });

    it('write() creates dir and file — validated via independent read', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await ref.write('# hello');
      // Direct disk validation via independent fsManager call
      const content = await fsManager.download(COMPUTE_NODE_TYPEID, `${basePath}/SKILL.md`);
      expect(content).toBe('# hello');
    });

    it('delete() on missing file is noop', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await ref.delete();
      expect(await ref.exists()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // File ref — partial state (dir exists, file missing)
  // -------------------------------------------------------------------------

  describe('file ref — partial state', () => {
    beforeEach(async () => {
      await fsManager.mkdir(COMPUTE_NODE_TYPEID, basePath);
    });

    it('exists() → false', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      expect(await ref.exists()).toBe(false);
    });

    it('read() throws', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await expect(ref.read()).rejects.toThrow();
    });

    it('write() creates file in existing dir — validated via independent read', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await ref.write('# partial');
      const content = await fsManager.download(COMPUTE_NODE_TYPEID, `${basePath}/SKILL.md`);
      expect(content).toBe('# partial');
    });

    it('delete() on missing file is noop', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await ref.delete();
      expect(await ref.exists()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // File ref — full state (dir exists, file exists)
  // -------------------------------------------------------------------------

  describe('file ref — full state', () => {
    beforeEach(async () => {
      await fsManager.writeFile(COMPUTE_NODE_TYPEID, `${basePath}/SKILL.md`, '# original');
    });

    it('exists() → true', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      expect(await ref.exists()).toBe(true);
    });

    it('read() returns content', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      expect(await ref.read()).toBe('# original');
    });

    it('write() overwrites — validated via independent read', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await ref.write('# updated');
      const content = await fsManager.download(COMPUTE_NODE_TYPEID, `${basePath}/SKILL.md`);
      expect(content).toBe('# updated');
    });

    it('delete() removes file — validated via exists()', async () => {
      const ref = new FSRef(`${basePath}/SKILL.md`, COMPUTE_NODE_TYPEID);
      await ref.delete();
      expect(await ref.exists()).toBe(false);
      // Direct validation: parent dir should still exist
      const dir = await fsManager.listDirectory(COMPUTE_NODE_TYPEID, basePath);
      expect(dir.items.some(i => i.name.endsWith('SKILL.md'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Nested file ref
  // -------------------------------------------------------------------------

  describe('nested file ref', () => {
    it('write() creates intermediate dirs — validated via independent read', async () => {
      const ref = new FSRef(`${basePath}/data/notes.md`, COMPUTE_NODE_TYPEID);
      await ref.write('nested');
      const content = await fsManager.download(COMPUTE_NODE_TYPEID, `${basePath}/data/notes.md`);
      expect(content).toBe('nested');
      // Validate intermediate dir exists
      const dir = await fsManager.listDirectory(COMPUTE_NODE_TYPEID, `${basePath}/data`);
      expect(dir.items.some(i => i.name.endsWith('notes.md'))).toBe(true);
    });

    it('delete() leaves parent dir intact', async () => {
      const ref = new FSRef(`${basePath}/data/notes.md`, COMPUTE_NODE_TYPEID);
      await ref.write('content');
      await ref.delete();
      // file gone
      expect(await ref.exists()).toBe(false);
      // parent dir survives
      const dir = await fsManager.listDirectory(COMPUTE_NODE_TYPEID, `${basePath}/data`);
      expect(dir).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Record refs
// ---------------------------------------------------------------------------

describe('entity.record()', () => {
  const signupInfo = getTestSignupInfo();
  // Skill ID obtained from a discovered skill — stable across test runs.
  let skillId: string | null = null;

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
    if (!skillId) {
      // Pick the first discovered skill ID from scan
      const res = await apiClient.get<unknown>(
        `${GRAPH_API_PREFIX}/compute_node/@local/fs-records/scan?type=skill`,
      );
      const data = ((res as any)?.data ?? res) as Record<string, unknown>;
      const records = (data.records as Array<{ id: string }>) ?? [];
      skillId = records[0]?.id ?? null;
    }
  });

  it('skill.record() returns non-null recordFolderRef and mainRef', async () => {
    if (!skillId) { return; } // skip if no skills on this machine
    const skill = new Skill({ id: skillId });
    const rec = await skill.record();
    expect(rec.recordFolderRef).not.toBeNull();
    expect(rec.mainRef).not.toBeNull();
  });

  it('record.mainRef has correct refType', async () => {
    if (!skillId) { return; }
    const skill = new Skill({ id: skillId });
    const rec = await skill.record();
    expect(rec.mainRef).not.toBeNull();
    expect(['json', 'file', 'text', 'folder', 'frontmatter_md']).toContain(rec.mainRef!.refType);
  });

  it('record.recordFolderRef is a folder type', async () => {
    if (!skillId) { return; }
    const skill = new Skill({ id: skillId });
    const rec = await skill.record();
    if (rec.recordFolderRef) {
      expect(rec.recordFolderRef.refType).toBe('folder');
    }
  });

  it('record.mainRef supports child chaining', async () => {
    if (!skillId) { return; }
    const skill = new Skill({ id: skillId });
    const rec = await skill.record();
    expect(rec.mainRef).not.toBeNull();
    const childRef = rec.mainRef!.child('some-nested-file.txt');
    expect(childRef).toBeInstanceOf(FSRef);
    expect(childRef.path).toContain('some-nested-file.txt');
  });

  it('FSRef.fromJson roundtrip preserves fields', () => {
    const json = {
      path: '/tmp/test-skill',
      ref_type: 'json' as const,
      read_only: false,
      type_id: 'compute_node-@local',
    };
    const ref = FSRef.fromJson(json);
    expect(ref.path).toBe(json.path);
    expect(ref.refType).toBe('json');
    expect(ref.readOnly).toBe(false);
    const back = ref.toJSON();
    expect(back.ref_type).toBe('json');
    expect(back.type_id).toBe('compute_node-@local');
  });

  it('child chaining from python-serialized ref reads real content', async () => {
    // Python serializes mainRef → HTTP → TS reconstructs → child() chain → read real file
    const testDir = `/tmp/flow-test-record-child-${Date.now()}`;
    const nestedPath = `${testDir}/level1/level2/data.txt`;

    try {
      await fsManager.writeFile(COMPUTE_NODE_TYPEID, nestedPath, 'hello-from-child-chain');

      const baseRef = FSRef.fromJson({
        path: testDir,
        ref_type: 'folder',
        read_only: false,
        type_id: `compute_node-@local`,
      });

      const content = await baseRef.child('level1').child('level2').child('data.txt').read();
      expect(content).toBe('hello-from-child-chain');
    } finally {
      await fsManager.delete(COMPUTE_NODE_TYPEID, testDir).catch(() => {});
    }
  });
});
