import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Webhook, Download, Upload } from 'lucide-react';
import React, { useState, useMemo, useEffect } from 'react';
import { HooksTable, type HookTableRow } from './HooksTable';
import { HooksBrowser } from './HooksBrowser';
import { HookEditor } from './HookEditor';
import { getHooks, updateHooks, type HookConfig, type HookDefinition } from './hooks-api';

export function HooksView() {
  const [config, setConfig] = useState<HookConfig>({ hooks: {} });
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Editor state
  const [editHookName, setEditHookName] = useState('');
  const [editEventName, setEditEventName] = useState('PreToolUse');
  const [editMatcher, setEditMatcher] = useState('');
  const [editHookType, setEditHookType] = useState<'command' | 'prompt'>('command');
  const [editCommand, setEditCommand] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editTimeout, setEditTimeout] = useState('60');

  const { toast } = useToast();

  // Load hooks from API on mount
  useEffect(() => {
    void loadHooks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadHooks = async () => {
    try {
      setIsLoading(true);
      const response = await getHooks();
      setConfig({ hooks: response.hooks || {} });
    } catch (error) {
      console.error('Failed to load hooks:', error);
      toast({
        title: 'Failed to Load Hooks',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Flatten config to table rows
  const tableRows = useMemo((): HookTableRow[] => {
    const rows: HookTableRow[] = [];
    let idCounter = 0;

    Object.entries(config.hooks).forEach(([eventName, eventConfigs]) => {
      eventConfigs.forEach((eventConfig, eventConfigIndex) => {
        eventConfig.hooks.forEach((hook, hookIndex) => {
          rows.push({
            id: `${eventName}-${eventConfigIndex}-${hookIndex}-${idCounter++}`,
            eventName,
            matcher: eventConfig.matcher || '*',
            hookType: hook.type,
            content: hook.type === 'command' ? hook.command || '' : hook.prompt || '',
            timeout: hook.timeout,
            eventConfigIndex,
            hookIndex,
          });
        });
      });
    });

    return rows;
  }, [config]);

  const selectedRow = useMemo(() => {
    return tableRows.find((row) => row.id === selectedRowId);
  }, [tableRows, selectedRowId]);

  const handleRowClick = (row: HookTableRow) => {
    setSelectedRowId(row.id);
    setShowEditor(true);

    // Load row data into editor
    setEditEventName(row.eventName);
    setEditMatcher(row.matcher === '*' ? '' : row.matcher);
    setEditHookType(row.hookType);
    if (row.hookType === 'command') {
      setEditCommand(row.content);
      setEditPrompt('');
    } else {
      setEditPrompt(row.content);
      setEditCommand('');
    }
    setEditTimeout(row.timeout?.toString() || '60');
  };

  const handleAddNew = () => {
    setSelectedRowId(null);
    setShowEditor(true);
    setEditEventName('PreToolUse');
    setEditMatcher('');
    setEditHookType('command');
    setEditCommand('');
    setEditPrompt('');
    setEditTimeout('60');
  };

  const handleSave = async () => {
    try {
      const newConfig = { ...config };

      if (selectedRow) {
        // Editing existing hook
        const eventConfigs = newConfig.hooks[selectedRow.eventName];
        const eventConfig = eventConfigs[selectedRow.eventConfigIndex];
        const hook = eventConfig.hooks[selectedRow.hookIndex];

        // Update hook
        hook.type = editHookType;
        if (editHookType === 'command') {
          hook.command = editCommand;
          delete hook.prompt;
        } else {
          hook.prompt = editPrompt;
          delete hook.command;
        }
        hook.timeout = editTimeout ? parseInt(editTimeout, 10) : undefined;

        // If matcher changed, might need to reorganize
        if (eventConfig.matcher !== (editMatcher || undefined)) {
          // Remove from old location
          eventConfig.hooks.splice(selectedRow.hookIndex, 1);
          if (eventConfig.hooks.length === 0) {
            eventConfigs.splice(selectedRow.eventConfigIndex, 1);
          }

          // Add to new location
          addHookToConfig(newConfig, editEventName, editMatcher, {
            type: editHookType,
            command: editHookType === 'command' ? editCommand : undefined,
            prompt: editHookType === 'prompt' ? editPrompt : undefined,
            timeout: editTimeout ? parseInt(editTimeout, 10) : undefined,
          });
        }
      } else {
        // Adding new hook
        addHookToConfig(newConfig, editEventName, editMatcher, {
          type: editHookType,
          command: editHookType === 'command' ? editCommand : undefined,
          prompt: editHookType === 'prompt' ? editPrompt : undefined,
          timeout: editTimeout ? parseInt(editTimeout, 10) : undefined,
        });
      }

      // Save to API
      await updateHooks(newConfig);

      // Reload from server to ensure UI is in sync
      await loadHooks();
      setShowEditor(false);
      setSelectedRowId(null);

      toast({
        title: selectedRow ? 'Hook Updated' : 'Hook Added',
        description: `Hook has been ${selectedRow ? 'updated' : 'added'} successfully`,
      });
    } catch (error) {
      console.error('Failed to save hook:', error);
      toast({
        title: 'Failed to Save',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const addHookToConfig = (config: HookConfig, eventName: string, matcher: string, hook: HookDefinition) => {
    if (!config.hooks[eventName]) {
      config.hooks[eventName] = [];
    }

    const matcherValue = matcher || undefined;
    const existingConfig = config.hooks[eventName].find((ec) => ec.matcher === matcherValue);

    if (existingConfig) {
      existingConfig.hooks.push(hook);
    } else {
      config.hooks[eventName].push({
        matcher: matcherValue,
        hooks: [hook],
      });
    }
  };

  const handleDelete = async (row: HookTableRow) => {
    try {
      const newConfig = { ...config };
      const eventConfigs = newConfig.hooks[row.eventName];
      const eventConfig = eventConfigs[row.eventConfigIndex];

      eventConfig.hooks.splice(row.hookIndex, 1);

      if (eventConfig.hooks.length === 0) {
        eventConfigs.splice(row.eventConfigIndex, 1);
      }

      if (eventConfigs.length === 0) {
        delete newConfig.hooks[row.eventName];
      }

      // Save to API
      await updateHooks(newConfig);

      // Reload from server to ensure UI is in sync
      await loadHooks();
      setSelectedRowId(null);
      setShowEditor(false);

      toast({
        title: 'Hook Deleted',
        description: 'Hook has been removed successfully',
      });
    } catch (error) {
      console.error('Failed to delete hook:', error);
      toast({
        title: 'Failed to Delete',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  const handleCancel = () => {
    setShowEditor(false);
    setSelectedRowId(null);
  };

  const handleExport = () => {
    const jsonStr = JSON.stringify(config, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'claude-code-hooks.json';
    a.click();
    URL.revokeObjectURL(url);

    toast({
      title: 'Exported',
      description: 'Hooks configuration has been downloaded',
    });
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        const parsed = JSON.parse(content);

        // Save to API
        await updateHooks(parsed);

        // Reload from server to ensure UI is in sync
        await loadHooks();

        toast({
          title: 'Imported',
          description: 'Hooks configuration has been loaded and saved',
        });
      } catch (error) {
        toast({
          title: 'Import Failed',
          description: error instanceof Error ? error.message : 'Invalid JSON',
          variant: 'destructive',
        });
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl space-y-6 p-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Webhook className="h-6 w-6" />
                <h2 className="text-2xl font-bold text-foreground">Hooks</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Configure Claude Code hooks to automate workflows with custom scripts and AI-powered decisions
              </p>
            </div>

            <div className="flex gap-2">
              <label htmlFor="import-hooks">
                <Button variant="outline" className="cursor-pointer" asChild>
                  <span>
                    <Upload className="mr-2 h-4 w-4" />
                    Import
                  </span>
                </Button>
                <input id="import-hooks" type="file" accept=".json" className="hidden" onChange={handleImport} />
              </label>
              <Button variant="outline" onClick={handleExport}>
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>
          </div>

          {/* Hooks Browser */}
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">Hooks Browser</h3>
              <p className="text-xs text-muted-foreground">
                Scans all hook resources from the system profile and lists every hook with full details.
              </p>
            </div>
            <HooksBrowser />
          </div>

          {/* Toggle between Table and Editor */}
          {isLoading ? (
            <div className="flex items-center justify-center rounded-lg border p-12">
              <p className="text-sm text-muted-foreground">Loading hooks...</p>
            </div>
          ) : showEditor ? (
            <HookEditor
              isEditing={!!selectedRow}
              hookName={editHookName}
              eventName={editEventName}
              matcher={editMatcher}
              hookType={editHookType}
              command={editCommand}
              prompt={editPrompt}
              timeout={editTimeout}
              onHookNameChange={setEditHookName}
              onEventNameChange={setEditEventName}
              onMatcherChange={setEditMatcher}
              onHookTypeChange={setEditHookType}
              onCommandChange={setEditCommand}
              onPromptChange={setEditPrompt}
              onTimeoutChange={setEditTimeout}
              onSave={() => {
                void handleSave();
              }}
              onCancel={handleCancel}
            />
          ) : (
            <HooksTable
              rows={tableRows}
              selectedRowId={selectedRowId}
              onRowClick={handleRowClick}
              onAddClick={handleAddNew}
              onDeleteClick={(row) => {
                void handleDelete(row);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
