import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import { useLingui } from '@lingui/react/macro';

import { Button } from '@src/components/ui/button';

/**
 * Simple light/dark theme toggle button.
 * Note: 'system' theme option is kept in the codebase for future use,
 * but this component only toggles between light and dark.
 */
export function ThemeToggle() {
  const { t } = useLingui();
  const { resolvedTheme, setTheme } = useTheme();

  const toggleTheme = () => {
    // Simple toggle between light and dark
    // 'system' option is available in setTheme but not exposed in this UI
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={toggleTheme}
      title={resolvedTheme === 'dark' ? t`Switch to light mode` : t`Switch to dark mode`}
    >
      {resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span className="sr-only">{t`Toggle theme`}</span>
    </Button>
  );
}
