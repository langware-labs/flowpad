import { Button } from '@src/components/ui/button';
import { Trans } from '@lingui/react/macro';

interface ServiceUnavailableScreenProps {
  statusCode?: number | string;
  onClose?: () => void;
}

const ServiceUnavailableScreen = ({ statusCode, onClose }: ServiceUnavailableScreenProps) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg bg-background/95 p-8 text-center shadow-xl">
        <div className="mb-6">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-orange-100">
            <svg className="h-8 w-8 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <h1 className="mb-2 text-2xl font-bold"><Trans>Service Unavailable</Trans></h1>
          {statusCode && <p className="mb-2 font-mono text-lg text-orange-600"><Trans>Error: {statusCode}</Trans></p>}
          <p className="mb-2 text-muted-foreground"><Trans>The FlowPad backend server is not responding.</Trans></p>
          <p className="text-sm text-muted-foreground"><Trans>Please make sure the server is running.</Trans></p>
        </div>

        {onClose && (
          <Button onClick={onClose} className="w-full" variant="outline">
            <Trans>OK</Trans>
          </Button>
        )}
      </div>
    </div>
  );
};

export default ServiceUnavailableScreen;
