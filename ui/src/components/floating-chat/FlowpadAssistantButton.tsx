import { useAgentContext } from '@src/contexts/agent-context';
import { Button } from '@src/components/ui/button';
import { BASE_PATH } from '@src/constants/basePath';
import { cn } from '@src/lib/utils';
import { useTheme } from 'next-themes';
import { useRef } from 'react';
import { useFloatingChat } from './FloatingChatContext';

function isAbsoluteUrl(url: string) {
  return /^https?:\/\//i.test(url);
}

/**
 * Round flowpad-logo button that toggles the global floating Flowpad Assistant chat.
 * Sized + styled to match the theme-toggle and user avatar buttons in the header.
 *
 * Captures its on-screen rect on click so the floating window can animate from
 * the button position into center (and back to it on close).
 */
export function FlowpadAssistantButton() {
  const { agent } = useAgentContext();
  const siteConfig = agent?.site_config;
  const { resolvedTheme } = useTheme();
  const { open, toggle } = useFloatingChat();
  const ref = useRef<HTMLButtonElement | null>(null);

  const branded = siteConfig?.branding?.logo_url;
  const src = branded
    ? isAbsoluteUrl(branded)
      ? branded
      : `${BASE_PATH}${branded}`
    : 'logo.png';

  const invert =
    !!branded && resolvedTheme === 'dark' && !!siteConfig?.branding?.use_brightness_filter;

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
        src={src}
        alt={siteConfig?.branding?.company_name || 'Flowpad Assistant'}
        className={cn('h-full w-full object-contain', invert && 'brightness-0 invert')}
      />
    </Button>
  );
}
