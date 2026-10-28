/**
 * Issues on the home: the chip counts OPEN issues split by severity and is shown only while one is
 * open; a subject page shows the open issues about it (its subject or one it stops), errors first.
 */
import type { Issue } from '@sdk';
import {
  countIssues,
  fixPointer,
  issuesConcerning,
  openIssues,
  showIssuesChip,
} from '@src/components/asset-counters/issue-counters';
import { describe, expect, it } from 'vitest';

const issue = (
  id: string,
  severity: 'error' | 'warning',
  status: 'open' | 'resolved' = 'open',
  subject = 'deployment-x',
  affected: string[] = [],
) => ({ id, severity, status, subject_typeid: subject, affected, fix: null }) as unknown as Issue;

describe('issue counters', () => {
  it('counts only open issues, by severity', () => {
    const issues = [issue('a', 'error'), issue('b', 'warning'), issue('c', 'warning'), issue('d', 'error', 'resolved')];
    expect(countIssues(issues)).toEqual({ open: 3, errors: 1, warnings: 2 });
    expect(openIssues(issues).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('hides the chip when nothing is open', () => {
    expect(showIssuesChip(countIssues([]))).toBe(false);
    expect(showIssuesChip(countIssues([issue('d', 'error', 'resolved')]))).toBe(false);
    expect(showIssuesChip(countIssues([issue('b', 'warning')]))).toBe(true);
  });

  it('finds the open issues about a subject or one it affects, errors first', () => {
    const issues = [
      issue('w', 'warning', 'open', 'deployment-1'),
      issue('e', 'error', 'open', 'llm_endpoint-9', ['deployment-1']),
      issue('r', 'error', 'resolved', 'deployment-1'),
      issue('o', 'error', 'open', 'deployment-2'),
    ];
    expect(issuesConcerning(issues, 'deployment-1').map((i) => i.id)).toEqual(['e', 'w']);
    expect(issuesConcerning(issues, 'deployment-3')).toEqual([]);
  });

  it('has no fix pointer without a fix', () => {
    expect(fixPointer(issue('a', 'error'))).toBeNull();
  });

  it('opens the entity the hub names by typeid (the budget to raise)', () => {
    const budget = 'llm_endpoint-21b20158-3832-4c0d-84e2-140e703e9b83';
    const live = { ...issue('b', 'error'), fix: { label: 'Raise the budget', pointer: budget } } as Issue;
    expect(fixPointer(live)?.toString()).toContain(budget);
  });

  it('opens a deployment where deployments live (the world view), not as a missing asset', () => {
    const dep = 'deployment-ac5708e1-d328-41a9-aecf-dd9f698716a1';
    const live = { ...issue('t', 'error'), fix: { label: 'Open the deployment', pointer: dep } } as Issue;
    const pointer = JSON.stringify(fixPointer(live));
    expect(pointer).toContain(dep);
    expect(pointer).not.toContain('editor/markdown');
  });
});
