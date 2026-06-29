import { Trans } from '@lingui/react/macro';

const LoadingScreen = () => (
  <div className="flex min-h-screen items-center justify-center">
    <div className="text-center">
      <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-b-2 border-ring"></div>
      <p className="text-gray-600"><Trans>Loading . . .</Trans></p>
    </div>
  </div>
);

export default LoadingScreen;
