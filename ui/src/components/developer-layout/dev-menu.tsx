import { Button } from '@src/components/ui/button';
import { Terminal as TerminalIcon, Webhook } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Trans } from '@lingui/react/macro';

interface DevMenuItem {
  path: string;
  icon: React.ReactNode;
  label: string;
}

const DEV_MENU_ITEMS: DevMenuItem[] = [
  {
    path: '/main',
    icon: <TerminalIcon className="me-2 h-4 w-4" />,
    label: 'Sessions',
  },
  {
    path: '/hooks',
    icon: <Webhook className="me-2 h-4 w-4" />,
    label: 'Hooks',
  },
];

export function DevMenu() {
  const navigate = useNavigate();

  const handleMenuItemClick = (path: string) => {
    void navigate(path);
  };

  return (
    <nav className="flex w-64 flex-col gap-2 border-e bg-background p-4">
      <h2 className="mb-2 px-2 text-lg font-semibold text-foreground">
        <Trans>Developer Tools</Trans>
      </h2>
      <div className="flex flex-col gap-1">
        {DEV_MENU_ITEMS.map((item) => (
          <Button
            key={item.path}
            variant="ghost"
            className="justify-start"
            onClick={() => handleMenuItemClick(item.path)}
          >
            {item.icon}
            {item.label}
          </Button>
        ))}
      </div>
    </nav>
  );
}
