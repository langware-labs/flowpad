import React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { dataManager, TypeId } from '@sdk';
import { entityEnvQueryKey, useEntityEnv } from '@sdk/react/hooks/useEntityEnv';
import { OAuthEventType, OAuthStatus } from '@sdk/services/oauth/oauth-service';

afterEach(cleanup);

describe('env table updates from another OAuth session', () => {
  for (const status of [OAuthStatus.SUCCESS, OAuthStatus.ERROR, OAuthStatus.CANCELLED]) {
    it(`handles ${status} without owning the OAuth flow`, () => {
      const client = new QueryClient();
      const entityTypeId = new TypeId('user', '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
      const key = entityEnvQueryKey(entityTypeId);
      client.setQueryData(key, { values: [] });
      const wrapper = ({ children }: React.PropsWithChildren) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const hook = renderHook(() => useEntityEnv({ entityTypeId, enabled: false }), { wrapper });
      act(() => {
        dataManager.emit(OAuthEventType.OAUTH_MSG, { oauth_request_id: 'another-tab', status });
      });
      expect(client.getQueryState(key)?.isInvalidated).toBe(status === OAuthStatus.SUCCESS);
      hook.unmount();
      client.setQueryData(key, { values: [] });
      act(() => {
        dataManager.emit(OAuthEventType.OAUTH_MSG, { oauth_request_id: 'after-unmount', status });
      });
      expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      client.clear();
    });
  }
});
