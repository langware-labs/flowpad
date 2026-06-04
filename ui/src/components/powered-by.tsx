import flowpadLogo from '@src/assets/logo.png';
import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';

interface PoweredByProps {
  className?: string;
}

// Single-click and double-click are disambiguated with a short timer: a single
// click defers its action so a following click can cancel it and run the
// double-click action instead. Without this, the anchor's default navigation
// fires on the first click of a double-click and both behaviors trigger.
const DOUBLE_CLICK_DELAY = 250;

export function PoweredBy({ className = '' }: PoweredByProps) {
  const { resolvedTheme } = useTheme();
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  return (
    <div className={`flex items-end ${className}`}>
      <span className="mr-2 text-[10px] text-muted-foreground">Powered by</span>
      <a
        href="https://flowpad.ai"
        onClick={(e) => {
          e.preventDefault();
          if (clickTimer.current) clearTimeout(clickTimer.current);
          clickTimer.current = setTimeout(() => {
            clickTimer.current = null;
            window.location.href = 'https://flowpad.ai';
          }, DOUBLE_CLICK_DELAY);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          if (clickTimer.current) {
            clearTimeout(clickTimer.current);
            clickTimer.current = null;
          }
          window.open(window.location.href, '_blank', 'noopener,noreferrer');
        }}
      >
        <img
          src={flowpadLogo}
          alt="Flowpad.ai Logo"
          className={`h-4 ${resolvedTheme === 'dark' ? 'brightness-0 invert' : ''}`}
        />
      </a>
    </div>
  );
}
