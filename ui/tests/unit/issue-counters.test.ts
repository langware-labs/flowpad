/**
 * Issues on the home: the chip counts OPEN issues split by severity and is shown only while one is
 * open; a subject page shows the open issues about it (its subject or one it stops), errors first.
 */
import { Deployment, ViewType, type Issue } from '@sdk';
import {
  countIssues,
  fixPointer,
  fixPointerFor,
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

  it("opens a project's deployment on its project's Deployments page, which the hub page can show", () => {
    const dep = 'deployment-ac5708e1-d328-41a9-aecf-dd9f698716a1';
    const live = { ...issue('t', 'error'), fix: { label: 'Edit settings', pointer: dep } } as Issue;
    const deployment = new Deployment({
      id: 'ac5708e1-d328-41a9-aecf-dd9f698716a1',
      name: 'invite',
      parent_type_id: 'project-0b7e6f1c-1d2e-4f3a-9b8c-7d6e5f4a3b2c',
      target: { provider: 'e2b', scope: 'project-0b7e6f1c-1d2e-4f3a-9b8c-7d6e5f4a3b2c' },
    } as never);
    const pointer = fixPointerFor(live, deployment)!;
    expect(pointer.viewType).toBe(ViewType.PROJECT);
    expect(pointer.pointer).toBe('0b7e6f1c-1d2e-4f3a-9b8c-7d6e5f4a3b2c/project-deployments');
    expect(pointer.options).toEqual({ deployment: 'ac5708e1-d328-41a9-aecf-dd9f698716a1' });
    expect(JSON.stringify(fixPointerFor(live, null))).toContain(dep); // no project: the world view
  });

  it("opens a project on the project's own page, not as a markdown asset", () => {
    const project = 'project-0b7e6f1c-1d2e-4f3a-9b8c-7d6e5f4a3b2c';
    const missing = { ...issue('c', 'warning'), fix: { label: 'Set credential', pointer: project } } as Issue;
    const pointer = fixPointer(missing)!;
    expect(pointer.viewType).toBe(ViewType.PROJECT);
    expect(JSON.stringify(pointer)).not.toContain('markdown');
  });
});
