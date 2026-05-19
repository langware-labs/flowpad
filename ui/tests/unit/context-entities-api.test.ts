/**
 * Tests for the split context_entities entity API on the TS side.
 *
 * Mirrors tests/unit/test_context_entities_api.py.
 *
 * Covers:
 *  - Two persisted buckets: ``sharedContextEntities`` (wire-bound) and
 *    ``privateContextEntities`` (local-only, with direct-field projection).
 *  - ``addContextEntities`` / ``removeContextEntities`` write to *private*
 *    only — the frontend has no method to mutate shared (that's a backend
 *    publish action). Both accept a single TypeId or an array.
 *  - ``contextOfType`` / ``firstContextOfType`` accept a bucket selector.
 *  - Per-entity ``_directFieldsAsTypeIds`` overrides for Task / Spec /
 *    Conversation / CollaborationRoom still feed only the private view.
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

describe('context_entities entity API (split)', () => {
  describe('defaults', () => {
    it('sharedContextEntities and privateContextEntities default empty', () => {
      const task = new Task({ title: 't' });
      expect(task.sharedContextEntities).toEqual([]);
      expect(task.privateContextEntities).toEqual([]);
    });
  });

  describe('addContextEntities (writes to private)', () => {
    it('accepts a single TypeId', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      const added = task.addContextEntities(tid);
      expect(added).toBe(1);
      expect(containsTypeId(task.privateContextEntities, tid)).toBe(true);
      // Shared bucket is unaffected by FE writes.
      expect(task.sharedContextEntities).toEqual([]);
    });

    it('accepts an array', () => {
      const task = new Task({ title: 't' });
      const ids = [new TypeId('spec', SPEC_ID_1), new TypeId('spec', SPEC_ID_2)];
      const added = task.addContextEntities(ids);
      expect(added).toBe(2);
      expect(containsTypeId(task.privateContextEntities, ids[0])).toBe(true);
      expect(containsTypeId(task.privateContextEntities, ids[1])).toBe(true);
    });

    it('is idempotent — re-add returns 0', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      task.addContextEntities(tid);
      const added = task.addContextEntities(tid);
      expect(added).toBe(0);
    });

    it('partial dedup on a mixed batch', () => {
      const task = new Task({ title: 't' });
      const a = new TypeId('spec', SPEC_ID_1);
      const b = new TypeId('spec', SPEC_ID_2);
      task.addContextEntities(a);
      const added = task.addContextEntities([a, b]); // a is dup, b is new
      expect(added).toBe(1);
    });
  });

  describe('removeContextEntities (removes from private)', () => {
    it('removes a single TypeId', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      task.addContextEntities(tid);
      const removed = task.removeContextEntities(tid);
      expect(removed).toBe(1);
      expect(containsTypeId(task.privateContextEntities, tid)).toBe(false);
    });

    it('removes a batch', () => {
      const task = new Task({ title: 't' });
      const a = new TypeId('spec', SPEC_ID_1);
      const b = new TypeId('spec', SPEC_ID_2);
      const c = new TypeId('conversation', CONV_ID_1);
      task.addContextEntities([a, b, c]);
      const removed = task.removeContextEntities([a, c]);
      expect(removed).toBe(2);
      expect(task.privateContextEntities.map((t) => t.id)).toEqual([SPEC_ID_2]);
    });

    it('returns 0 when absent', () => {
      const task = new Task({ title: 't' });
      const tid = new TypeId('spec', SPEC_ID_1);
      expect(task.removeContextEntities(tid)).toBe(0);
    });
  });

  describe('contextOfType / firstContextOfType with bucket selector', () => {
    it('default "both" walks shared first then private', () => {
      const task = new Task({ title: 't' });
      // simulate wire-bound shared by constructing with the wire field
      const wireTask = new Task({ title: 't', shared_context_entities: [`spec-${SPEC_ID_1}`] } as any);
      wireTask.addContextEntities(new TypeId('spec', SPEC_ID_2));
      const specs = wireTask.contextOfType('spec');
      expect(specs.map((t) => t.id)).toEqual([SPEC_ID_1, SPEC_ID_2]);
      expect(wireTask.firstContextOfType('spec')?.id).toBe(SPEC_ID_1);
    });

    it('bucket=private filters to private only', () => {
      const wireTask = new Task({ title: 't', shared_context_entities: [`spec-${SPEC_ID_1}`] } as any);
      wireTask.addContextEntities(new TypeId('spec', SPEC_ID_2));
      const specs = wireTask.contextOfType('spec', 'private');
      expect(specs.map((t) => t.id)).toEqual([SPEC_ID_2]);
    });

    it('bucket=shared filters to shared only', () => {
      const wireTask = new Task({ title: 't', shared_context_entities: [`spec-${SPEC_ID_1}`] } as any);
      wireTask.addContextEntities(new TypeId('spec', SPEC_ID_2));
      const specs = wireTask.contextOfType('spec', 'shared');
      expect(specs.map((t) => t.id)).toEqual([SPEC_ID_1]);
    });
  });

  describe('Task direct-field projection lands in private', () => {
    it('projects project / assignee / my_process / shared_process into private', () => {
      const task = new Task({
        title: 't',
        project_id: PROJ_ID_1,
        assignee: USER_ID_1,
        my_process_id: PROC_ID_1,
        shared_process_id: PROC_ID_2,
      });
      const priv = task.privateContextEntities;
      expect(containsTypeId(priv, new TypeId('project', PROJ_ID_1))).toBe(true);
      expect(containsTypeId(priv, new TypeId('user', USER_ID_1))).toBe(true);
      expect(containsTypeId(priv, new TypeId('agentic_process', PROC_ID_1))).toBe(true);
      expect(containsTypeId(priv, new TypeId('agentic_process', PROC_ID_2))).toBe(true);
      // None of these leak into shared.
      expect(task.sharedContextEntities).toEqual([]);
    });

    it('merges direct projection with locally-added entries', () => {
      const task = new Task({ title: 't', project_id: PROJ_ID_1 });
      task.addContextEntities(new TypeId('spec', SPEC_ID_1));
      const priv = task.privateContextEntities;
      expect(containsTypeId(priv, new TypeId('project', PROJ_ID_1))).toBe(true);
      expect(containsTypeId(priv, new TypeId('spec', SPEC_ID_1))).toBe(true);
    });

    it('skips unset direct fields', () => {
      const task = new Task({ title: 't' });
      expect(task.privateContextEntities).toEqual([]);
    });
  });

  describe('Spec direct projection', () => {
    it('projects author into private', () => {
      const spec = new Spec({ title: 's', author_id: USER_ID_1 });
      expect(containsTypeId(spec.privateContextEntities, new TypeId('user', USER_ID_1))).toBe(true);
    });

    it('locally-added plan TypeId surfaces in privateContextEntities', () => {
      const spec = new Spec({ title: 's' });
      spec.addContextEntities(new TypeId('plan', PLAN_ID_1));
      expect(containsTypeId(spec.privateContextEntities, new TypeId('plan', PLAN_ID_1))).toBe(true);
    });
  });

  describe('Conversation direct projection', () => {
    it('projects project into private', () => {
      const conv = new Conversation({ project_id: PROJ_ID_1 });
      expect(containsTypeId(conv.privateContextEntities, new TypeId('project', PROJ_ID_1))).toBe(true);
    });

    it('wire-deserialized task TypeId lands in sharedContextEntities', () => {
      const conv = new Conversation({ shared_context_entities: [`task-${TASK_ID_1}`] } as any);
      const t = conv.firstContextOfType('task', 'shared');
      expect(t?.id).toBe(TASK_ID_1);
    });
  });

  describe('CollaborationRoom (room membership = shared)', () => {
    it('agenticProcessIds reads from sharedContextEntities', () => {
      const room = new CollaborationRoom({
        project_id: PROJ_ID_1,
        shared_context_entities: [
          `agentic_process-${PROC_ID_1}`,
          `agentic_process-${PROC_ID_2}`,
          `user-${USER_ID_1}`, // unrelated, must be ignored by the derived prop
        ],
      } as any);
      expect(room.agenticProcessIds.sort()).toEqual([PROC_ID_1, PROC_ID_2].sort());
    });
  });

  describe('wire serialization', () => {
    it('toJSON emits shared_context_entities only — private stays local', () => {
      const task = new Task({ title: 't', project_id: PROJ_ID_1 });
      task.addContextEntities(new TypeId('spec', SPEC_ID_1));
      // Manually seed shared via the wire path to mimic deserialization.
      const wireTask = new Task({
        title: 't',
        project_id: PROJ_ID_1,
        shared_context_entities: [`spec-${SPEC_ID_2}`],
      } as any);
      wireTask.addContextEntities(new TypeId('spec', SPEC_ID_1));
      const json = wireTask.toJSON();
      expect(json.shared_context_entities).toEqual([`spec-${SPEC_ID_2}`]);
      // Private never on the wire — no key, no values.
      expect(json.private_context_entities_).toBeUndefined();
      expect(JSON.stringify(json)).not.toContain(SPEC_ID_1);
    });
  });
});
