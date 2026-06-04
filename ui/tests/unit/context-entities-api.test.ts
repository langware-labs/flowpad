/**
 * Tests for the FE-side context_entities surface.
 *
 * Under the current architecture the FE is **display-only** for context.
 * The backend computes both buckets and ships them over the wire:
 *   * ``shared_context_entities`` — wire-bound shared bucket.
 *   * ``private_context_entities`` — backend-computed merged view
 *     (``Entity.get_implicit_private_context_entities`` + explicit
 *     attachments, deduped server-side).
 *
 * The FE has no mutation primitives, no projection logic. The getters
 * (``sharedContextEntities`` / ``privateContextEntities``) are identity
 * over the wire-deserialized arrays. These tests verify that surface.
 */

import { describe, expect, it } from 'vitest';
import { Conversation, Spec, Task, TypeId } from '@sdk';

// Reusable UUIDs (TypeId requires a valid identifier).
const SPEC_ID = '11111111-aaaa-4bbb-9ccc-000000000001';
const CONV_ID = '22222222-aaaa-4bbb-9ccc-000000000010';
const TASK_ID = '33333333-aaaa-4bbb-9ccc-000000000020';
const PROJ_ID = '44444444-aaaa-4bbb-9ccc-000000000030';

const containsTypeId = (haystack: TypeId[], needle: TypeId): boolean =>
  haystack.some((t) => t.equals(needle));

