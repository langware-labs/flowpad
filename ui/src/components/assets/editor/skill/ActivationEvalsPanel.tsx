import { FlaskConical } from 'lucide-react';

export function ActivationEvalsPanel() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 items-center border-b bg-muted/30 px-3">
        <span className="text-xs text-muted-foreground">Evals</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <FlaskConical className="h-16 w-16 text-muted-foreground/50" />
        <p className="mt-4 text-lg text-muted-foreground">Evals Coming Soon</p>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          Test your activation rules with sample conversations and hook data to verify they trigger correctly.
        </p>
      </div>
    </div>
  );
}
