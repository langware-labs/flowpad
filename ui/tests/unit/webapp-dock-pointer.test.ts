import { describe, expect, it } from 'vitest';
import { ViewType, WebApp } from '@sdk';

// `flow navigate entity micro_app-<id>` sends the tab to the entity's dockPointer;
// the generic Home view left the person on the home screen instead of the app.
describe('WebApp.dockPointer', () => {
  it('opens the running app', () => {
    const app = new WebApp({ id: '8a51e98b-ed4d-49dc-ab46-a46d4a262e15', type: 'micro_app' });
    expect(app.dockPointer.viewType).toBe(ViewType.APP);
    expect(app.dockPointer.pointer).toBe('micro_app-8a51e98b-ed4d-49dc-ab46-a46d4a262e15');
  });
});
