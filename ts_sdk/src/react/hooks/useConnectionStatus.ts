import { useContext } from './useContext';

export function useConnectionStatus(): { isConnected: boolean } {
  const context = useContext();
  return { isConnected: context.isConnected };
}
