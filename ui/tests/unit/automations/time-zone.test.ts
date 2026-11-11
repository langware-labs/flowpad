/** A zone in words, and where a callback's chip leads. */
import { describe, expect, it } from 'vitest';
import { zoneLabel, zoneOffset } from '@src/components/automations/time-zone';
import { buildDockPointer } from '@src/navigation/entity-pointer';

describe('time zone words', () => {
  it('names a zone by its city and offset', () => {
    expect(zoneLabel('America/New_York')).toMatch(/^New York · UTC−[45]$/);
    expect(zoneOffset('UTC')).toBe('UTC');
    expect(zoneOffset('Not/AZone')).toBe('');
  });
});

describe('a trigger chip', () => {
  it('opens its automation page, not a view that does not exist', () => {
    const pointer = buildDockPointer({ type: 'trigger', id: 'a1' }, undefined);
    expect(pointer?.viewType).toBe('automations');
    expect(pointer?.options?.trigger).toBe('a1');
  });
});
