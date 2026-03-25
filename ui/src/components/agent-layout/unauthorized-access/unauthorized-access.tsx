import { Button } from '@src/components/ui/button';
import { useAuth } from '@sdk/react/hooks';
import { Home, LogIn } from 'lucide-react';
import { navigator } from '@sdk';

const UnauthorizedAccess = ({ requireLogin = false }: { requireLogin?: boolean }) => {
  const { user } = useAuth();
  console.log('[UNAUTHORIZED_ACCESS] Component rendered, requireLogin:', requireLogin, 'user:', user?.name);

  const handleGoHome = () => {
    console.log('[UNAUTHORIZED_ACCESS] handleGoHome called');
    window.location.href = '/';
  };

  const handleLogin = () => {
    console.log('[UNAUTHORIZED_ACCESS] handleLogin called - TRIGGERING REDIRECT');
    navigator.navigateToLogin();
  };

  const getTitle = () => {
    if (requireLogin && !user) {
      return 'Login Required';
    }
    return 'Access Denied';
  };

  const getMessage = () => {
    if (requireLogin && !user) {
      return 'This agent requires you to be logged in to access it.';
    }
    return 'You are not authorized to access this page.';
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-background p-8 text-center shadow-md">
        <div className="mb-6">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            {requireLogin && !user ? (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                />
              </svg>
            ) : (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 15.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            )}
          </div>
          <h1 className="mb-2 text-2xl font-bold text-gray-900">{getTitle()}</h1>
          <p className="text-gray-600">{getMessage()}</p>
        </div>

        <div className="space-y-3">
          {user ? (
            // User is logged in but still not authorized
            <Button onClick={handleGoHome} className="flex w-full items-center justify-center">
              <Home className="mr-2 h-4 w-4" />
              Go to Homepage
            </Button>
          ) : (
            // User is not logged in
            <>
              <Button onClick={handleLogin} className="flex w-full items-center justify-center">
                <LogIn className="mr-2 h-4 w-4" />
                Login
              </Button>
              <Button onClick={handleGoHome} variant="outline" className="flex w-full items-center justify-center">
                <Home className="mr-2 h-4 w-4" />
                Go to Homepage
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default UnauthorizedAccess;
