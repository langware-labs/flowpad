import { EnvStatusEnum, EnvVarStatus, EnvVarType, TypeId } from '@sdk';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { Textarea } from '@src/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { errorMessage } from '@src/lib/error-message';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { useAuth, useEntityEnv, useEntityEnvMutations } from '@sdk/react/hooks';
import { FlowPadApiKeyPanel, GeneratedApiKeyCallout } from './api-keys-view/FlowPadApiKeyPanel';
import { useUserApiKeys } from './api-keys-view/use-user-api-keys';
import { AlertCircle, CheckCircle, Edit, FileText, Key, Plus, Trash2, XCircle } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import React, { useState } from 'react';
import { MAX_ENV_VAR_VALUE_LENGTH } from '../constants/validation';
import { getEnvVarTypeLabel, isConfidential } from '../types/envVarTypes';

interface EntityEnvVars {
  values: EnvVarStatus[];
}

interface EnvVarApiInfo {
  name: string;
  var_type: EnvVarType;
  description?: string;
}

type EnvVarApiInfoOut = EnvVarApiInfo;

interface EnvVar extends EnvVarApiInfo {
  value: string;
}

export interface EnvVarsManagerProps {
  entityTypeId: TypeId;
  className?: string;
  /** Render the "Environment Variables" heading + Add button. */
  header?: boolean;
  /**
   * Render the FlowPad API key panel beneath the table.
   *
   * Off by default, and that is the point: API keys belong to the USER while
   * this table belongs to an ENTITY. Fusing the two made one scope look like
   * the other, so a new mount has to ask for it deliberately.
   */
  apiKeyPanel?: boolean;
  onEnvVarSaved?: (envVar: { name: string; var_type: EnvVarType; description?: string }) => void;
  onEnvVarDeleted?: (envVarName: string) => void;
  onEnvVarUpdated?: (envVarName: string) => void;
}

