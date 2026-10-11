// The UI actions the smart navigator can answer with: the backend's catalog names them, this
// side carries them out -- one handler per id, no more, no fewer.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { requestUiAction, UI_ACTIONS, useUiActionRequest } from '@src/navigation/ui-actions';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../../flow_sdk/core/ui_actions.json'), 'utf8')) as {
  actions: Record<string, string>;
};

function Host({ ids, onRun }: { ids: string[]; onRun: (id: string) => void }) {
  useUiActionRequest(ids, onRun);
  return null;
}

describe('UI actions', () => {
  it('every action the navigator can pick has a handler, and every handler is in the catalog', () => {
    expect(Object.keys(UI_ACTIONS).sort()).toEqual(Object.keys(catalog.actions).sort());
  });

  it('a request reaches a host that is already showing', () => {
    const onRun = vi.fn();
    render(<Host ids={['publish-dialog']} onRun={onRun} />);
    requestUiAction('publish-dialog');
    expect(onRun).toHaveBeenCalledWith('publish-dialog');
  });

  it('a request made before its screen opened is taken when the host mounts -- once', () => {
    requestUiAction('upload-flowmsg');
    const first = vi.fn();
    const second = vi.fn();
    render(<Host ids={['upload-flowmsg']} onRun={first} />);
    render(<Host ids={['upload-flowmsg']} onRun={second} />);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('a host only hears the actions it names', () => {
    const onRun = vi.fn();
    render(<Host ids={['settings-dialog']} onRun={onRun} />);
    requestUiAction('bookmarks-menu');
    expect(onRun).not.toHaveBeenCalled();
  });
});
