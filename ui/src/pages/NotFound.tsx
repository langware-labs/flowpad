import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { Trans } from '@lingui/react/macro';

const NotFound = () => {
  const location = useLocation();
  useEffect(() => {
    console.error('404 Error: User attempted to access non-existent route:', location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">404</h1>
        <p className="mb-4 text-xl text-gray-600">
          <Trans>Oops! Page not found</Trans>
        </p>
        <a
          onClick={() => (window.location.href = `${window.location.origin}/`)}
          className="cursor-pointer underline hover:text-primary"
        >
          <Trans>Return to Flowpad.ai</Trans>
        </a>
      </div>
    </div>
  );
};

export default NotFound;
