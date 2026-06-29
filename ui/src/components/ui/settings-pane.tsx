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
          'fixed right-0 top-0 h-full w-80 bg-background border-l shadow-lg transform transition-transform duration-300 ease-in-out z-[100]',
          isOpen ? 'translate-x-0' : 'translate-x-full',
          className,
        )}
        {...props}
      >
        <div className="flex flex-col h-full">
          <div className="flex items-center justify-between p-4 border-b">
            <h2 className="text-lg font-semibold"><Trans>Chat Settings</Trans></h2>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 p-4">
            <div className="space-y-4">
              <div>
                <label htmlFor="rules" className="block text-sm font-medium mb-2">
                  <Trans>Rules</Trans>
                </label>
                <textarea
                  id="rules"
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                  placeholder={t`Enter chat rules...`}
                  className="w-full h-32 p-2 border rounded-md resize-none"
                />
              </div>
            </div>
          </div>
          <div className="p-4 border-t">
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
