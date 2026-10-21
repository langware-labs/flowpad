import { AlertTriangle } from 'lucide-react';
import { Plural } from '@lingui/react/macro';

export function ErrorAlertCard({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      className="bookmark-card w-full cursor-pointer border-destructive/30 bg-destructive/5 text-start transition-colors hover:bg-destructive/10"
      onClick={onClick}
    >
      <div className="bookmark-card-header">
        <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="bookmark-card-title text-destructive">
          <Plural value={count} one="You have # error to handle" other="You have # errors to handle" />
        </span>
      </div>
    </button>
  );
}
