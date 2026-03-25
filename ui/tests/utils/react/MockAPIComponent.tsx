import React, { useState } from 'react';

export interface MockAPIComponentProps {
  'data-testid'?: string;
  onAPIResult?: (result: any) => void;
}

/**
 * Simple component to test API interactions
 * Uses mock responses to avoid real network calls
 */
export function MockAPIComponent({ 'data-testid': testId = 'api-component', onAPIResult }: MockAPIComponentProps) {
  const [response, setResponse] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mock API call simulation
  const mockAPICall = async (endpoint: string, delay: number = 500) => {
    setLoading(true);
    setError(null);

    try {
      // Simulate network delay
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Mock responses based on endpoint
      let mockResponse;
      switch (endpoint) {
        case 'users':
          mockResponse = {
            data: [
              { id: 1, name: 'John Doe', email: 'john@example.com' },
              { id: 2, name: 'Jane Smith', email: 'jane@example.com' },
            ],
            status: 'success',
          };
          break;
        case 'pages':
          mockResponse = {
            data: [
              { id: 1, title: 'Home Page', created: new Date().toISOString() },
              { id: 2, title: 'About Page', created: new Date().toISOString() },
            ],
            status: 'success',
          };
          break;
        case 'error':
          throw new Error('Simulated API error');
        default:
          mockResponse = {
            data: { message: 'Unknown endpoint' },
            status: 'success',
          };
      }

      setResponse(mockResponse);
      if (onAPIResult) {
        onAPIResult(mockResponse);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'API call failed';
      setError(errorMessage);
      if (onAPIResult) {
        onAPIResult({ error: errorMessage });
      }
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setResponse(null);
    setError(null);
  };

  return (
    <div data-testid={testId}>
      <div data-testid="api-status">
        Status: {loading ? 'loading' : response ? 'success' : error ? 'error' : 'idle'}
      </div>

      {error && (
        <div data-testid="error-message" role="alert">
          Error: {error}
        </div>
      )}

      <div data-testid="controls">
        <button onClick={() => mockAPICall('users')} disabled={loading} data-testid="fetch-users-button">
          Fetch Users
        </button>

        <button onClick={() => mockAPICall('pages')} disabled={loading} data-testid="fetch-pages-button">
          Fetch Pages
        </button>

        <button onClick={() => mockAPICall('error')} disabled={loading} data-testid="trigger-error-button">
          Trigger Error
        </button>

        <button onClick={reset} disabled={loading} data-testid="reset-button">
          Reset
        </button>
      </div>

      {response && (
        <div data-testid="api-response">
          <div data-testid="response-status">Status: {response.status}</div>

          {response.data && Array.isArray(response.data) && (
            <div data-testid="response-list">
              {response.data.map((item: any, index: number) => (
                <div key={index} data-testid={`response-item-${index}`}>
                  {JSON.stringify(item)}
                </div>
              ))}
            </div>
          )}

          {response.data && !Array.isArray(response.data) && (
            <div data-testid="response-data">{JSON.stringify(response.data)}</div>
          )}
        </div>
      )}
    </div>
  );
}
