import flowpadLogo from '@src/assets/logo.png';
import { useTheme } from 'next-themes';

interface PoweredByProps {
  className?: string;
}

export function PoweredBy({ className = '' }: PoweredByProps) {
  const { resolvedTheme } = useTheme();

  return (
    <div className={`flex items-end ${className}`}>
      <span className="mr-2 text-[10px] text-muted-foreground">Powered by</span>
      <a href="https://flowpad.ai">
        <img
          src={flowpadLogo}
          alt="Flowpad.ai Logo"
          className={`h-4 ${resolvedTheme === 'dark' ? 'brightness-0 invert' : ''}`}
        />
      </a>
    </div>
  );
}
