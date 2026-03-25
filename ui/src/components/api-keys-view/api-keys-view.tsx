import { ActionInfo, ApiKeyCredentials, dataManager } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Textarea } from '@src/components/ui/textarea';
import { useToast } from '@src/hooks/use-toast';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { AlertCircle, Copy, Key, Trash2 } from 'lucide-react';
import React, { useState } from 'react';

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

export function ApiKeysView() {
  const [generatedApiKey, setGeneratedApiKey] = useState<ApiKeyCredentials | null>(null);
  const [hasFlowPadApiKey, setHasFlowPadApiKey] = useState(false);
  const [apiKeysReloadTrigger, setApiKeysReloadTrigger] = useState(0);
  const [userApiKeys, setUserApiKeys] = useState<ApiKeyListItem[]>([]);
  const { toast } = useToast();
  const { user } = useAuth();

  // Load API keys from the user
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
  }, [user?.typeId, apiKeysReloadTrigger]);

  // Check if there's already a FlowPad API key (only active keys)
  // if there's no active key, show the generate button; if there is one, show the delete button.
  const existingApiKey = React.useMemo(() => {
    return userApiKeys.find((apiKey) => apiKey.name.includes('FLOWPAD_API_KEY') && apiKey.is_active);
  }, [userApiKeys]);

  React.useEffect(() => {
    setHasFlowPadApiKey(!!existingApiKey);
  }, [existingApiKey]);

  const handleGenerateApiKey = async () => {
    if (!user?.typeId) {
      toast({
        title: 'Error',
        description: 'User not found',
        variant: 'destructive',
      });
      return;
    }

    try {
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

      toast({
        title: 'API Key Generated',
        description: 'Your new API key has been created. Please save it securely.',
      });
    } catch (error) {
      console.error('Failed to generate API key:', error);

      let errorMessage = 'Failed to generate API key';
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      toast({
        title: 'API Key Generation',
        description: errorMessage,
        variant: 'destructive',
      });
    }
  };

  const handleDeleteApiKey = async (keyName: string) => {
    if (!user?.typeId) {
      toast({
        title: 'Error',
        description: 'User not found',
        variant: 'destructive',
      });
      return;
    }

    try {
      const actionInfo = new ActionInfo('api-keys', user.typeId.type, user.typeId.id, 'DELETE');
      actionInfo.subpath = [keyName];
      await dataManager.callAction(actionInfo);

      // Optimistically update: remove the deleted key from state immediately
      setUserApiKeys((prev) => prev.filter((key) => key.name !== keyName));

      // Clear the generated API key display if visible
      setGeneratedApiKey(null);

      // Reload API keys list by triggering useEffect dependency
      setApiKeysReloadTrigger((prev) => prev + 1);

      toast({
        title: 'API Key Deleted',
        description: 'API key has been removed successfully',
      });
    } catch (error) {
      console.error('Failed to delete API key:', error);

      let errorMessage = 'Failed to delete API key';
      if (error instanceof Error) {
        errorMessage = error.message;
      }

      toast({
        title: 'API Key Deletion',
        description: errorMessage,
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-4">
        <div className="max-w-4xl space-y-6">
          {/* Header */}
          <div>
            <h2 className="text-2xl font-bold text-foreground">API Keys</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage your FlowPad API keys for authenticating API requests
            </p>
          </div>

          {/* Main API Key Section */}
          <div className="rounded-lg border border-gray-200 bg-transparent p-6">
            <div className="mb-4">
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
                <div className="rounded-md border border-gray-300 bg-transparent p-4">
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

          {/* Display Generated API Key */}
          {generatedApiKey && (
            <div className="rounded-lg border-2 border-yellow-500/50 bg-yellow-500/10 p-4">
              <div className="mb-3 flex items-center gap-2 rounded bg-yellow-500/20 p-2 text-sm">
                <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-500" />
                <strong className="text-foreground">Important:</strong>{' '}
                <span className="text-muted-foreground">Save this API key now. You won't be able to see it again!</span>
              </div>
              <div className="flex gap-3">
                <Textarea
                  value={generatedApiKey.api_key}
                  readOnly
                  className="flex-1 font-mono text-sm"
                  style={{ fontFamily: 'Monaco, Menlo, Consolas, monospace' }}
                  rows={3}
                />
                <Button
                  onClick={() => {
                    void navigator.clipboard.writeText(generatedApiKey.api_key);
                    toast({
                      title: 'Copied to Clipboard',
                      description: 'API key copied successfully',
                    });
                  }}
                  variant="outline"
                  size="sm"
                  className="flex items-center gap-2"
                >
                  <Copy className="h-4 w-4" />
                  Copy
                </Button>
              </div>
            </div>
          )}

          {/* API Keys List */}
          {userApiKeys.length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-transparent">
              <div className="border-b border-gray-200 p-4">
                <h3 className="text-base font-semibold text-foreground">Your API Keys</h3>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userApiKeys.map((apiKey) => (
                    <TableRow key={apiKey.id}>
                      <TableCell className="font-mono text-sm text-foreground">{apiKey.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{apiKey.description || '-'}</TableCell>
                      <TableCell>
                        <span className="font-mono text-sm text-muted-foreground">{apiKey.visible_value}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={apiKey.is_active ? 'default' : 'secondary'}>
                          {apiKey.is_active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDeleteApiKey(apiKey.name)}
                          disabled={!apiKey.is_active}
                          className="flex items-center gap-1"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
