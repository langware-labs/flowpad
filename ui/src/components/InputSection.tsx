import { trackEvent } from '@src/utils/analytics';
import { TypeId, navigator } from '@sdk';
import { ContentCard } from '@src/components/ui/content-card';
import { useToast } from '@src/hooks/use-toast';
import { ContentCardAction } from '@src/components/ui/content-card';
import { ContentCardActionButton } from '@src/components/ui/content-card';
import { ContentCardBody } from '@src/components/ui/content-card';
import { ContentCardContainer } from '@src/components/ui/content-card';
import { ContentCardHeader } from '@src/components/ui/content-card';
import { ContentCardIcon } from '@src/components/ui/content-card';
import { ContentCardSubtext } from '@src/components/ui/content-card';
import { ContentCardTitle } from '@src/components/ui/content-card';
import { useAuth, useOAuthConnection } from '@sdk/react/hooks';
import { Check, LogIn, Plug } from 'lucide-react';
import { useState } from 'react';

interface InputSectionProps {
  input: {
    type: string;
    'provider-name': string;
  };
  readOnly?: boolean;
  className?: string;
  currentProject?: TypeId;
}

const InputSection = ({ input, readOnly, className, currentProject }: InputSectionProps) => {
  const [isConnected, setIsConnected] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();

  // Use the OAuth connection hook
  const { isConnecting, connect } = useOAuthConnection({
    currentProject,
    onConnectionConnect: () => {
      setIsConnected(true);
      trackEvent({
        event: 'oauth_connected',
      });
    },
  });

  const handleConnect = async () => {
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
      await connect('', input['provider-name']);
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

  if (isConnected) {
    return (
      <ContentCard className={className} clickable={false}>
        <ContentCardContainer>
          <ContentCardIcon>
            <Check className="h-4 w-4" />
          </ContentCardIcon>
          <ContentCardBody>
            <ContentCardHeader>
              <ContentCardTitle>{input['provider-name']}</ContentCardTitle>
            </ContentCardHeader>
            <ContentCardSubtext>OAuth connection established successfully</ContentCardSubtext>
          </ContentCardBody>
        </ContentCardContainer>
      </ContentCard>
    );
  }

  if (readOnly) {
    return (
      <ContentCard className={className} clickable={false}>
        <ContentCardContainer>
          <ContentCardIcon>
            <Plug className="h-4 w-4" />
          </ContentCardIcon>
          <ContentCardBody>
            <ContentCardHeader>
              <ContentCardTitle>OAuth Connection Required</ContentCardTitle>
            </ContentCardHeader>
            <ContentCardSubtext>{input['provider-name']}</ContentCardSubtext>
          </ContentCardBody>
        </ContentCardContainer>
      </ContentCard>
    );
  }

  return (
    <ContentCard className={className} clickable={false}>
      <ContentCardContainer>
        <ContentCardIcon>
          <Plug className="h-4 w-4" />
        </ContentCardIcon>
        <ContentCardBody>
          <ContentCardHeader>
            <ContentCardTitle>{input['provider-name']}</ContentCardTitle>
          </ContentCardHeader>
          <ContentCardSubtext>Connect to {input['provider-name']} to continue</ContentCardSubtext>
        </ContentCardBody>
        <ContentCardAction>
          {user?.id ? (
            <ContentCardActionButton
              variant="default"
              onClick={() => {
                void handleConnect();
              }}
              disabled={isConnecting}
              className="w-[110px]"
            >
              {isConnecting ? 'Connecting...' : 'Connect'}
            </ContentCardActionButton>
          ) : (
            <ContentCardActionButton
              onClick={() => {
                trackEvent({ event: 'login_clicked', event_source: 'input_section' });
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
};

export default InputSection;
