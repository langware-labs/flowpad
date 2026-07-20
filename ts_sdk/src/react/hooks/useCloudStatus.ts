import { useEffect, useState } from 'react';
import { cloudManager } from '../../services/cloud_login';
import {
  ConnectionSlot,
  HubConnectionStatus,
  HubLoginStatus,
  LoginSlot,
} from '../../services/cloud_status';

export interface UseCloudStatusResult {
  login: LoginSlot<HubLoginStatus>;
  connection: ConnectionSlot<HubConnectionStatus>;
  cloudUrl: string;
  connectionControlsAvailable: boolean;
}

/**
 * Subscribe to the two orthogonal cloud status slots from CloudManager.
 * Re-renders on either login_status_changed or connection_status_changed.
 */
export function useCloudStatus(): UseCloudStatusResult {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    cloudManager.on('login_status_changed', bump);
    cloudManager.on('connection_status_changed', bump);
    return () => {
      cloudManager.off('login_status_changed', bump);
      cloudManager.off('connection_status_changed', bump);
    };
  }, []);
  return {
    login: cloudManager.loginSlot as LoginSlot<HubLoginStatus>,
    connection: cloudManager.connectionSlot as ConnectionSlot<HubConnectionStatus>,
    cloudUrl: cloudManager.cloudUrl,
    connectionControlsAvailable: cloudManager.connectionControlsAvailable,
  };
}
