import { Button } from '@src/components/ui/button';
import { BASE_PATH } from '@src/constants/basePath';
import { cn } from '@src/lib/utils';
import { useRef } from 'react';
import { useFloatingChat } from './FloatingChatContext';

/**
 * Round flowpad-logo button that toggles the global floating Flowpad Assistant chat.
 * Sized + styled to match the theme-toggle and user avatar buttons in the header.
 *
 * Captures its on-screen rect on click so the floating window can animate from
 * the button position into center (and back to it on close).
 *
 * The button always renders the dedicated round Flowpad icon
 * (`ui/public/flowpad-icon.png`) — agents may ship their own wordmark via
 * `site_config.branding.logo_url`, but a wide wordmark crops badly inside a
 * 32×32 round chip, so we keep the assistant button visually anchored to the
 * Flowpad brand here regardless of the active agent.
 */
export function FlowpadAssistantButton() {
  const { open, toggle } = useFloatingChat();
  const ref = useRef<HTMLButtonElement | null>(null);

  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => {
        const r = ref.current?.getBoundingClientRect();
        toggle(r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null);
      }}
      aria-pressed={open}
      title="Flowpad Assistant"
      data-testid="flowpad-assistant-button"
      className={cn(
        'h-8 w-8 overflow-hidden rounded-full p-0',
        open && 'bg-accent text-accent-foreground',
      )}
    >
      <img
        src={`${BASE_PATH}flowpad-icon.png`}
        alt="Flowpad Assistant"
        className="h-full w-full object-contain"
      />
    </Button>
  );
}
