import { DependencyList, useCallback, useRef } from 'react';

export function useDebounceCallback<T extends unknown[]>(
  callback: (...args: T) => void,
  delay: number,
  deps: DependencyList,
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  return useCallback(
    (...args: T) => {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => callback(...args), delay);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [callback, delay, ...deps],
  );
}
