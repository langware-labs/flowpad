import { appViewKey } from '@src/components/app-pool/app-view-key';
import { expect, it } from 'vitest';

const APP = 'service_endpoint-671e7350-2fe3-416f-b497-a1bfc494274a';

it('the same host, app and route name the same view', () => {
  expect(appViewKey('p1', APP, 'tasks-app')).toBe(appViewKey('p1', APP, 'tasks-app'));
});

it('two Vibe sessions showing one app get a view each', () => {
  expect(appViewKey('p1', APP, 'tasks-app')).not.toBe(appViewKey('p2', APP, 'tasks-app'));
  expect(appViewKey(null, APP, 'tasks-app')).not.toBe(appViewKey('p1', APP, 'tasks-app'));
});

it('another route or another app is another view', () => {
  expect(appViewKey('p1', APP, 'tasks-app')).not.toBe(appViewKey('p1', APP, 'admin'));
  expect(appViewKey('p1', APP, 'tasks-app')).not.toBe(appViewKey('p1', 'micro_app-1', 'tasks-app'));
});

it('no host and no route are one stable key', () => {
  expect(appViewKey(undefined, APP, undefined)).toBe(appViewKey(null, APP, null));
});
