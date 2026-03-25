import { useWarnings } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@src/components/ui/card';
import { CheckCircle2, Key, Loader2, Shield, User, Building2 } from 'lucide-react';
import React from 'react';

interface AuthStatusBadgeProps {
  authMethod: 'oauth' | 'api_key' | 'none';
  isAuthenticated: boolean;
}

const AuthStatusBadge: React.FC<AuthStatusBadgeProps> = ({ authMethod, isAuthenticated }) => {
  if (!isAuthenticated) {
    return <Badge variant="destructive">Not Configured</Badge>;
  }

  if (authMethod === 'oauth') {
    return (
      <Badge variant="default" className="bg-green-600">
        <Shield className="mr-1 h-3 w-3" />
        OAuth
      </Badge>
    );
  }

  return (
    <Badge variant="secondary">
      <Key className="mr-1 h-3 w-3" />
      API Key
    </Badge>
  );
};

interface SubscriptionBadgeProps {
  subscriptionType: string | null;
}

const SubscriptionBadge: React.FC<SubscriptionBadgeProps> = ({ subscriptionType }) => {
  if (!subscriptionType) return null;

  const variants: Record<string, 'default' | 'secondary' | 'outline'> = {
    max: 'default',
    pro: 'secondary',
    free: 'outline',
  };

  return (
    <Badge variant={variants[subscriptionType.toLowerCase()] || 'outline'} className="capitalize">
      {subscriptionType}
    </Badge>
  );
};

export const ClaudeAuthStatus: React.FC = () => {
  const { claudeCodeAuth, isLlmConfigured } = useWarnings();

  const handleConfigureClick = () => {
    window.dispatchEvent(new CustomEvent('open-desktop-setup'));
  };

  // Loading state
  if (claudeCodeAuth === null && !isLlmConfigured) {
    return (
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="h-5 w-5" />
            Claude Code Authentication
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Checking authentication status...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const auth = claudeCodeAuth;
  const isAuthenticated = auth?.is_authenticated ?? false;
  const authMethod = auth?.auth_method ?? 'none';
  const oauthInfo = auth?.oauth_info;
  const apiKeyInfo = auth?.api_key_info;
  const userProfile = auth?.user_profile;
  const subscriptionType = oauthInfo?.subscription_type || null;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Shield className="h-5 w-5" />
              Claude Code Authentication
            </CardTitle>
            <CardDescription className="mt-1">Authentication status for Claude Code integration</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <AuthStatusBadge authMethod={authMethod} isAuthenticated={isAuthenticated} />
            {subscriptionType && <SubscriptionBadge subscriptionType={subscriptionType} />}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isAuthenticated ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Claude Code is not configured. Configure authentication to enable AI-powered features.
            </p>
            <Button variant="default" size="sm" onClick={handleConfigureClick}>
              <Key className="mr-1.5 h-4 w-4" />
              Configure Claude Code
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* OAuth Info */}
            {authMethod === 'oauth' && oauthInfo && (
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="font-medium">OAuth Authentication Active</span>
                </div>

                {userProfile && (
                  <div className="space-y-2 text-sm">
                    {userProfile.email && (
                      <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Email:</span>
                        <span>{userProfile.email}</span>
                      </div>
                    )}
                    {userProfile.organization_name && (
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="text-muted-foreground">Organization:</span>
                        <span>{userProfile.organization_name}</span>
                      </div>
                    )}
                  </div>
                )}

                {oauthInfo.is_expired && (
                  <div className="mt-3 rounded-md bg-yellow-500/10 p-2 text-sm text-yellow-600">
                    Token expired. Please re-authenticate.
                  </div>
                )}
              </div>
            )}

            {/* API Key Info */}
            {authMethod === 'api_key' && apiKeyInfo && (
              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Key className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">API Key Authentication</span>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Key:</span>
                    <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{apiKeyInfo.key_prefix}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Source:</span>
                    <span className="capitalize">{apiKeyInfo.source.replace('_', ' ')}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Source info */}
            {auth?.credentials_source && (
              <div className="text-xs text-muted-foreground">
                Credentials source: {auth.credentials_source.replace('_', ' ')}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
