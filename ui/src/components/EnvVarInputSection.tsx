import { useEnvVarsStore } from '@src/hooks/use-env-vars-store';
import { trackEvent } from '@src/utils/analytics';
import { EntityEnv, EnvVarType, navigator } from '@sdk';
import { ContentCard } from '@src/components/ui/content-card';
import { Input } from '@src/components/ui/input';
import { useToast } from '@src/hooks/use-toast';
import { ContentCardAction } from '@src/components/ui/content-card';
import { ContentCardActionButton } from '@src/components/ui/content-card';
import { ContentCardBody } from '@src/components/ui/content-card';
import { ContentCardContainer } from '@src/components/ui/content-card';
import { ContentCardHeader } from '@src/components/ui/content-card';
import { ContentCardIcon } from '@src/components/ui/content-card';
import { ContentCardSubtext } from '@src/components/ui/content-card';
import { ContentCardTitle } from '@src/components/ui/content-card';
import { ViewType } from '@src/types/ViewType';
import { useViewerStore } from '@src/hooks/flow-hooks';
import { useAuth, useOAuthConnection, useProject } from '@sdk/react/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Key, LogIn, Plug } from 'lucide-react';
import { useCallback, useState } from 'react';
import { MAX_ENV_VAR_VALUE_LENGTH } from '../constants/validation';

interface EnvVarInputSectionProps {
  envVarInput: {
    name: string;
    description?: string;
    var_type?: EnvVarType; // Type requested by LLM, defaults to API_KEY if not specified
  };
  timestamp?: string;
  onEnvVarSaved?: (envVar: { name: string; var_type: EnvVarType; description: string }) => void;
  onEnvVarUpdated?: (envVarName: string) => void;
  readOnly?: boolean;
  className?: string;
}

