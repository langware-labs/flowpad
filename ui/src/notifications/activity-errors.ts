/**
 * A job that finished with errors hands them to the warnings list.
 *
 * The footer pill is for work in progress; once a root ends with errors, each error becomes
 * an entry of its own in the warnings popover — the file it is about and the message — where
 * the person can diagnose and fix it, and dismiss it when done.
 */

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { ActivityError, ActivityProgressSpec } from '@sdk/activity';
import { basename } from '@src/components/asset-manager/asset-row-helpers';
import { activityWord } from '@src/components/footer/activity-words';
import { notify } from './notify';

interface Located {
  step: ActivityProgressSpec;
  error: ActivityError;
}

function collect(spec: ActivityProgressSpec, out: Located[]): Located[] {
  for (const error of spec.errors) out.push({ step: spec, error });
  for (const child of spec.children) collect(child, out);
  return out;
}

/** Raise one warning-list entry per error the finished root carries. */
export function raiseActivityErrors(root: ActivityProgressSpec): void {
  const job = activityWord(root.label || root.name);
  for (const { step, error } of collect(root, [])) {
    const what = step === root ? '' : `${activityWord(step.label || step.name)} `;
    const subject = error.ref ? `${what}${basename(error.ref)}` : what.trim() || job;
    notify({
      id: `activity:${root.activity_id}:${step.path}:${error.ref ?? error.message}`,
      level: 'error',
      title: i18n._(msg`${job} failed: ${subject}`),
      message: error.message,
      durationMs: null,
    });
  }
}
