import { useLingui } from '@lingui/react/macro';
import { CopilotIcon } from './CopilotIcon';

interface CopilotRestoreIconProps {
  className?: string;
}

/**
 * GitHub Copilot mark with a small restore arrow overlaid in the bottom-right
 * corner. Used to flag a process that resumed an existing session.
 */
export function CopilotRestoreIcon({ className }: CopilotRestoreIconProps) {
  const { t } = useLingui();
  return (
    <span className={`relative inline-flex ${className ?? ''}`} aria-label={t`GitHub Copilot (restored session)`}>
      <CopilotIcon className="h-full w-full" />
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