describe('context_entities entity API (display-only)', () => {
  it('defaults to empty arrays when wire payload omits both buckets', () => {
    const task = new Task({ title: 't' });
    expect(task.sharedContextEntities).toEqual([]);
    expect(task.privateContextEntities).toEqual([]);
  });

  it('deserializes shared_context_entities from the wire as TypeIds', () => {
    const task = new Task({
      title: 't',
      shared_context_entities: [`spec-${SPEC_ID}`, `conversation-${CONV_ID}`],
    } as Partial<Task>);
    expect(task.sharedContextEntities).toHaveLength(2);
    expect(containsTypeId(task.sharedContextEntities, new TypeId('spec', SPEC_ID))).toBe(true);
    expect(containsTypeId(task.sharedContextEntities, new TypeId('conversation', CONV_ID))).toBe(true);
    // Private remains empty — the wire didn't ship a private bucket.
    expect(task.privateContextEntities).toEqual([]);
  });

  it('deserializes private_context_entities (backend-computed) from the wire as TypeIds', () => {
    // The backend's ``private_context_entities`` computed_field already
    // merged implicit (project_id) + explicit and deduped. The FE just
    // reads it as-is — no projection happens here.
    const task = new Task({
      title: 't',
      project_id: PROJ_ID,
      private_context_entities: [`project-${PROJ_ID}`, `spec-${SPEC_ID}`],
    } as Partial<Task>);
    expect(task.privateContextEntities).toHaveLength(2);
    expect(containsTypeId(task.privateContextEntities, new TypeId('project', PROJ_ID))).toBe(true);
    expect(containsTypeId(task.privateContextEntities, new TypeId('spec', SPEC_ID))).toBe(true);
  });

  it('the two buckets stay independent', () => {
    const task = new Task({
      title: 't',
      shared_context_entities: [`spec-${SPEC_ID}`],
      private_context_entities: [`project-${PROJ_ID}`],
    } as Partial<Task>);
    expect(containsTypeId(task.sharedContextEntities, new TypeId('spec', SPEC_ID))).toBe(true);
    expect(containsTypeId(task.sharedContextEntities, new TypeId('project', PROJ_ID))).toBe(false);
    expect(containsTypeId(task.privateContextEntities, new TypeId('project', PROJ_ID))).toBe(true);
    expect(containsTypeId(task.privateContextEntities, new TypeId('spec', SPEC_ID))).toBe(false);
  });

  it('Spec / Conversation read the same wire-deserialized buckets', () => {
    const spec = new Spec({
      title: 's',
      shared_context_entities: [`task-${TASK_ID}`],
      private_context_entities: [`project-${PROJ_ID}`],
    } as Partial<Spec>);
    expect(containsTypeId(spec.sharedContextEntities, new TypeId('task', TASK_ID))).toBe(true);
    expect(containsTypeId(spec.privateContextEntities, new TypeId('project', PROJ_ID))).toBe(true);

    const conv = new Conversation({
      project_id: PROJ_ID,
      private_context_entities: [`project-${PROJ_ID}`],
    } as Partial<Conversation>);
    expect(containsTypeId(conv.privateContextEntities, new TypeId('project', PROJ_ID))).toBe(true);
  });

  describe('per-entry sidecar data (getContextEntryData)', () => {
    const PLAN_ID = '55555555-aaaa-4bbb-9ccc-000000000099';
    const planTypeIdString = `plan-${PLAN_ID}`;
    const planTypeId = new TypeId('plan', PLAN_ID);
    const planPath = '/Users/shlom/.claude/plans/some-plan.md';

    it('returns undefined when no data was harvested for the typeid', () => {
      const task = new Task({
        title: 't',
        private_context_entities: [planTypeIdString],
      } as Partial<Task>);
      expect(task.getContextEntryData(planTypeId)).toBeUndefined();
    });

    it('deserializes shared_context_entity_data from the wire and looks up by TypeId', () => {
      const task = new Task({
        title: 't',
        shared_context_entities: [planTypeIdString],
        shared_context_entity_data: { [planTypeIdString]: { path: planPath } },
      } as Partial<Task>);
      expect(task.getContextEntryData(planTypeId)).toEqual({ path: planPath });
      // String form also works (matches how chip code constructs the key).
      expect(task.getContextEntryData(planTypeIdString)).toEqual({ path: planPath });
    });

    it('private sidecar wins on collision (matches backend precedence)', () => {
      const task = new Task({
        title: 't',
        shared_context_entities: [planTypeIdString],
        private_context_entities: [planTypeIdString],
        shared_context_entity_data: { [planTypeIdString]: { path: '/shared/path.md' } },
        private_context_entity_data: { [planTypeIdString]: { path: '/private/path.md' } },
      } as Partial<Task>);
      expect(task.getContextEntryData(planTypeId)).toEqual({ path: '/private/path.md' });
    });

    it('toJSON emits shared sidecar only — private sidecar stays local', () => {
      const task = new Task({
        title: 't',
        shared_context_entities: [planTypeIdString],
        private_context_entities: [planTypeIdString],
        shared_context_entity_data: { [planTypeIdString]: { path: planPath } },
        private_context_entity_data: { [planTypeIdString]: { path: '/private/only.md' } },
      } as Partial<Task>);
      const json = task.toJSON();
      expect(json.shared_context_entity_data).toEqual({
        [planTypeIdString]: { path: planPath },
      });
      // private_context_entity_data must NOT appear on the wire — matches the
      // BE share() exclusion of the same field.
      expect(json.private_context_entity_data).toBeUndefined();
    });
  });

  it('contextOfType(type, bucket?) filters by bucket', () => {
    const task = new Task({
      title: 't',
      shared_context_entities: [`spec-${SPEC_ID}`],
      private_context_entities: [`project-${PROJ_ID}`],
    } as Partial<Task>);
    expect(task.contextOfType('spec', 'shared').map((t) => t.id)).toEqual([SPEC_ID]);
    expect(task.contextOfType('project', 'private').map((t) => t.id)).toEqual([PROJ_ID]);
    expect(task.contextOfType('spec', 'private')).toEqual([]);
    // Default 'both' walks shared first, then private.
    expect(task.contextOfType('project').map((t) => t.id)).toEqual([PROJ_ID]);
  });

  it('toJSON emits shared_context_entities only — private stays display-side', () => {
    const task = new Task({
      title: 't',
      shared_context_entities: [`spec-${SPEC_ID}`],
      private_context_entities: [`project-${PROJ_ID}`],
    } as Partial<Task>);
    const json = task.toJSON();
    expect(json.shared_context_entities).toEqual([`spec-${SPEC_ID}`]);
    // Private is server-computed; the FE doesn't round-trip it on save.
    expect(json.private_context_entities).toBeUndefined();
  });
});
