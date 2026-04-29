import { FSRef } from '@sdk';
import { useAgentContext } from '@src/contexts/agent-context';
import { MarkdownEditor } from '@src/components/assets/editor/markdown/MarkdownEditor';
import { SkillAssetEditor } from '@src/components/assets/editor/skill/SkillAssetEditor';
import { ConversationPanel } from '@src/components/conversation/ConversationPanel';
import { useConversation } from '@src/components/conversation/useConversation';
import { FileText, X } from 'lucide-react';
import { ICON_BY_TYPE } from '@src/components/conversation/EntityLabel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * A single tab in RoomTabs. Distinct from terminal tabs (those are tracked by
 * TabbedTerminal). RoomTabs hosts asset-style content opened from the room
 * sidebar — docs/markdown/skills/agents/plans.
 */
export interface RoomTab {
  /** Stable key, used for activation + close. */
  key: string;
  /** Discriminator for the renderer dispatch. */
  type: 'markdown' | 'skill' | 'conversation';
  /** Display label in the tab strip. */
  title: string;
  /** Resolves the content to render — markdown: absolute file path; skill: skill folder path; conversation: conversation entity id. */
  asset_ref: string;
}

interface Props {
  tabs: RoomTab[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Rename a tab. Caller is responsible for both local state and any
   * entity-side persistence (Conversation.name, Skill.name, etc.). */
  onRename?: (key: string, newTitle: string) => void;
  className?: string;
}

/**
 * RoomTabs — a tab strip + content area for non-terminal content opened in
 * the collaboration room. Holds tabs in memory; the active tab key is owned
 * by the parent so callers can wire the open-tab affordance from elsewhere
 * (the Docs sidebar, etc.).
 */
export function RoomTabs({ tabs, activeKey, onActivate, onClose, onRename, className = '' }: Props) {
  if (tabs.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center text-xs text-muted-foreground ${className}`}>
        No assets open. Click a doc or skill in the sidebar to open it here.
      </div>
    );
  }

  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0];

  return (
    <div className={`flex h-full flex-col ${className}`}>
      <div className="flex h-9 flex-shrink-0 items-center gap-1 overflow-x-auto border-b bg-muted/30 px-2">
        {tabs.map((t) => (
          <RoomTabChip
            key={t.key}
            tab={t}
            active={t.key === active.key}
            onActivate={onActivate}
            onClose={onClose}
            onRename={onRename}
          />
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <RoomTabContent tab={active} />
      </div>
    </div>
  );
}

interface ChipProps {
  tab: RoomTab;
  active: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onRename?: (key: string, newTitle: string) => void;
}

function RoomTabChip({ tab, active, onActivate, onClose, onRename }: ChipProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep draft synced when the tab title changes externally (e.g. after the
  // entity's name resolves) and when we're not actively editing.
  useEffect(() => {
    if (!editing) setDraft(tab.title);
  }, [tab.title, editing]);

  // Focus + select the input when entering edit mode.
  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing]);

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(tab.key);
    },
    [onClose, tab.key],
  );

  const commit = useCallback(() => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === tab.title || !onRename) return;
    onRename(tab.key, next);
  }, [draft, tab.title, tab.key, onRename]);

  const cancel = useCallback(() => {
    setDraft(tab.title);
    setEditing(false);
  }, [tab.title]);

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={() => onActivate(tab.key)}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate(tab.key);
        }
      }}
      className={`group inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-2.5 text-xs transition-colors ${
        active
          ? 'border-primary bg-background text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      }`}
      title={editing ? 'Press Enter to save, Esc to cancel' : `${tab.title} — double-click to rename`}
    >
      {(() => {
        const TabIcon = ICON_BY_TYPE[tab.type] ?? FileText;
        return <TabIcon className="h-3 w-3 flex-shrink-0" />;
      })()}
      {editing && onRename ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          className="max-w-[200px] bg-transparent text-xs text-foreground outline-none"
        />
      ) : (
        <span
          className="max-w-[180px] truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (onRename) setEditing(true);
          }}
        >
          {tab.title}
        </span>
      )}
      <span
        role="button"
        tabIndex={0}
        aria-label="Close tab"
        onClick={handleClose}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClose(e as unknown as React.MouseEvent);
          }
        }}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </span>
    </div>
  );
}

function RoomTabContent({ tab }: { tab: RoomTab }) {
  switch (tab.type) {
    case 'markdown':
      return <MarkdownTabContent assetRef={tab.asset_ref} />;
    case 'skill':
      return <SkillTabContent assetRef={tab.asset_ref} />;
    case 'conversation':
      return <ConversationTab conversationId={tab.asset_ref} />;
    default:
      return <div className="p-4 text-sm text-muted-foreground">Unsupported tab type.</div>;
  }
}

function ConversationTab({ conversationId }: { conversationId: string }) {
  // Resolve task (if any) so the canonical ConversationPanel can render the
  // task-bound features for inbound conversations and degrade gracefully for
  // project-scoped ones.
  const { task, senderName, taskMissing } = useConversation(conversationId);
  if (taskMissing) {
    return <div className="p-4 text-sm text-muted-foreground">Loading task context…</div>;
  }
  return (
    <div className="h-full overflow-y-auto">
      <ConversationPanel
        task={task ?? null}
        conversationId={conversationId}
        senderName={senderName}
        headerLabel={null}
      />
    </div>
  );
}

function MarkdownTabContent({ assetRef }: { assetRef: string }) {
  const { computeNode } = useAgentContext();
  const fsRef = useMemo(() => {
    if (!computeNode?.typeId) return null;
    // FSRef paths are vfs-relative; @local mounts at filesystem root, so strip leading slash.
    const vfsSubPath = assetRef.replace(/^\/+/, '');
    return new FSRef(vfsSubPath, computeNode.typeId);
  }, [assetRef, computeNode?.typeId]);

  if (!fsRef) {
    return <div className="p-4 text-xs text-muted-foreground">Connecting…</div>;
  }

  return <MarkdownEditor fsRef={fsRef} chatTarget={null} />;
}

/**
 * Renders the same editor the wiki route mounts at
 * `/dock/assets/editor/skill/...` — so editing a skill in the project view
 * vs. the wiki gives an identical experience.
 */
function SkillTabContent({ assetRef }: { assetRef: string }) {
  const { computeNode } = useAgentContext();
  const fsRef = useMemo(() => {
    if (!computeNode?.typeId) return null;
    // assetRef is the skill folder path; SkillAssetEditor resolves SKILL.md inside.
    const vfsSubPath = assetRef.replace(/^\/+/, '');
    return new FSRef(vfsSubPath, computeNode.typeId);
  }, [assetRef, computeNode?.typeId]);

  if (!fsRef) {
    return <div className="p-4 text-xs text-muted-foreground">Connecting…</div>;
  }

  return <SkillAssetEditor fsRef={fsRef} />;
}
