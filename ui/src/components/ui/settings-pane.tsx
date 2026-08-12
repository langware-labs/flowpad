import * as React from 'react';
import { cn } from '../../lib/utils';
import { X } from 'lucide-react';
import { Button } from './button';
import { Trans, useLingui } from '@lingui/react/macro';

interface SettingsPaneProps extends React.HTMLAttributes<HTMLDivElement> {
  isOpen: boolean;
  onClose: () => void;
  onSave: (rules: string) => void;
  initialRules?: string;
}

const SettingsPane = React.forwardRef<HTMLDivElement, SettingsPaneProps>(
  ({ className, isOpen, onClose, onSave, initialRules = '', ...props }, ref) => {
    const { t } = useLingui();
    const [rules, setRules] = React.useState(initialRules);

    // Update local state when initialRules changes
    React.useEffect(() => {
      setRules(initialRules);
    }, [initialRules]);

    const handleSave = () => {
      onSave(rules);
      onClose();
    };

    return (
      <div
        ref={ref}
        className={cn(
          'fixed right-0 top-0 z-[100] h-full w-80 transform border-s bg-background shadow-lg transition-transform duration-300 ease-in-out',
          isOpen ? 'translate-x-0' : 'translate-x-full',
          className,
        )}
        {...props}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="text-lg font-semibold">
              <Trans>Chat Settings</Trans>
            </h2>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 p-4">
            <div className="space-y-4">
              <div>
                <label htmlFor="rules" className="mb-2 block text-sm font-medium">
                  <Trans>Rules</Trans>
                </label>
                <textarea
                  id="rules"
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                  placeholder={t`Enter chat rules...`}
                  className="h-32 w-full resize-none rounded-md border p-2"
                />
              </div>
            </div>
          </div>
          <div className="border-t p-4">
            <Button onClick={handleSave} className="w-full">
              <Trans>Save Changes</Trans>
            </Button>
          </div>
        </div>
      </div>
    );
  },
);
SettingsPane.displayName = 'SettingsPane';

export { SettingsPane };
