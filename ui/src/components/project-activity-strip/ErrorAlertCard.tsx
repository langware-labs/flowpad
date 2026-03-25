import { AlertTriangle } from 'lucide-react';

export function ErrorAlertCard({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className="bookmark-card w-full cursor-pointer border-destructive/30 bg-destructive/5 text-left transition-colors hover:bg-destructive/10"
      onClick={onClick}
    >
      <div className="bookmark-card-header">
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="bookmark-card-title text-destructive">
          You have {count} error{count !== 1 ? 's' : ''} to handle
        </span>
      </div>
    </button>
  );
}
