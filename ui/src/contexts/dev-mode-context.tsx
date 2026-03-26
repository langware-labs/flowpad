import { useEffect, useState } from 'react';
import { defineGlobal } from '@sdk/utils';

declare global {
  interface Window {
    setDev: (val: boolean) => void;
    getDev: () => boolean;
  }
}

const DEV_MODE_KEY = 'devMode';

let _devMode: boolean = localStorage.getItem(DEV_MODE_KEY) === 'true' || import.meta.env.VITE_DEV_MODE === 'true';
const _listeners = new Set<(val: boolean) => void>();

function setDevMode(val: boolean): void {
  _devMode = val;
  localStorage.setItem(DEV_MODE_KEY, String(val));
  _listeners.forEach((fn) => fn(val));
}

function getDevMode(): boolean {
  return _devMode;
}

defineGlobal('setDev', setDevMode);
defineGlobal('getDev', getDevMode);

export function useDevMode(): boolean {
  const [devMode, setDevModeState] = useState(_devMode);

  useEffect(() => {
    _listeners.add(setDevModeState);
    return () => {
      _listeners.delete(setDevModeState);
    };
  }, []);

  return devMode;
}
