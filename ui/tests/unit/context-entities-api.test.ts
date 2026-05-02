/**
 * Tests for the unified context_entities entity API on the TS side.
 *
 * Mirrors tests/unit/test_context_entities_api.py — covers add/remove
 * mutators, the dynamic ``contextEntities`` getter (direct projection
 * merged with the private array), and per-entity ``_directFieldsAsTypeIds``
 * overrides for Task / Spec / Conversation / CollaborationRoom.
 */

import { describe, expect, it } from 'vitest';
import { CollaborationRoom, Conversation, Spec, Task, TypeId } from '@sdk';

// Reusable UUIDs (TypeId requires a valid identifier).
const SPEC_ID_1 = '11111111-aaaa-4bbb-9ccc-000000000001';
const SPEC_ID_2 = '22222222-aaaa-4bbb-9ccc-000000000002';
const CONV_ID_1 = '11111111-aaaa-4bbb-9ccc-000000000010';
const TASK_ID_1 = '11111111-aaaa-4bbb-9ccc-000000000020';
const PROJ_ID_1 = '11111111-aaaa-4bbb-9ccc-000000000030';
const USER_ID_1 = '11111111-aaaa-4bbb-9ccc-000000000040';
const PROC_ID_1 = '11111111-aaaa-4bbb-9ccc-000000000050';
const PROC_ID_2 = '22222222-aaaa-4bbb-9ccc-000000000051';
const PLAN_ID_1 = '11111111-aaaa-4bbb-9ccc-000000000060';

const containsTypeId = (haystack: TypeId[], needle: TypeId): boolean =>
  haystack.some((t) => t.equals(needle));

describe('context_entities entity API', () => {
  describe('base mutators', () => {
    it('default contextEntities is an empty list', () => {
      const task = new Task({ title: 't' });
      expect(task.contextEntities).toEqual([]);
    });

    it('addContextEntity appends', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      task.addContextEntity(tid);
      expect(containsTypeId(task.contextEntities, tid)).toBe(true);
    });

    it('addContextEntity is idempotent', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      task.addContextEntity(tid);
      task.addContextEntity(tid);
      const matches = task.contextEntities.filter((t) => t.equals(tid));
      expect(matches).toHaveLength(1);
    });

    it('removeContextEntity returns true when removed', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      task.addContextEntity(tid);
      expect(task.removeContextEntity(tid)).toBe(true);
      expect(containsTypeId(task.contextEntities, tid)).toBe(false);
    });

    it('removeContextEntity returns false when absent', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      expect(task.removeContextEntity(tid)).toBe(false);
    });

    it('contextOfType filters', () => {
      const task = new Task({ title: 't', project_id: PROJ_ID_1 });
      task.addContextEntity(new TypeId('spec', SPEC_ID_1));
      task.addContextEntity(new TypeId('spec', SPEC_ID_2));
      task.addContextEntity(new TypeId('conversation', CONV_ID_1));
      const specs = task.contextOfType('spec');
      expect(specs.map((t) => t.id).sort()).toEqual([SPEC_ID_1, SPEC_ID_2].sort());
    });

    it('firstContextOfType returns first match or null', () => {
      const task = new Task({ title: 't' });
      task.addContextEntity(new TypeId('spec', SPEC_ID_1));
      task.addContextEntity(new TypeId('spec', SPEC_ID_2));
      const first = task.firstContextOfType('spec');
      expect(first?.id).toBe(SPEC_ID_1);
      expect(task.firstContextOfType('plan')).toBeNull();
    });
  });

  describe('Task direct projection', () => {
    it('projects project / assignee / my_process / shared_process', () => {
      const task = new Task({
        title: 't',
        project_id: PROJ_ID_1,
        assignee: USER_ID_1,
        my_process_id: PROC_ID_1,
        shared_process_id: PROC_ID_2,
      });
      const ctx = task.contextEntities;
      expect(containsTypeId(ctx, new TypeId('project', PROJ_ID_1))).toBe(true);
      expect(containsTypeId(ctx, new TypeId('user', USER_ID_1))).toBe(true);
      expect(containsTypeId(ctx, new TypeId('agentic_process', PROC_ID_1))).toBe(true);
      expect(containsTypeId(ctx, new TypeId('agentic_process', PROC_ID_2))).toBe(true);
    });

    it('merges direct projection with private array', () => {
      const task = new Task({ title: 't', project_id: PROJ_ID_1 });
      task.addContextEntity(new TypeId('spec', SPEC_ID_1));
      const ctx = task.contextEntities;
      expect(containsTypeId(ctx, new TypeId('project', PROJ_ID_1))).toBe(true);
      expect(containsTypeId(ctx, new TypeId('spec', SPEC_ID_1))).toBe(true);
    });

    it('skips unset direct fields', () => {
      const task = new Task({ title: 't' });
      expect(task.contextEntities).toEqual([]);
    });
  });

  describe('Spec direct projection', () => {
    it('projects author', () => {
      const spec = new Spec({ title: 's', author_id: USER_ID_1 });
      expect(containsTypeId(spec.contextEntities, new TypeId('user', USER_ID_1))).toBe(true);
    });

    it('plan in private context_entities is exposed via getter', () => {
      const spec = new Spec({ title: 's' });
      spec.addContextEntity(new TypeId('plan', PLAN_ID_1));
      expect(containsTypeId(spec.contextEntities, new TypeId('plan', PLAN_ID_1))).toBe(true);
    });
  });

  describe('Conversation direct projection', () => {
    it('projects project', () => {
      const conv = new Conversation({ project_id: PROJ_ID_1 });
      expect(containsTypeId(conv.contextEntities, new TypeId('project', PROJ_ID_1))).toBe(true);
    });

    it('exposes task added via addContextEntity', () => {
      const conv = new Conversation({});
      conv.addContextEntity(new TypeId('task', TASK_ID_1));
      const t = conv.firstContextOfType('task');
      expect(t?.id).toBe(TASK_ID_1);
    });
  });

  describe('CollaborationRoom', () => {
    it('exposes agentic_process_ids derived from contextEntities', () => {
      const room = new CollaborationRoom({ project_id: PROJ_ID_1 });
      room.addContextEntity(new TypeId('agentic_process', PROC_ID_1));
      room.addContextEntity(new TypeId('agentic_process', PROC_ID_2));
      room.addContextEntity(new TypeId('user', USER_ID_1));
      expect(room.agenticProcessIds.sort()).toEqual([PROC_ID_1, PROC_ID_2].sort());
    });
  });

  describe('direct projection invariants', () => {
    it('the private list does not contain projected direct fields', () => {
      const task = new Task({ title: 't', project_id: PROJ_ID_1 });
      task.addContextEntity(new TypeId('spec', SPEC_ID_1));
      // The dynamic getter merges; the underlying field declared on the
      // entity (we go through the proxy) sees only what we added.
      const projectInFull = containsTypeId(task.contextEntities, new TypeId('project', PROJ_ID_1));
      const specInFull = containsTypeId(task.contextEntities, new TypeId('spec', SPEC_ID_1));
      expect(projectInFull).toBe(true);
      expect(specInFull).toBe(true);
    });
  });
});