const EnvVarInputSection = ({
  envVarInput,
  timestamp,
  onEnvVarSaved,
  onEnvVarUpdated,
  readOnly,
  className,
}: EnvVarInputSectionProps) => {
  const [envVarValue, setEnvVarValue] = useState('');
  const { envVars, addEnvVar, openEnvironmentTab } = useEnvVarsStore();
  const [isLoading, setIsLoading] = useState(false);
  const [isOAuthConnected, setIsOAuthConnected] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();
  const { project } = useProject();
  const queryClient = useQueryClient();

  // Import the viewer store to access tab navigation
  const { setActiveTab } = useViewerStore();

  // Function to open the connections tab (it's a dedicated tab)
  const openConnectionsTab = () => {
    // Use the correct tab value for connections
    setActiveTab(ViewType.CONNECTIONS);
  };

  // Default to API_KEY if no type specified (when LLM requests an env var without specifying type)
  const varType = envVarInput.var_type || EnvVarType.API_KEY;

  // Memoize the OAuth connection callbacks to prevent unnecessary re-renders and event listener churn
  const handleConnectionConnect = useCallback(async () => {
    setIsOAuthConnected(true);
    onEnvVarUpdated?.(envVarInput.name);

    // Only invalidate if we have valid IDs to prevent unnecessary calls
    const projectId = project?.typeId?.toString();
    const userId = user?.typeId?.toString();

    if (projectId && userId) {
      // Invalidate both queries in parallel to reduce the number of separate calls
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['entity-env-table', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['entity-env-table', userId] }),
      ]);
    }

    trackEvent({
      event: 'oauth_connected',
      event_source: 'env_var_input',
    });
  }, [envVarInput.name, onEnvVarUpdated, project?.typeId, user?.typeId, queryClient]);

  const handleAttachSuccess = useCallback(async () => {
    setIsOAuthConnected(true);

    // This fires when the OAuth token is successfully attached/shared with the project
    const projectId = project?.typeId?.toString();
    const userId = user?.typeId?.toString();

    if (projectId && userId) {
      // Invalidate both queries in parallel to reduce the number of separate calls
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['entity-env-table', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['entity-env-table', userId] }),
      ]);
    }
  }, [project?.typeId, user?.typeId, queryClient]);

  // Use the OAuth connection hook for OAUTH_TOKEN types
  const { isConnecting, connect } = useOAuthConnection({
    currentProject: project?.typeId,
    onConnectionConnect: () => {
      void handleConnectionConnect();
    },
    onAttachSuccess: () => {
      void handleAttachSuccess();
    },
  });

  // Note: No need to invalidate on mount - the env var creation should trigger
  // the necessary invalidations through the normal flow

  // Clear naming: this is when the LLM message was created (fixed, doesn't change on refresh)
  const messageTimestamp = timestamp;

  // Check if env var exists on server
  const envVarExists = envVars.some((envVar) => envVar.name === envVarInput.name);

  // Get the timestamp when this env var was last resolved (user provided it)
  const getLastResolvedTimestamp = () => {
    try {
      const stored = localStorage.getItem(`envvar_resolved_${project?.typeId?.id}_${envVarInput.name}`);
      return stored || null;
    } catch {
      return null;
    }
  };

  // Helper to compare timestamp strings properly
  const isTimestampNewer = (timestamp1: string, timestamp2: string): boolean => {
    return new Date(timestamp1) > new Date(timestamp2);
  };

  // Show as open if:
  // - Env var doesn't exist on server, OR
  // - This component's MESSAGE timestamp is newer than when env var was last resolved
  const lastResolvedTimestamp = getLastResolvedTimestamp();

  const shouldShowOpen =
    !envVarExists ||
    (messageTimestamp && (!lastResolvedTimestamp || isTimestampNewer(messageTimestamp, lastResolvedTimestamp)));

  const [isSubmitted, setIsSubmitted] = useState(!shouldShowOpen);

  const handleValueInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEnvVarValue(e.target.value);
  };

  const handleValueKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  // Create unique IDs for this component instance
  const uniqueId = `envvar-${envVarInput.name}-${Date.now()}`;
  const valueId = `value-${uniqueId}`;

  const validateEnvVarName = (name: string): boolean => {
    return /^[A-Za-z0-9_]+$/.test(name);
  };

  const validateEnvVarValue = (value: string): boolean => {
    return value.length <= MAX_ENV_VAR_VALUE_LENGTH;
  };

  const handleOAuthConnect = async () => {
    // Check if user is authenticated
    if (!user?.id) {
      toast({
        title: 'Authentication Required',
        description: 'Please login to connect to the OAuth provider.',
        variant: 'default',
      });
      return;
    }

    try {
      await connect('', envVarInput.name, envVarInput.name);
    } catch (error: unknown) {
      console.error('Error connecting to OAuth provider:', error);
      let errorMessage = 'Failed to connect to the OAuth provider. Please try again.';
      if (error instanceof Error) {
        errorMessage = error.message;
      }
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive',
      });
    }
  };

  const handleSubmit = async () => {
    if (!envVarValue.trim()) return;

    // Check if user is authenticated
    if (!user?.id) {
      toast({
        title: 'Authentication Required',
        description: 'Please login to save the environment variable.',
        variant: 'default',
      });
      return;
    }

    if (!validateEnvVarName(envVarInput.name)) {
      toast({
        title: 'Error',
        description: 'Environment variable name must contain only letters, numbers, and underscores',
        variant: 'destructive',
      });
      return;
    }

    if (!validateEnvVarValue(envVarValue)) {
      toast({
        title: 'Error',
        description: `Environment variable value is too long (max ${MAX_ENV_VAR_VALUE_LENGTH.toLocaleString()} characters)`,
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    try {
      const projectTypeId = project?.typeId;
      // Save the env var to the project
      if (!projectTypeId) {
        console.error('Project ID is required to save the environment variable');
        return;
      }

      const entityEnv = new EntityEnv(projectTypeId);
      // Call update - the env var entry is auto-created by the backend when the LLM generates the flow-env-var tag
      await entityEnv.update(envVarInput.name, {
        var_type: varType,
        description: envVarInput.description || '',
        value: envVarValue,
      });

      // Call the generic callback for env var updates
      onEnvVarUpdated?.(envVarInput.name);

      // Invalidate the env vars query to refresh the environment tab
      void queryClient.invalidateQueries({ queryKey: ['entity-env-table', project?.typeId?.toString()] });

      toast({
        title: 'Success',
        description: `Environment variable "${envVarInput.name}" has been saved and is now available in the Environment tab.`,
      });

      const envVarWithoutValue = {
        name: envVarInput.name,
        var_type: varType,
        description: envVarInput.description || '',
      };
      // Add the env var to state
      addEnvVar(envVarWithoutValue);
      // Call the optional onEnvVarSaved callback
      onEnvVarSaved?.(envVarWithoutValue);
      // Set the submitted state to true
      setIsSubmitted(true);

      // Store the CURRENT timestamp as resolved (when user actually clicked Save)
      const currentTimestamp = new Date().toISOString();
      try {
        localStorage.setItem(`envvar_resolved_${projectTypeId.id}_${envVarInput.name}`, currentTimestamp);
      } catch {
        // localStorage not available, continue without storing
      }
    } catch (error: unknown) {
      console.error('Error saving environment variable:', error);

      let errorMessage = 'Failed to save the environment variable. Please try again.';

      // Handle AxiosError specifically
      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as {
          response?: {
            data?:
              | {
                  detail?: string;
                  message?: string;
                  error?: string;
                }
              | string;
          };
          message?: string;
        };

        // Try to get the error message from the response data
        const responseData = axiosError.response?.data;
        if (responseData) {
          if (typeof responseData === 'string') {
            errorMessage = responseData;
          } else if (responseData.detail) {
            errorMessage = responseData.detail;
          } else if (responseData.message) {
            errorMessage = responseData.message;
          } else if (responseData.error) {
            errorMessage = responseData.error;
          }
        }
      }
      // Check if error has detail directly
      else if (error && typeof error === 'object' && 'detail' in error) {
        errorMessage = (error as { detail: string }).detail;
      }
      // Check if it's a regular Error object
      else if (error instanceof Error) {
        errorMessage = error.message;
      }

      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // For OAuth tokens that are already connected
  if ((isSubmitted || isOAuthConnected) && varType === EnvVarType.OAUTH_TOKEN) {
    return (
      <ContentCard className={className} clickable={false}>
        <ContentCardContainer>
          <ContentCardIcon>
            <Check className="h-4 w-4" />
          </ContentCardIcon>
          <ContentCardBody>
            <ContentCardHeader>
              <ContentCardTitle>{envVarInput.name}</ContentCardTitle>
            </ContentCardHeader>
            <ContentCardSubtext>OAuth connection established successfully</ContentCardSubtext>
          </ContentCardBody>
          <ContentCardAction>
            <ContentCardActionButton onClick={openConnectionsTab}>Connections tab</ContentCardActionButton>
          </ContentCardAction>
        </ContentCardContainer>
      </ContentCard>
    );
  }

  // For non-OAuth env vars that are submitted
  if (isSubmitted) {
    return (
      <ContentCard className={className} clickable={false}>
        <ContentCardContainer>
          <ContentCardIcon>
            <Check className="h-4 w-4" />
          </ContentCardIcon>
          <ContentCardBody>
            <ContentCardHeader>
              <ContentCardTitle>{envVarInput.name}</ContentCardTitle>
            </ContentCardHeader>
            <ContentCardSubtext>Environment variable provided successfully</ContentCardSubtext>
          </ContentCardBody>
          <ContentCardAction>
            <ContentCardActionButton onClick={openEnvironmentTab}>Environment tab</ContentCardActionButton>
          </ContentCardAction>
        </ContentCardContainer>
      </ContentCard>
    );
  }

  if (readOnly) {
    const icon = varType === EnvVarType.OAUTH_TOKEN ? <Plug className="h-4 w-4" /> : <Key className="h-4 w-4" />;
    const title = varType === EnvVarType.OAUTH_TOKEN ? 'OAuth Connection Required' : 'Environment Variable Requested';

    return (
      <ContentCard className={className} clickable={false}>
        <ContentCardContainer>
          <ContentCardIcon>{icon}</ContentCardIcon>
          <ContentCardBody>
            <ContentCardHeader>
              <ContentCardTitle>{title}</ContentCardTitle>
            </ContentCardHeader>
            <ContentCardSubtext>{envVarInput.name}</ContentCardSubtext>
          </ContentCardBody>
        </ContentCardContainer>
      </ContentCard>
    );
  }

  // For OAuth tokens, show the Connect button
  if (varType === EnvVarType.OAUTH_TOKEN) {
    return (
      <ContentCard className={className} clickable={false}>
        <ContentCardContainer>
          <ContentCardIcon>
            <Plug className="h-4 w-4" />
          </ContentCardIcon>
          <ContentCardBody>
            <ContentCardHeader>
              <ContentCardTitle>{envVarInput.name}</ContentCardTitle>
            </ContentCardHeader>
            <ContentCardSubtext>
              {envVarInput.description || `Connect to ${envVarInput.name} to continue`}
            </ContentCardSubtext>
          </ContentCardBody>
          <ContentCardAction>
            {user?.id ? (
              <ContentCardActionButton
                variant="default"
                onClick={() => {
                  void handleOAuthConnect();
                }}
                disabled={isConnecting}
                className="w-[110px]"
              >
                {isConnecting ? 'Connecting...' : 'Connect'}
              </ContentCardActionButton>
            ) : (
              <ContentCardActionButton
                onClick={() => {
                  trackEvent({ event: 'login_clicked', event_source: 'envvar_oauth' });
                  navigator.navigateToLogin();
                }}
                className="flex w-[110px] items-center gap-2"
              >
                <LogIn className="h-4 w-4" />
                Login
              </ContentCardActionButton>
            )}
          </ContentCardAction>
        </ContentCardContainer>
      </ContentCard>
    );
  }

  // For non-OAuth env vars, show the input field
  return (
    <ContentCard className={className} clickable={false}>
      <ContentCardContainer>
        <ContentCardIcon>
          <Key className="h-4 w-4" />
        </ContentCardIcon>
        <ContentCardBody>
          <ContentCardHeader>
            <ContentCardTitle>{envVarInput.name}</ContentCardTitle>
          </ContentCardHeader>
          <ContentCardSubtext>{envVarInput.description}</ContentCardSubtext>
          <div className="mt-2 flex justify-between gap-2">
            <Input
              id={valueId}
              type="text"
              value={envVarValue}
              onChange={handleValueInput}
              onKeyPress={handleValueKeyPress}
              placeholder={user?.id ? 'Enter the environment variable value' : 'Please login to enter value'}
              className={!user?.id ? 'cursor-not-allowed' : ''}
              autoComplete="off"
              disabled={!user?.id}
            />
            <ContentCardAction>
              {user?.id ? (
                <ContentCardActionButton
                  variant="default"
                  onClick={() => {
                    void handleSubmit();
                  }}
                  disabled={!envVarValue.trim() || isLoading}
                >
                  Save
                </ContentCardActionButton>
              ) : (
                <ContentCardActionButton
                  onClick={() => {
                    trackEvent({ event: 'login_clicked', event_source: 'envvar_input' });
                    navigator.navigateToLogin();
                  }}
                  className="flex items-center gap-2"
                >
                  <LogIn className="h-4 w-4" />
                  Login
                </ContentCardActionButton>
              )}
            </ContentCardAction>
          </div>
        </ContentCardBody>
      </ContentCardContainer>
    </ContentCard>
  );
};

export default EnvVarInputSection;
