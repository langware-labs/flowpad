import { TypeId, isTypeId, isValidUUIDv4 } from '../models/TypeId';
import { ContextEntitiesEnum } from './context';

const STORAGE_ITEM_KEY = 'flowpad-state';

export function storageStateToTypeIdState(storageState: { [key: string]: string }): { [key: string]: TypeId } {
  const typeIdState: { [key: string]: TypeId } = {};
  for (const key in storageState) {
    if (storageState[key] && isTypeId(storageState[key])) {
      typeIdState[key] = new TypeId(storageState[key]);
    } else {
      console.error('Invalid state in context local storage', key, storageState[key]);
    }
  }
  return typeIdState;
}

export function typeIdStateToStorageState(typeIdState: { [key: string]: TypeId }): { [key: string]: string } {
  const storageState: { [key: string]: string } = {};
  for (const key in typeIdState) {
    storageState[key] = typeIdState[key].toString();
  }
  return storageState;
}

export function saveContextState(
  persistedState: { [key: string]: TypeId },
  contextInstance: any,
): { [key: string]: TypeId } {
  const storageState: { [key: string]: string } = typeIdStateToStorageState(persistedState);
  // Save all computed
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(contextInstance))) {
    // Check if it's a getter
    if (typeof descriptor.get === 'function') {
      // Call the getter to get the value
      const value = descriptor.get.call(contextInstance);
      if (value instanceof TypeId) {
        // Save TypeId as string
        storageState[key] = value.toString();
      }
    }
  }
  localStorage.setItem(STORAGE_ITEM_KEY, JSON.stringify(storageState));
  return storageStateToTypeIdState(storageState);
}

export function loadContextState(): { [key: string]: TypeId } {
  // Load state from local storage into persistedState, not directly into observables
  const storedState = localStorage.getItem(STORAGE_ITEM_KEY);
  if (storedState) {
    return storageStateToTypeIdState(JSON.parse(storedState));
  }
  return {};
}

export function getContextEntityFromLocalStorage(entityKey: ContextEntitiesEnum): TypeId | null {
  const storedState = localStorage.getItem(STORAGE_ITEM_KEY);
  if (!storedState) {
    return null;
  }

  try {
    const parsed = JSON.parse(storedState);
    const value = parsed[entityKey];

    if (value && isTypeId(value)) {
      return new TypeId(value);
    }
  } catch (error) {
    console.error('Error reading from local storage', error);
  }

  return null;
}

export function setContextEntityToLocalStorage(entityKey: ContextEntitiesEnum, typeId: TypeId | null): void {
  try {
    const storedState = localStorage.getItem(STORAGE_ITEM_KEY);
    const state = storedState ? JSON.parse(storedState) : {};

    if (typeId) {
      if (!isValidUUIDv4(typeId.id)) {
        return;
      }
      state[entityKey] = typeId.toString();
    } else {
      delete state[entityKey];
    }

    localStorage.setItem(STORAGE_ITEM_KEY, JSON.stringify(state));
  } catch (error) {
    console.error('Error writing to local storage', error);
  }
}