export const EnvVarsManager: React.FC<EnvVarsManagerProps> = ({
  entityTypeId,
  className,
  header = true,
  apiKeyPanel = false,
  onEnvVarSaved,
  onEnvVarDeleted,
  onEnvVarUpdated,
}) => {
  const { t } = useLingui();
  const [editingEnvVar, setEditingEnvVar] = useState<EnvVar | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [newEnvVar, setNewEnvVar] = useState<Partial<EnvVar>>({});
  const { user } = useAuth();
  const { table, isLoading, error } = useEntityEnv({ entityTypeId, enabled: !!user?.id });
  const envVarsTable: EntityEnvVars = { values: table?.values || [] };
  const envMutations = useEntityEnvMutations(entityTypeId);
  // API keys are USER-scoped while this table is ENTITY-scoped; `apiKeyPanel`
  // is what keeps that distinction visible at each mount.
  const apiKeys = useUserApiKeys({ onMutated: () => envMutations.invalidate() });

  // Helper functions to render status and type information
  const getStatusBadge = (row: EnvVarStatus) => {
    const status = row.var_status;

    switch (status) {
      case EnvStatusEnum.AVAILABLE:
        return (
          <Badge variant="secondary" className="bg-green-200/20 text-green-700">
            <CheckCircle className="mr-1 h-3 w-3" />
            Available
          </Badge>
        );
      case EnvStatusEnum.MISSING:
        return (
          <Badge variant="secondary" className="bg-red-200/20 text-red-700">
            <XCircle className="mr-1 h-3 w-3" />
            Missing
          </Badge>
        );
      case EnvStatusEnum.CONSENT_REQUIRED:
        return (
          <Badge variant="secondary" className="bg-yellow-200/20 text-yellow-700">
            <AlertCircle className="mr-1 h-3 w-3" />
            Requires Consent
          </Badge>
        );
      case EnvStatusEnum.ERROR:
        return (
          <Badge variant="secondary" className="bg-red-200/20 text-red-700">
            <XCircle className="mr-1 h-3 w-3" />
            Error
          </Badge>
        );
      case EnvStatusEnum.NA:
      default:
        return (
          <Badge variant="secondary" className="bg-neutral-200/20 text-muted-foreground">
            N/A
          </Badge>
        );
    }
  };

  const getTypeBadge = (varType: EnvVarType) => {
    return getEnvVarTypeLabel(varType);
  };

  const cropDescription = (description: string | undefined, maxLength: number = 50) => {
    if (!description) return 'No description';
    if (description.length <= maxLength) return description;
    return description.substring(0, maxLength) + '...';
  };

  const getValueDisplay = (row: EnvVarStatus) => {
    if (!row.visible_value) {
      // For OAuth tokens, show **** instead of "Not set"
      if (row.var_type === EnvVarType.OAUTH_TOKEN) {
        return <span className="font-mono text-neutral-600">****</span>;
      }
      return <span className="italic text-neutral-400"><Trans>Not set</Trans></span>;
    }
    // Check if it's a masked value (starts with ****)
    if (row.visible_value.startsWith('****')) {
      return <span className="font-mono text-neutral-600">{row.visible_value}</span>;
    }
    // Plain value
    return <span className="font-mono">{row.visible_value}</span>;
  };

  const getVariableIcon = (row: EnvVarStatus) => {
    switch (row.var_type) {
      case EnvVarType.OAUTH_TOKEN: {
        // Extract provider name from variable name or ref_name
        // OAuth tokens are typically named like "slack", "github", etc.
        let providerName = row.name.toLowerCase();

        // If there's a ref_name, use that as it's more reliable
        if (row.ref_name) {
          providerName = row.ref_name.toLowerCase();
        }

        // Look up the provider directly from the table values
        const providerRow = envVarsTable?.values.find(
          (r) =>
            r.var_type === EnvVarType.OAUTH_PROVIDER_ID &&
            (r.name.toLowerCase() === providerName || providerName.includes(r.name.toLowerCase())),
        );

        if (providerRow?.icon) {
          return (
            <div className="flex h-4 w-4 items-center">
              <img
                src={providerRow.icon}
                alt={`${providerRow.name} icon`}
                className="h-4 w-4 flex-shrink-0 object-contain"
                onError={(e) => {
                  // Hide broken image and show fallback key icon instead
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          );
        }
        // Fallback to key icon if no provider found
        return <Key className="h-4 w-4 text-blue-600" />;
      }
      case EnvVarType.API_KEY:
        return <Key className="h-4 w-4 text-purple-600" />;
      case EnvVarType.PLAIN:
      default:
        return <FileText className="h-4 w-4 text-neutral-600" />;
    }
  };

  const handleEdit = (envVar: EnvVarApiInfoOut) => {
    if (!user?.id) {
      notify.info({
        title: t`Login Required`,
        message: t`Please login in order to edit environment variables`,
      });
      return;
    }

    setEditingEnvVar({ ...envVar, value: '' }); // Initialize with empty value
    setNewEnvVar({
      name: envVar.name,
      var_type: envVar.var_type,
      description: envVar.description,
    });
    setShowEditDialog(true);
  };

  const handleDelete = async (envVarName: string) => {
    if (!user?.id) {
      notify.error({
        title: t`Error`,
        message: t`You must be logged in to delete environment variables`,
      });
      return;
    }

    try {
      await envMutations.remove(envVarName);
      onEnvVarDeleted?.(envVarName);
      notify.success({ title: t`Success`, message: t`Environment variable deleted successfully` });
    } catch (error: unknown) {
      notify.error({
        title: t`Error`,
        message: errorMessage(error, t`Failed to delete environment variable`),
      });
    }
  };

  const validateEnvVarName = (name: string): boolean => {
    return /^[A-Z0-9_]+$/.test(name);
  };

  const validateEnvVarValue = (value: string): boolean => {
    return value.length <= MAX_ENV_VAR_VALUE_LENGTH;
  };


  const handleSave = async () => {
    if (!user?.id) {
      notify.info({
        title: t`Login Required`,
        message: t`Please login in order to save environment variables`,
      });
      return;
    }

    if (!newEnvVar.name) {
      notify.error({
        title: t`Error`,
        message: t`Name is required`,
      });
      return;
    }

    if (!validateEnvVarName(newEnvVar.name)) {
      notify.error({
        title: t`Error`,
        message: t`Variable name must contain only uppercase letters, numbers, and underscores`,
      });
      return;
    }

    if (!editingEnvVar && !newEnvVar.value) {
      notify.error({
        title: t`Error`,
        message: t`Value is required for new variables`,
      });
      return;
    }

    if (newEnvVar.value && !validateEnvVarValue(newEnvVar.value)) {
      notify.error({
        title: t`Error`,
        message: `Variable value is too long (max ${MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters)`,
      });
      return;
    }

    if (!newEnvVar.var_type && !editingEnvVar) {
      notify.error({
        title: t`Error`,
        message: t`Variable type is required`,
      });
      return;
    }

    try {
      if (editingEnvVar) {
        // Check if any changes were made
        const hasChanges =
          newEnvVar.description !== editingEnvVar.description ||
          (newEnvVar.value !== undefined && newEnvVar.value !== '');

        if (!hasChanges) {
          // No changes made, just close the dialog
          setShowEditDialog(false);
          return;
        }

        // Update existing env var - only send changed fields
        const updateData: Partial<EnvVar> = {
          var_type: editingEnvVar.var_type,
        };

        // Always include description if it was changed (including when emptied)
        if (newEnvVar.description !== editingEnvVar.description) {
          updateData.description = newEnvVar.description || '';
        }
        if (newEnvVar.value) {
          updateData.value = newEnvVar.value;
        }

        await envMutations.update(editingEnvVar.name, updateData);

        // Call the generic callback for env var updates
        onEnvVarUpdated?.(editingEnvVar.name);

        onEnvVarSaved?.({
          name: editingEnvVar.name,
          var_type: editingEnvVar.var_type,
          description: newEnvVar.description !== undefined ? newEnvVar.description : editingEnvVar.description,
        });

        notify.success({
          title: t`Success`,
          message: t`Environment variable updated successfully`,
        });
      } else {
        // Create new env var
        await envMutations.create({
          name: newEnvVar.name,
          var_type: newEnvVar.var_type || EnvVarType.API_KEY, // Default to API_KEY if not set
          description: newEnvVar.description || '',
          value: newEnvVar.value!,
        });

        onEnvVarSaved?.({
          name: newEnvVar.name,
          var_type: newEnvVar.var_type || EnvVarType.API_KEY,
          description: newEnvVar.description || '',
        });

        notify.success({
          title: t`Success`,
          message: t`Environment variable created successfully`,
        });
      }
      setShowEditDialog(false);
    } catch (error: unknown) {
      notify.error({ title: t`Error`, message: errorMessage(error, t`Unknown error occurred`) });
    }
  };

  return (
    // No frame of its own: no height, no padding. Hosts differ (a tab pane
    // already scrolls and pads; a dedicated view does not), and a component
    // that assumes one double-pads in the other.
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="env-vars-manager">
      <div className="mb-4 flex items-center justify-between">
        {header && <h2 className="text-xl font-semibold"><Trans>Environment Variables</Trans></h2>}
        <Button
          onClick={() => {
            if (!user?.id) {
              notify.info({
                title: t`Login Required`,
                message: t`Please login in order to add a new variable`,
              });
            } else {
              setEditingEnvVar(null);
              setNewEnvVar({ var_type: EnvVarType.PLAIN }); // Default to PLAIN
              setShowEditDialog(true);
            }
          }}
          className={cn('flex items-center gap-2', !header && 'ml-auto')}
          data-testid="env-var-add"
        >
          <Plus className="h-4 w-4" />
          <Trans>Add Variable</Trans>
        </Button>
      </div>

      {error && (
        <div
          className="mb-2 rounded border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="env-vars-error"
        >
          {errorMessage(error, t`Could not load environment variables`)}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-center text-neutral-500"><Trans>Loading environment variables...</Trans></div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead><Trans>Name</Trans></TableHead>
                <TableHead><Trans>Description</Trans></TableHead>
                <TableHead><Trans>Type</Trans></TableHead>
                <TableHead><Trans>Value</Trans></TableHead>
                <TableHead><Trans>Status</Trans></TableHead>
                <TableHead><Trans>Actions</Trans></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {envVarsTable?.values && envVarsTable.values.length > 0 ? (
                envVarsTable.values.map((envVar) => (
                  <TableRow key={envVar.name}>
                    <TableCell className="font-mono">
                      <div className="flex items-center gap-2">
                        {getVariableIcon(envVar)}
                        {envVar.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help">{cropDescription(envVar.description)}</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="max-w-xs">{envVar.description || 'No description'}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </TableCell>
                    <TableCell>{getTypeBadge(envVar.var_type)}</TableCell>
                    <TableCell>{getValueDisplay(envVar)}</TableCell>
                    <TableCell>{getStatusBadge(envVar)}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleEdit(envVar)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void handleDelete(envVar.name);
                          }}
                          className="text-red-600 hover:text-red-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-neutral-500">
                    {isLoading ? 'Loading environment variables...' : 'No environment variables configured yet'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>

      {apiKeyPanel && <FlowPadApiKeyPanel keys={apiKeys} className="mt-6" />}
      {apiKeyPanel && apiKeys.generatedKey && (
        <GeneratedApiKeyCallout apiKey={apiKeys.generatedKey} className="mt-6" />
      )}

      {showEditDialog && (
        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editingEnvVar ? 'Edit' : 'Add'} Environment Variable</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium"><Trans>Name (uppercase letters, numbers, and underscores only)</Trans></label>
                <Input
                  value={newEnvVar.name || ''}
                  onChange={(e) => setNewEnvVar({ ...newEnvVar, name: e.target.value.toUpperCase() })}
                  placeholder={t`VAR_NAME`}
                  className="font-mono"
                  disabled={!!editingEnvVar}
                  title="Only uppercase letters, numbers, and underscores are allowed"
                />
              </div>

              {!editingEnvVar && (
                <div>
                  <label className="text-sm font-medium"><Trans>Type</Trans></label>
                  <Select
                    value={newEnvVar.var_type || EnvVarType.PLAIN}
                    onValueChange={(value) => setNewEnvVar({ ...newEnvVar, var_type: value as EnvVarType })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={t`Select variable type`} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={EnvVarType.PLAIN}>{getEnvVarTypeLabel(EnvVarType.PLAIN)}</SelectItem>
                      <SelectItem value={EnvVarType.API_KEY}>{getEnvVarTypeLabel(EnvVarType.API_KEY)}</SelectItem>
                    </SelectContent>
                  </Select>
                  {newEnvVar.var_type && isConfidential(newEnvVar.var_type) && (
                    <p className="mt-1 text-xs text-neutral-500">
                      This value will be stored securely and masked when displayed
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="text-sm font-medium"><Trans>Description</Trans></label>
                <Textarea
                  value={newEnvVar.description || ''}
                  onChange={(e) => setNewEnvVar({ ...newEnvVar, description: e.target.value })}
                  placeholder={t`Description of this environment variable`}
                  rows={2}
                />
              </div>

              {!editingEnvVar && (
                <div>
                  <label className="text-sm font-medium">
                    <Trans>Value (max {MAX_ENV_VAR_VALUE_LENGTH} characters)</Trans>
                  </label>
                  <Textarea
                    value={newEnvVar.value || ''}
                    onChange={(e) => setNewEnvVar({ ...newEnvVar, value: e.target.value })}
                    placeholder={t`Enter the variable value`}
                    rows={3}
                    title={`Value must be ${MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters or less`}
                  />
                </div>
              )}
              {editingEnvVar && (
                <div>
                  <label className="text-sm font-medium">
                    <Trans>New Value (optional, max {MAX_ENV_VAR_VALUE_LENGTH} characters)</Trans>
                  </label>
                  <Textarea
                    value={newEnvVar.value || ''}
                    onChange={(e) => setNewEnvVar({ ...newEnvVar, value: e.target.value })}
                    placeholder={t`Leave empty to keep current value`}
                    rows={3}
                    title={`Value must be ${MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters or less`}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEditDialog(false)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button
                onClick={() => {
                  void handleSave();
                }}
              >
                <Trans>Save</Trans>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default EnvVarsManager;
