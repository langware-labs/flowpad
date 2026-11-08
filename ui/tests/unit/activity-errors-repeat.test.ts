import { expect, it } from 'vitest';
import type { ActivityProgressSpec } from '@sdk/activity';
import { raiseActivityErrors } from '@src/notifications/activity-errors';
import { useAlertStore } from '@src/notifications';

const run = (activityId: string) =>
  ({
    activity_id: activityId, name: 'index', label: 'Indexing', path: '', errors: [],
    children: [{ activity_id: activityId, name: 'chart', label: 'chart', path: 'chart', children: [],
      errors: [{ ref: '/docs/network/spora-token-refresh', message: 'did not find expected key' }] }],
  }) as unknown as ActivityProgressSpec;

it('the same failure from the next run counts up on its entry instead of adding a copy', () => {
  raiseActivityErrors(run('run-1'));
  raiseActivityErrors(run('run-2'));
  const alerts = useAlertStore.getState().alerts;
  expect(alerts).toHaveLength(1);
  expect(alerts[0].count).toBe(2);
});
