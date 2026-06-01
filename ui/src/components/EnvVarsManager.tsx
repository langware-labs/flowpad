import {
  ActionInfo,
  ApiKeyCredentials,
  dataManager,
  EntityEnv,
  EnvStatusEnum,
  EnvVarType,
  TypeId,
} from '@sdk';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { Textarea } from '@src/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { notify } from '@src/notifications';
import { useAuth, useEntityEnv } from '@sdk/react/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle, Edit, FileText, Key, Plus, Trash2, XCircle } from 'lucide-react';
import React, { useState } from 'react';
import { MAX_ENV_VAR_VALUE_LENGTH } from '../constants/validation';
import { BuiltinEntityType, getEnvVarTypeLabel, isConfidential } from '../types/envVarTypes';

interface ApiKeyListItem {
  id: string;
  name: string;
  description?: string;
  visible_value: string;
  target_typeid: string;
  expires_at?: string;
  last_used_at?: string;
  is_active: boolean;
}

interface EnvVarStatus {
  name: string;
  description?: string;
  var_type: EnvVarType;
  visible_value?: string;
  icon?: string;
  var_status?: EnvStatusEnum;
  ref_name?: string;
  ref_type?: BuiltinEntityType | string;
}

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

interface EnvVarManagerProps {
  entityTypeId: TypeId;
  onEnvVarSaved?: (envVar: { name: string; var_type: EnvVarType; description?: string }) => void;
  onEnvVarDeleted?: (envVarName: string) => void;
  onEnvVarUpdated?: (envVarName: string) => void;
}

