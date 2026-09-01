import React, { useState } from 'react';
import { Mcp, Project, TypeId, type McpShape } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Trans, useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

/**
 * New MCP server.
 *
 * The choice is WHERE THE SERVER COMES FROM, not the wire protocol — transport
 * follows from it. A bespoke dialog (rather than the generic name+path form)
 * because that question has no answer the generic form could ask; the pattern
 * is `PromptEditDialog`, which likewise owns its state and calls the SDK.
 *
 * "Write it here" is first and default: it is the only one that produces a
 * server which already runs, so Test passes before the user types anything.
 */
export const McpCreateDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string | null;
}> = ({ open, onOpenChange, projectId = null }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [name, setName] = useState('');
  const [shape, setShape] = useState<McpShape>('bundled');
  const [busy, setBusy] = useState(false);

  // Built in render, not at module scope: `t` must run under the active locale,
  // and a module-level table would freeze the strings at import time.
  const shapes: { value: McpShape; label: string; hint: string }[] = [
    { value: 'bundled', label: t`Write it here`, hint: t`server.py in this asset — runs immediately` },
    { value: 'command', label: t`Run a command`, hint: t`a server already on this machine` },
    { value: 'remote', label: t`Connect to a URL`, hint: t`a server someone else hosts` },
  ];

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const project = projectId ? { typeId: new TypeId(Project.type, projectId) } : null;
      const saved = await Mcp.createInProject(project, trimmed, shape);
      onOpenChange(false);
      setName('');
      notify.success({ title: t`MCP server created` });
      if (saved.asset_ref) navigation.openDock(DockPointer.forAssetEditor('mcp', saved.asset_ref));
    } catch (error) {
      notify.error({
        title: t`Could not create the MCP server`,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>New MCP server</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Input
            autoFocus
            value={name}
            placeholder={t`Name`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && void create()}
            data-testid="mcp-create-name"
          />

          <div className="flex flex-col gap-1.5">
            {shapes.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted"
              >
                <input
                  type="radio"
                  name="mcp-shape"
                  className="mt-1"
                  checked={shape === option.value}
                  onChange={() => setShape(option.value)}
                  data-testid={`mcp-shape-${option.value}`}
                />
                <span className="flex flex-col">
                  <span className="text-sm">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!name.trim() || busy} onClick={() => void create()} data-testid="mcp-create-submit">
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
