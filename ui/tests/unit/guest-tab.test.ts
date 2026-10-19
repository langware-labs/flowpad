/** A guest tab — content owned by another project than the tab — carries a guest note. */
import { Tab } from '@sdk';
import { isGuestTab, tabItem } from '@src/tabs/tab-row-item';
import { describe, expect, it } from 'vitest';

const A = '3a6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e';
const B = '4a6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e';

function docTab(id: string, project_id: string | null, target_project_id: string | null): Tab {
  return new Tab({
    id,
    pointer: 'markdown:editor/markdown/typeid/markdown-6a6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e',
    target_type: 'markdown',
    target_id: '6a6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e',
    project_id,
    target_project_id,
  } as never);
}

describe('guest tab', () => {
  it('is a guest only when both projects are known and differ', () => {
    expect(isGuestTab({ project_id: A, target_project_id: B })).toBe(true);
    expect(isGuestTab({ project_id: A, target_project_id: A })).toBe(false);
    expect(isGuestTab({ project_id: null, target_project_id: B })).toBe(false);
    expect(isGuestTab({ project_id: A, target_project_id: null })).toBe(false);
  });

  it('puts the guest note on the chip of a guest tab only', () => {
    expect(tabItem(docTab('5a6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e', A, B)).guestNote).toBe('This asset is not part of this project');
    expect(tabItem(docTab('7a6b1c5e-2f7a-4b8c-9d0e-1f2a3b4c5d6e', A, A)).guestNote).toBeUndefined();
  });
});