const EnvVarsManager: React.FC<EnvVarManagerProps> = ({
  entityTypeId,
  onEnvVarSaved,
  onEnvVarDeleted,
  onEnvVarUpdated,
}) => {
  const [editingEnvVar, setEditingEnvVar] = useState<EnvVar | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [newEnvVar, setNewEnvVar] = useState<Partial<EnvVar>>({});
  const [generatedApiKey, setGeneratedApiKey] = useState<ApiKeyCredentials | null>(null);
  const [hasFlowPadApiKey, setHasFlowPadApiKey] = useState(false);
  const [apiKeysReloadTrigger, setApiKeysReloadTrigger] = useState(0);
  const [userApiKeys, setUserApiKeys] = useState<ApiKeyListItem[]>([]);
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // Use the unified hook to load environment variables table data
  const { table, isLoading } = useEntityEnv({ entityTypeId, enabled: !!user?.id });

  // Transform table data to the format expected by the component
  const envVarsTable: EntityEnvVars = {
    values: table?.values || [],
  };

  // Load API keys from the user (not from the project entityTypeId)
  React.useEffect(() => {
    const loadUserApiKeys = async () => {
      if (!user?.typeId) return;

      try {
        const actionInfo = new ActionInfo('api-keys', user.typeId.type, user.typeId.id, 'GET');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await dataManager.callAction<any, ApiKeyListItem[]>(actionInfo);
        setUserApiKeys(result || []);
      } catch (error) {
        console.error('Failed to load API keys:', error);
        setUserApiKeys([]);
      }
    };

    void loadUserApiKeys();
  }, [user?.typeId, apiKeysReloadTrigger]); // Re-fetch when trigger changes

  // Check if there's already a FlowPad API key (only active keys)
  const existingApiKey = React.useMemo(() => {
    return userApiKeys.find((apiKey) => apiKey.name?.includes('FLOWPAD_API_KEY') && apiKey.is_active);
  }, [userApiKeys]);

  React.useEffect(() => {
    setHasFlowPadApiKey(!!existingApiKey);
  }, [existingApiKey]);

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
      return <span className="italic text-neutral-400">Not set</span>;
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
        title: 'Login Required',
        message: 'Please login in order to edit environment variables',
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
        title: 'Error',
        message: 'You must be logged in to delete environment variables',
      });
      return;
    }

    try {
      const entityEnv = new EntityEnv(entityTypeId);
      await entityEnv.delete(envVarName);

      onEnvVarDeleted?.(envVarName);

      // Invalidate the query cache to update other components
      void queryClient.invalidateQueries({ queryKey: ['entity-env-table', entityTypeId.toString()] });

      notify.success({
        title: 'Success',
        message: 'Environment variable deleted successfully',
      });
    } catch (error: unknown) {
      let errorMessage = 'Failed to delete environment variable';

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        const errorObj = error as {
          response?: {
            data?: {
              detail?: string;
              message?: string;
            };
          };
          detail?: string;
          message?: string;
        };
        errorMessage =
          errorObj?.response?.data?.detail ||
          errorObj?.response?.data?.message ||
          errorObj?.detail ||
          errorObj?.message ||
          'Failed to delete environment variable';
      }

      notify.error({
        title: 'Error',
        message: errorMessage,
      });
    }
  };

  const validateEnvVarName = (name: string): boolean => {
    return /^[A-Z0-9_]+$/.test(name);
  };

  const validateEnvVarValue = (value: string): boolean => {
    return value.length <= MAX_ENV_VAR_VALUE_LENGTH;
  };

  const handleGenerateApiKey = async () => {
    if (!user?.typeId) {
      notify.error({
        title: 'Error',
        message: 'User not logged in',
      });
      return;
    }

    try {
      // Create ActionInfo for API key generation
      const actionInfo = new ActionInfo('api-keys', user.typeId.type, user.typeId.id, 'POST');
      actionInfo.bodyParameters = {
        name: 'FLOWPAD_API_KEY',
        description: 'API key for communicating with flowpad API itself',
      };

      // Call the action
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await dataManager.callAction<any, ApiKeyCredentials>(actionInfo);

      // Store the entire result object with all credentials
      setGeneratedApiKey(result);

      // Reload API keys list by triggering useEffect dependency
      setApiKeysReloadTrigger((prev) => prev + 1);

      // Invalidate the query cache to refresh the table
      if (entityTypeId) {
        void queryClient.invalidateQueries({ queryKey: ['entity-env-table', entityTypeId.toString()] });
      }
    } catch (error: unknown) {
      let errorMessage = 'Failed to generate API key';

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        const errorObj = error as {
          response?: {
            data?: {
              detail?: string;
              message?: string;
            };
          };
          detail?: string;
          message?: string;
        };
        errorMessage =
          errorObj?.response?.data?.detail ||
          errorObj?.response?.data?.message ||
          errorObj?.detail ||
          errorObj?.message ||
          'Failed to generate API key';
      }

      notify.error({
        title: 'API Key Generation',
        message: errorMessage,
      });
    }
  };

  const handleDeleteApiKey = async (keyName: string) => {
    if (!user?.typeId) {
      notify.error({
        title: 'Error',
        message: 'User not logged in',
      });
      return;
    }

    try {
      // Create ActionInfo for API key deletion
      const actionInfo = new ActionInfo('api-keys', user.typeId.type, user.typeId.id, 'DELETE');
      actionInfo.subpath = [keyName];

      await dataManager.callAction(actionInfo);

      // Optimistically update: remove the deleted key from state immediately
      setUserApiKeys((prev) => prev.filter((key) => key.name !== keyName));

      // Clear the generated API key display if visible
      setGeneratedApiKey(null);

      // Reload API keys list by triggering useEffect dependency
      setApiKeysReloadTrigger((prev) => prev + 1);

      // Invalidate the query cache to refresh the table
      if (entityTypeId) {
        void queryClient.invalidateQueries({ queryKey: ['entity-env-table', entityTypeId.toString()] });
      }
    } catch (error: unknown) {
      let errorMessage = 'Failed to delete API key';

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        const errorObj = error as {
          response?: {
            data?: {
              detail?: string;
              message?: string;
            };
          };
          detail?: string;
          message?: string;
        };
        errorMessage =
          errorObj?.response?.data?.detail ||
          errorObj?.response?.data?.message ||
          errorObj?.detail ||
          errorObj?.message ||
          'Failed to delete API key';
      }

      notify.error({
        title: 'API Key Deletion',
        message: errorMessage,
      });
    }
  };

  const handleSave = async () => {
    if (!user?.id) {
      notify.info({
        title: 'Login Required',
        message: 'Please login in order to save environment variables',
      });
      return;
    }

    if (!newEnvVar.name) {
      notify.error({
        title: 'Error',
        message: 'Name is required',
      });
      return;
    }

    if (!validateEnvVarName(newEnvVar.name)) {
      notify.error({
        title: 'Error',
        message: 'Variable name must contain only uppercase letters, numbers, and underscores',
      });
      return;
    }

    if (!editingEnvVar && !newEnvVar.value) {
      notify.error({
        title: 'Error',
        message: 'Value is required for new variables',
      });
      return;
    }

    if (newEnvVar.value && !validateEnvVarValue(newEnvVar.value)) {
      notify.error({
        title: 'Error',
        message: `Variable value is too long (max ${MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters)`,
      });
      return;
    }

    if (!newEnvVar.var_type && !editingEnvVar) {
      notify.error({
        title: 'Error',
        message: 'Variable type is required',
      });
      return;
    }

    try {
      const entityEnv = new EntityEnv(entityTypeId);

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

        await entityEnv.update(editingEnvVar.name, updateData);

        // Call the generic callback for env var updates
        onEnvVarUpdated?.(editingEnvVar.name);

        onEnvVarSaved?.({
          name: editingEnvVar.name,
          var_type: editingEnvVar.var_type,
          description: newEnvVar.description !== undefined ? newEnvVar.description : editingEnvVar.description,
        });

        notify.success({
          title: 'Success',
          message: 'Environment variable updated successfully',
        });

        // Invalidate the query cache to update other components
        void queryClient.invalidateQueries({ queryKey: ['entity-env-table', entityTypeId.toString()] });
      } else {
        // Create new env var
        await entityEnv.create({
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
          title: 'Success',
          message: 'Environment variable created successfully',
        });

        // Invalidate the query cache to update other components
        void queryClient.invalidateQueries({ queryKey: ['entity-env-table', entityTypeId.toString()] });
      }
      setShowEditDialog(false);
    } catch (error: unknown) {
      let errorMessage = 'Unknown error occurred';

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        const errorObj = error as {
          response?: {
            data?: {
              detail?: string;
              message?: string;
            };
          };
          detail?: string;
          message?: string;
        };
        // Try to extract detailed error message from various possible response structures
        errorMessage =
          errorObj?.response?.data?.detail ||
          errorObj?.response?.data?.message ||
          errorObj?.detail ||
          errorObj?.message ||
          'Unknown error occurred';
      }

      notify.error({
        title: 'Error',
        message: errorMessage,
      });
    }
  };

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Environment Variables</h2>
        <Button
          onClick={() => {
            if (!user?.id) {
              notify.info({
                title: 'Login Required',
                message: 'Please login in order to add a new variable',
              });
            } else {
              setEditingEnvVar(null);
              setNewEnvVar({ var_type: EnvVarType.PLAIN }); // Default to PLAIN
              setShowEditDialog(true);
            }
          }}
          className="flex items-center gap-2"
        >
          <Plus className="h-4 w-4" />
          Add Variable
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-4 text-center text-neutral-500">Loading environment variables...</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
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

      {/* FlowPad API Key Section - Below Table */}
      <div className="mt-6 rounded-lg border border-neutral-200 bg-transparent p-4">
        <div className="mb-3">
          <h3 className="text-base font-semibold text-foreground">FlowPad API Key</h3>
          <p className="text-sm text-muted-foreground">
            {hasFlowPadApiKey
              ? 'Your API key for authenticating API requests to FlowPad'
              : 'Generate an API key to authenticate API requests to FlowPad'}
          </p>
        </div>

        {hasFlowPadApiKey && existingApiKey ? (
          /* Show existing API key details */
          <div className="space-y-3">
            <div className="rounded-md border border-neutral-300 bg-transparent p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Name:</span>
                <span className="font-mono text-sm text-foreground">{existingApiKey.name}</span>
              </div>
              {existingApiKey.description && (
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">Description:</span>
                  <span className="text-sm text-muted-foreground">{existingApiKey.description}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Value:</span>
                <span className="font-mono text-sm text-muted-foreground">{existingApiKey.visible_value}</span>
              </div>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                void handleDeleteApiKey(existingApiKey.name);
              }}
              className="flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Delete API Key
            </Button>
          </div>
        ) : (
          /* Show generate button */
          <Button
            variant="outline"
            onClick={() => {
              void handleGenerateApiKey();
            }}
            className="flex items-center gap-2"
          >
            <Key className="h-4 w-4" />
            Generate FlowPad API Key
          </Button>
        )}
      </div>

      {/* Display Generated API Key Below Table */}
      {generatedApiKey && (
        <div className="mt-6 rounded-lg border-2 border-yellow-500/50 bg-yellow-500/10 p-4">
          <div className="mb-3 flex items-center gap-2 rounded bg-yellow-500/20 p-2 text-sm">
            <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-500" />
            <strong className="text-foreground">Important:</strong>{' '}
            <span className="text-muted-foreground">
              Copy this API key now. For security reasons, it won&apos;t be shown again.
            </span>
          </div>
          <div className="flex gap-3">
            <Textarea
              value={generatedApiKey.api_key}
              readOnly
              className="flex-1 font-mono text-sm"
              style={{ fontFamily: 'Monaco, Menlo, Consolas, monospace' }}
              rows={2}
            />
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(generatedApiKey.api_key);
                notify.success({
                  title: 'Copied to Clipboard',
                  message: 'API key copied successfully',
                });
              }}
            >
              Copy to Clipboard
            </Button>
          </div>
        </div>
      )}

      {showEditDialog && (
        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editingEnvVar ? 'Edit' : 'Add'} Environment Variable</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Name (uppercase letters, numbers, and underscores only)</label>
                <Input
                  value={newEnvVar.name || ''}
                  onChange={(e) => setNewEnvVar({ ...newEnvVar, name: e.target.value.toUpperCase() })}
                  placeholder="VAR_NAME"
                  className="font-mono"
                  disabled={!!editingEnvVar}
                  title="Only uppercase letters, numbers, and underscores are allowed"
                />
              </div>

              {!editingEnvVar && (
                <div>
                  <label className="text-sm font-medium">Type</label>
                  <Select
                    value={newEnvVar.var_type || EnvVarType.PLAIN}
                    onValueChange={(value) => setNewEnvVar({ ...newEnvVar, var_type: value as EnvVarType })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select variable type" />
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
                <label className="text-sm font-medium">Description</label>
                <Textarea
                  value={newEnvVar.description || ''}
                  onChange={(e) => setNewEnvVar({ ...newEnvVar, description: e.target.value })}
                  placeholder="Description of this environment variable"
                  rows={2}
                />
              </div>

              {!editingEnvVar && (
                <div>
                  <label className="text-sm font-medium">
                    Value (max {MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters)
                  </label>
                  <Textarea
                    value={newEnvVar.value || ''}
                    onChange={(e) => setNewEnvVar({ ...newEnvVar, value: e.target.value })}
                    placeholder="Enter the variable value"
                    rows={3}
                    title={`Value must be ${MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters or less`}
                  />
                </div>
              )}
              {editingEnvVar && (
                <div>
                  <label className="text-sm font-medium">
                    New Value (optional, max {MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters)
                  </label>
                  <Textarea
                    value={newEnvVar.value || ''}
                    onChange={(e) => setNewEnvVar({ ...newEnvVar, value: e.target.value })}
                    placeholder="Leave empty to keep current value"
                    rows={3}
                    title={`Value must be ${MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters or less`}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEditDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  void handleSave();
                }}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
};

export default EnvVarsManager;
