import { create } from 'zustand';
import { EnvVarType } from '../types/envVarTypes';

export interface EnvVar {
  name: string;
  var_type: EnvVarType;
  description?: string;
}

interface EnvVarsState {
  envVars: EnvVar[];
  setEnvVars: (envVars: EnvVar[] | ((prev: EnvVar[]) => EnvVar[])) => void;
  addEnvVar: (envVar: EnvVar) => void;
  updateEnvVar: (envVar: EnvVar) => void;
  deleteEnvVar: (envVarName: string) => void;
  openEnvironmentTab?: () => void;
  setOpenEnvironmentTab: (openEnvironmentTab: () => void) => void;
}

export const useEnvVarsStore = create<EnvVarsState>()((set) => ({
  envVars: [],
  setEnvVars: (envVarsOrUpdater) =>
    set((state) => ({
      envVars: typeof envVarsOrUpdater === 'function' ? envVarsOrUpdater(state.envVars || []) : envVarsOrUpdater || [],
    })),
  addEnvVar: (envVar) =>
    set((state) => ({
      envVars: [...(state.envVars || []).filter((ev) => ev.name !== envVar.name), envVar],
    })),
  updateEnvVar: (envVar) =>
    set((state) => ({
      envVars: (state.envVars || []).map((ev) => (ev.name === envVar.name ? envVar : ev)),
    })),
  deleteEnvVar: (envVarName) =>
    set((state) => ({
      envVars: (state.envVars || []).filter((envVar) => envVar.name !== envVarName),
    })),
  openEnvironmentTab: undefined,
  setOpenEnvironmentTab: (openEnvironmentTab) => set({ openEnvironmentTab }),
}));
