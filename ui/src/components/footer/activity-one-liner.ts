/**
 * One line that says where a long job is — the footer's activity pill.
 *
 * `QA cycle · 1/2 · vitest API 2/3 › rca · 1 failed`: the root, how many of its steps
 * have ended, the step at work with its own count, the deepest thing running under it,
 * and the failures anywhere in the tree. A finished root reads as its receipt:
 * `QA cycle — 1 PASS · 1 RED`. Pure, so the exact wording is pinned by a unit test.
 */

import { deepestRunning, isTerminal, type ActivityProgressSpec } from '@sdk/activity';

const AT_WORK = new Set(['running', 'blocked', 'paused']);

function nameOf(spec: ActivityProgressSpec): string {
  return spec.label || spec.name;
}

function countOf(spec: ActivityProgressSpec): string {
  return spec.total == null ? spec.done.toLocaleString() : `${spec.done.toLocaleString()}/${spec.total.toLocaleString()}`;
}

/** Errors recorded anywhere under (and on) this node. */
export function errorsInTree(spec: ActivityProgressSpec): number {
  return spec.children.reduce((sum, child) => sum + errorsInTree(child), spec.errors_count);
}

function stepPart(step: ActivityProgressSpec): string {
  let text = nameOf(step);
  if (step.total != null || step.done > 0) text += ` ${countOf(step)}`;
  if (step.state === 'blocked') text += ' (blocked)';
  const deeper = deepestRunning(step);
  if (deeper && deeper !== step && deeper.path !== step.path) text += ` › ${nameOf(deeper)}`;
  return text;
}

export function activityOneLiner(spec: ActivityProgressSpec): string {
  const name = nameOf(spec);
  if (isTerminal(spec)) return `${name} — ${spec.message || spec.state}`;

  const parts = [name];
  if (spec.children.length > 0) {
    const ended = spec.children.filter(isTerminal).length;
    parts.push(`${ended}/${spec.children.length}`);
    const active = spec.children.find((c) => AT_WORK.has(c.state));
    if (active) parts.push(stepPart(active));
  } else {
    parts.push(countOf(spec));
    if (spec.current) parts.push(spec.current);
  }
  const errors = errorsInTree(spec);
  if (errors > 0) parts.push(`${errors} failed`);
  return parts.join(' · ');
}
