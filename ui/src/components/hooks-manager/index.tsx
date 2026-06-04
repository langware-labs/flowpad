import { TypeId, AgentHook, Trigger, HookScope } from '@sdk';
import { useContext, useEntity, useProject } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { Switch } from '@src/components/ui/switch';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Plus, Webhook, Trash2, Edit, Zap, ChevronDown, ChevronRight, Power } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { HookForm } from './HookForm';
import { HooksBrowser } from '../hooks-view/HooksBrowser';
import { TriggerForm } from './TriggerForm';
import { ToastTitle, ToastDescription, ErrorMessage } from './constants';
import { useSnifferContext } from '@src/contexts/SnifferContext';

interface HooksManagerProps {
  entityTypeId?: TypeId;
}

interface TriggerInlineProps {
  trigger: Trigger;
  onEdit: (trigger: Trigger) => void;
  onDelete: (trigger: Trigger) => void | Promise<void>;
  onRefresh: () => void;
}

function TriggerInline({ trigger, onEdit, onDelete, onRefresh }: TriggerInlineProps) {
  // Use useEntity for automatic updates when trigger changes (e.g., counter increment)
  const { data: watchedTrigger } = useEntity<Trigger>(trigger.typeId, { watch: true });
  const activeTrigger = watchedTrigger ?? trigger;
  const counter = activeTrigger.counter;
  const lastTriggered = activeTrigger.last_triggered ?? null;

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      try {
        trigger.enabled = enabled;
        await trigger.save();
        onRefresh();
      } catch (error: unknown) {
        notify.error({
          title: 'Failed to update trigger',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    [trigger, onRefresh],
  );

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap className={`h-4 w-4 ${trigger.enabled ? 'text-yellow-500' : 'text-muted-foreground'}`} />
          <span className="font-medium">{activeTrigger.displayName}</span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
            Count: {counter}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={trigger.enabled} onCheckedChange={(enabled) => void handleToggleEnabled(enabled)} />
          <Button variant="ghost" size="sm" onClick={() => onEdit(trigger)}>
            <Edit className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void onDelete(trigger)}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <div className="mt-2 space-y-1 pl-7 text-xs text-muted-foreground">
        <div>
          <span className="font-semibold">Mask:</span>{' '}
          <code className="rounded bg-muted px-1">{JSON.stringify(trigger.mask)}</code>
        </div>
        <div>
          <span className="font-semibold">Action:</span> {trigger.action.action_type}
        </div>
        {lastTriggered && (
          <div>
            <span className="font-semibold">Last:</span> {lastTriggered.toLocaleString()}
          </div>
        )}
      </div>
    </div>
  );
}

