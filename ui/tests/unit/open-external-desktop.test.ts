// What a guest app's `openExternal` becomes in the host: the desktop app hands the address to the
// shell (the Electron bridge), a browser tab opens it itself. Same message, same guard, both builds.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPEN_EXTERNAL_MESSAGE } from '@sdk/apps/host';
import { openExternal } from '@src/lib/open-external';
import { guestExternalUrl } from '@src/pages/flow-page/app-display-viewer';

const CRM = 'https://crm.example.com/object/person/42';

/** The host's handling of one guest message (`AppDisplayViewer`'s listener, without the frame). */
function host(data: unknown): void {
  const outside = guestExternalUrl(data);
  if (outside) openExternal(outside);
}

describe('an outside link asked by a guest app', () => {
  afterEach(() => {
    delete (window as any).electronAPI;
    vi.restoreAllMocks();
  });

  it('goes through the Electron bridge in the desktop app, never a window of the shell', () => {
    const bridge = vi.fn().mockResolvedValue(true);
    (window as any).electronAPI = { openExternal: bridge };
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);

    host({ type: OPEN_EXTERNAL_MESSAGE, url: CRM });

    expect(bridge).toHaveBeenCalledWith(CRM);
    expect(opened).not.toHaveBeenCalled();
  });

  it('opens a new tab in the browser build', () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);

    host({ type: OPEN_EXTERNAL_MESSAGE, url: CRM });

    expect(opened).toHaveBeenCalledWith(CRM, '_blank', 'noopener,noreferrer');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', '/dock/home', ''])('never reaches the bridge with %s', (url) => {
    const bridge = vi.fn();
    (window as any).electronAPI = { openExternal: bridge };

    host({ type: OPEN_EXTERNAL_MESSAGE, url });

    expect(bridge).not.toHaveBeenCalled();
  });
});
