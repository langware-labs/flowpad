import { Button } from '@src/components/ui/button';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router';

const ConversationNotFoundScreen = () => {
  const navigate = useNavigate();

  const handleGoBack = () => {
    navigate('/dock/inbox');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md rounded-lg border bg-card p-8 text-center shadow-md">
        <div className="mb-6">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <MessageCircle className="h-8 w-8 text-muted-foreground" />
          </div>
          <h1 className="mb-2 text-2xl font-bold text-foreground">404 - Conversation Not Found</h1>
          <p className="text-muted-foreground">
            The conversation you're looking for doesn't exist or you don't have access to it.
          </p>
        </div>

        <Button onClick={handleGoBack} className="flex w-full items-center justify-center">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Inbox
        </Button>
      </div>
    </div>
  );
};

export default ConversationNotFoundScreen;