export function HooksManager({ entityTypeId }: HooksManagerProps) {
  const [hooks, setHooks] = useState<AgentHook[]>([]);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [hookTriggers, setHookTriggers] = useState<Map<string, Trigger[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [selectedHook, setSelectedHook] = useState<AgentHook | null>(null);
  const [selectedTrigger, setSelectedTrigger] = useState<Trigger | null>(null);
  const [selectedHookIdForTrigger, setSelectedHookIdForTrigger] = useState<string | undefined>(undefined);
  const [showHookForm, setShowHookForm] = useState(false);
  const [showTriggerForm, setShowTriggerForm] = useState(false);
  const [expandedHooks, setExpandedHooks] = useState<Set<string>>(new Set());

  const { currentDock } = useDockNavigation();
  const { project } = useProject();
  const { snifferEnabled } = useContext();
  const { isLoading: snifferLoading, isToggling: snifferToggling, enable: snifferEnable, disable: snifferDisable } = useSnifferContext();

  const fetchHooks = useCallback(async () => {
    try {
      const hooksList = await AgentHook.list();
      setHooks(hooksList);
    } catch (error: unknown) {
      notify.error({
        title: ToastTitle.FAILED_TO_LOAD_HOOKS,
        message: error instanceof Error ? error.message : ErrorMessage.COULD_NOT_LOAD_HOOKS,
      });
    }
  }, []);

  const fetchTriggers = useCallback(async () => {
    try {
      const triggersList = await Trigger.list();
      setTriggers(triggersList);
    } catch (error: unknown) {
      notify.error({
        title: ToastTitle.FAILED_TO_LOAD_TRIGGERS,
        message: error instanceof Error ? error.message : ErrorMessage.COULD_NOT_LOAD_TRIGGERS,
      });
    }
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([fetchHooks(), fetchTriggers()]);
    } finally {
      setLoading(false);
    }
  }, [fetchHooks, fetchTriggers]);

  const fetchTriggersForHooks = useCallback(async () => {
    const triggersMap = new Map<string, Trigger[]>();
    for (const hook of hooks) {
      try {
        const hookTriggersList = await hook.getTriggers();
        triggersMap.set(hook.id, hookTriggersList);
      } catch (error) {
        console.error(`Failed to fetch triggers for hook ${hook.id}:`, error);
        triggersMap.set(hook.id, []);
      }
    }
    setHookTriggers(triggersMap);
  }, [hooks]);

  useEffect(() => {
    void fetchData();
  }, [entityTypeId, fetchData]);

  useEffect(() => {
    void fetchTriggersForHooks();
  }, [fetchTriggersForHooks]);

  const handleEditHook = (hook: AgentHook) => {
    setSelectedHook(hook);
    setShowHookForm(true);
  };

  const handleDeleteHook = async (hook: AgentHook) => {
    try {
      await hook.delete();
      await fetchHooks();
      notify.success({
        title: ToastTitle.HOOK_DELETED,
        message: ToastDescription.HOOK_DELETED,
      });
    } catch (error: unknown) {
      notify.error({
        title: ToastTitle.FAILED_TO_DELETE_HOOK,
        message: error instanceof Error ? error.message : ErrorMessage.COULD_NOT_DELETE_HOOK,
      });
    }
  };

  const handleSaveHook = async (hook: AgentHook) => {
    try {
      // Set project_id for PROJECT/LOCAL scope hooks if project is available
      if ((hook.hook_scope === HookScope.PROJECT || hook.hook_scope === HookScope.LOCAL) && project?.id) {
        hook.project_id = project.id;
      }
      await hook.save();
      setShowHookForm(false);
      await fetchHooks();
      notify.success({
        title: ToastTitle.HOOK_SAVED,
        message: ToastDescription.HOOK_SAVED,
      });
    } catch (error: unknown) {
      notify.error({
        title: ToastTitle.FAILED_TO_SAVE_HOOK,
        message: error instanceof Error ? error.message : ErrorMessage.COULD_NOT_SAVE_HOOK,
      });
    }
  };

  const handleAddTriggerToHook = (hookId: string) => {
    setSelectedTrigger(null);
    setSelectedHookIdForTrigger(hookId);
    setShowTriggerForm(true);
  };

  const handleEditTrigger = (trigger: Trigger) => {
    setSelectedTrigger(trigger);
    setSelectedHookIdForTrigger(undefined);
    setShowTriggerForm(true);
  };

  const handleDeleteTrigger = async (trigger: Trigger) => {
    try {
      await trigger.delete();
      await fetchTriggers();
      await fetchTriggersForHooks();
      notify.success({
        title: ToastTitle.TRIGGER_DELETED,
        message: ToastDescription.TRIGGER_DELETED,
      });
    } catch (error: unknown) {
      notify.error({
        title: ToastTitle.FAILED_TO_DELETE_TRIGGER,
        message: error instanceof Error ? error.message : ErrorMessage.COULD_NOT_DELETE_TRIGGER,
      });
    }
  };

  const handleSaveTrigger = async (trigger: Trigger, hookId?: string) => {
    try {
      await trigger.save();

      // If hookId is provided, connect the trigger to the hook
      if (hookId) {
        const hook = hooks.find((h) => h.id === hookId);
        if (hook) {
          await hook.addTrigger(trigger);
        }
      }

      setShowTriggerForm(false);
      setSelectedHookIdForTrigger(undefined);

      await fetchTriggers();
      await fetchTriggersForHooks();

      notify.success({
        title: ToastTitle.TRIGGER_SAVED,
        message: ToastDescription.TRIGGER_SAVED,
      });
    } catch (error: unknown) {
      notify.error({
        title: ToastTitle.FAILED_TO_SAVE_TRIGGER,
        message: error instanceof Error ? error.message : ErrorMessage.COULD_NOT_SAVE_TRIGGER,
      });
    }
  };

  const toggleHookExpanded = (hookId: string) => {
    setExpandedHooks((prev) => {
      const next = new Set(prev);
      if (next.has(hookId)) {
        next.delete(hookId);
      } else {
        next.add(hookId);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-3 h-12 w-12 animate-spin rounded-full border-4 border-muted border-t-primary" />
          <p className="text-sm text-muted-foreground">Loading hooks...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-7xl space-y-6 p-6">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Webhook className="h-6 w-6" />
                <h2 className="text-2xl font-bold">Hooks Manager</h2>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Configure Claude Code hooks and triggers to automate workflows
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={snifferEnabled ? 'text-green-500' : ''}
              onClick={() => void (snifferEnabled ? snifferDisable() : snifferEnable())}
              disabled={snifferLoading || snifferToggling}
              title={snifferEnabled ? 'Disable sniffer' : 'Enable sniffer'}
            >
              <Power className="h-4 w-4" />
            </Button>
          </div>

          {/* Hooks Browser */}
          <div className="rounded-lg border bg-card p-4">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">Hooks Browser</h3>
              <p className="text-xs text-muted-foreground">
                Scans all hook resources from the system profile and lists every hook with full details.
              </p>
            </div>
            <HooksBrowser
              highlightHookId={currentDock?.options?.hookId}
              highlightEventType={currentDock?.options?.eventType}
            />
          </div>

          {/* Hooks List */}
          {hooks.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
              <Webhook className="mb-3 h-12 w-12 text-muted-foreground opacity-50" />
              <p className="font-medium">No agent hooks configured</p>
              <p className="mt-1 text-sm text-muted-foreground">Create your first hook to get started</p>
            </div>
          ) : (
            <div className="space-y-4">
              {hooks.map((hook) => {
                const isExpanded = expandedHooks.has(hook.id);
                const triggers = hookTriggers.get(hook.id) || [];

                return (
                  <div key={hook.id} className="rounded-lg border bg-card">
                    {/* Hook Header */}
                    <div className="flex items-center justify-between p-4">
                      <div className="flex flex-1 items-center gap-3">
                        <button
                          onClick={() => toggleHookExpanded(hook.id)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                        <div className="flex flex-1 items-center gap-3">
                          <div
                            className={`h-2 w-2 rounded-full ${hook.enabled ? 'bg-green-500' : 'bg-gray-400'}`}
                          />
                          <div className="flex-1">
                            <h3 className="font-semibold">{hook.displayName}</h3>
                            {hook.description && (
                              <p className="text-sm text-muted-foreground">{hook.description}</p>
                            )}
                          </div>
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            {hook.hook_scope}
                          </span>
                          {triggers.length > 0 && (
                            <span className="rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-600">
                              {triggers.length} trigger{triggers.length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleEditHook(hook)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void handleDeleteHook(hook)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    {/* Hook Details (Expanded) */}
                    {isExpanded && (
                      <div className="border-t">
                        {/* Hook Info */}
                        <div className="space-y-2 p-4 text-sm">
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <span className="font-semibold text-muted-foreground">Provider:</span>{' '}
                              <span>{hook.provider}</span>
                            </div>
                            <div>
                              <span className="font-semibold text-muted-foreground">Event:</span>{' '}
                              <span>{hook.event}</span>
                            </div>
                            {hook.command && (
                              <div className="col-span-2">
                                <span className="font-semibold text-muted-foreground">Command:</span>{' '}
                                <code className="rounded bg-muted px-1 py-0.5">{hook.command}</code>
                              </div>
                            )}
                            {hook.matcher && (
                              <div className="col-span-2">
                                <span className="font-semibold text-muted-foreground">Matcher:</span>
                                <pre className="mt-1 rounded bg-muted p-2 text-xs">
                                  {JSON.stringify(hook.matcher, null, 2)}
                                </pre>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Triggers Section */}
                        <div className="border-t p-4">
                          <div className="mb-3 flex items-center justify-between">
                            <h4 className="text-sm font-semibold text-muted-foreground">Triggers</h4>
                            <Button variant="outline" size="sm" onClick={() => handleAddTriggerToHook(hook.id)}>
                              <Plus className="mr-1 h-3 w-3" />
                              Add Trigger
                            </Button>
                          </div>
                          {triggers.length > 0 ? (
                            <div className="space-y-2">
                              {triggers.map((trigger) => (
                                <TriggerInline
                                  key={trigger.id}
                                  trigger={trigger}
                                  onEdit={handleEditTrigger}
                                  onDelete={(t) => void handleDeleteTrigger(t)}
                                  onRefresh={() => void fetchTriggersForHooks()}
                                />
                              ))}
                            </div>
                          ) : (
                            <p className="text-sm italic text-muted-foreground">
                              No triggers configured for this hook
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showHookForm && (
        <HookForm
          hook={selectedHook}
          triggers={triggers}
          onSave={(hook) => void handleSaveHook(hook)}
          onCancel={() => setShowHookForm(false)}
        />
      )}

      {showTriggerForm && (
        <TriggerForm
          trigger={selectedTrigger}
          hookId={selectedHookIdForTrigger}
          onSave={(trigger, hookId) => void handleSaveTrigger(trigger, hookId)}
          onCancel={() => {
            setShowTriggerForm(false);
            setSelectedHookIdForTrigger(undefined);
          }}
        />
      )}
    </div>
  );
}
