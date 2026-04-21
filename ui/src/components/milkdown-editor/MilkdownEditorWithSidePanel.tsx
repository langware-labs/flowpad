import type { MilkdownPlugin } from '@milkdown/ctx';
import { useMemo, useState } from 'react';
import { MilkdownEditor, type MilkdownEditorMode } from './MilkdownEditor';
import {
  BacklinksTab,
  ChatTab,
  MD_SIDE_TABS_DEFAULT,
  SideWindow,
  type MdSideTabId,
} from './side-windows';

interface MilkdownEditorWithSidePanelProps {
  content: string;
  onChange?: (content: string) => void;
  editorMode?: MilkdownEditorMode;
  plugins?: MilkdownPlugin[];
  onLinkClick?: (href: string) => void;
  /** File path used to derive the chat target TypeId. Chat persistence is keyed by this. */
  sourcePath: string;
}

/**
 * Wraps `MilkdownEditor` with a fixed-width tabbed side window (Chat, Backlinks).
 * The side panel is always on; Chat is the default tab.
 *
 * Target TypeId convention: `markdown_file-<sourcePath>`. The path is stable for a
 * file's lifetime; rename breaks continuity (tracked as a known limitation).
 */
export function MilkdownEditorWithSidePanel({
  content,
  onChange,
  editorMode,
  plugins,
  onLinkClick,
  sourcePath,
}: MilkdownEditorWithSidePanelProps) {
  const [activeTab, setActiveTab] = useState<MdSideTabId>(MD_SIDE_TABS_DEFAULT);

  // Markdown files aren't first-class entities — their paths don't pass TypeId's
  // isValidIdentifier check. Build the attachment key as a plain string instead.
  const target = useMemo<string | null>(
    () => (sourcePath ? `markdown_file-${sourcePath}` : null),
    [sourcePath],
  );

  return (
    <div className="flex h-full w-full" data-testid="md-editor-with-side-panel">
      <div className="min-w-0 flex-1">
        <MilkdownEditor
          content={content}
          onChange={onChange}
          editorMode={editorMode}
          plugins={plugins}
          onLinkClick={onLinkClick}
        />
      </div>
      <SideWindow activeTab={activeTab} onSelect={setActiveTab}>
        {{
          chat: <ChatTab target={target} />,
          backlinks: <BacklinksTab target={target} />,
        }}
      </SideWindow>
    </div>
  );
}
