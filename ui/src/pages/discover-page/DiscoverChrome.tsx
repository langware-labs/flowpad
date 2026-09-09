import { useLingui } from '@lingui/react/macro';
import flowpadLogo from '@src/assets/logo.png';
import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { useNavigate } from 'react-router';

/** The top-level page chrome Discover and its detail route share. */
export function DiscoverChrome() {
  const { t } = useLingui();
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/80 px-4 py-2 backdrop-blur-xl">
      <button onClick={() => void navigate('/')} aria-label={t`Back to home`} className="flex items-center">
        <img src={flowpadLogo} alt={t`Flowpad`} className="max-h-7 object-contain dark:brightness-0 dark:invert" />
      </button>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <UserDropdown />
      </div>
    </header>
  );
}
