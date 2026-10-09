/**
 * The app-level half of the UI actions (`ui-actions.ts`): it hands the handlers what only the
 * React tree has (navigation, the theme), and hosts the dialogs that are not tied to one screen --
 * create an asset, a project, a conversation, add a dependency or a help desk, the quick create
 * menu -- so a request for one opens over whatever page is showing. Mounted once, in `App`.
 */

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';

import { notify } from '@src/notifications';
import { useProjectOpener } from '@src/components/open-project-component/use-open-project';
import { useQuickCreatePick } from '@src/components/quick-create/QuickCreatePanel';
import { QuickCreateModal } from '@src/components/quick-create/QuickCreateModal';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { setUiActionHost, useUiActionRequest } from '@src/navigation/ui-actions';

/** The asset types a `quick-create-<type>` action opens the create dialog for (`dynamic-workflow`
 *  in the id is `dynamic_workflow` here). */
const QUICK_CREATE_TYPES = ['agent', 'skill', 'subagent', 'dynamic_workflow', 'task', 'markdown', 'whiteboard', 'mcp', 'credential'];
const quickCreateId = (type: string) => `quick-create-${type.replace(/_/g, '-')}`;

const HOSTED = [
  ...QUICK_CREATE_TYPES.map(quickCreateId),
  'quick-create-modal',
  'new-project-dialog',
  'new-project-from-git',
  'open-folder',
  'add-dependency',
  'new-conversation-dialog',
  'add-help-desk',
];

export function UiActionRoot() {
  const { navigation } = useDockNavigation();
  const { resolvedTheme, setTheme } = useTheme();
  const { panelProps, dialogs, openSource } = useQuickCreatePick();
  const { openProjectFolder } = useProjectOpener({ onError: (message) => notify.error({ title: message }) });
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setUiActionHost({ navigation, toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark') });
    return () => setUiActionHost(null);
  }, [navigation, resolvedTheme, setTheme]);

  // What each action this root hosts does.
  const handlers: Record<string, () => unknown> = {
    ...Object.fromEntries(QUICK_CREATE_TYPES.map((type) => [quickCreateId(type), () => panelProps.onPick(type)])),
    'quick-create-modal': () => setMenuOpen(true),
    'new-project-dialog': panelProps.onNewProject,
    'new-project-from-git': panelProps.onNewProjectFromGit,
    'open-folder': () => openProjectFolder(),
    'add-dependency': openSource,
    'new-conversation-dialog': panelProps.onNewMessage,
    'add-help-desk': panelProps.onAddHelpdesk,
  };
  useUiActionRequest(HOSTED, (id) => handlers[id]?.());

  return (
    <>
      {dialogs}
      <QuickCreateModal open={menuOpen} onOpenChange={setMenuOpen} panelProps={panelProps} />
    </>
  );
}
