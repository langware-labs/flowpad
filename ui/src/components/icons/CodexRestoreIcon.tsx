import { CodexIcon } from './CodexIcon';

interface CodexRestoreIconProps {
  className?: string;
}

/**
 * Codex sunburst with a small "restore" rotate arrow overlaid in the bottom-
 * right corner. Used to flag an AgenticProcess that resumed a prior
 * session_id (as opposed to a fresh-start CodexIcon).
 */
export function CodexRestoreIcon({ className }: CodexRestoreIconProps) {
  return (
    <span className={`relative inline-flex ${className ?? ''}`} aria-label="Codex (restored session)">
      <CodexIcon className="h-full w-full" />
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="absolute -bottom-0.5 -right-0.5 h-[55%] w-[55%] rounded-full bg-background p-px"
        aria-hidden="true"
      >
        <path d="M3 12a9 9 0 1 0 9-9" />
        <path d="M3 4v5h5" />
      </svg>
    </span>
  );
}
