import { FlowSurvey, SurveyResults } from '@sdk';
import { create } from 'zustand';

interface SurveyStore {
  activeSurveyData: FlowSurvey | null;
  setActiveSurveyData: (data: FlowSurvey | null) => void;
  onSurveyComplete: ((results: SurveyResults) => void) | null;
  setOnSurveyComplete: (callback: ((results: SurveyResults) => void) | null) => void;
}

export const useSurveyStore = create<SurveyStore>((set) => ({
  activeSurveyData: null,
  setActiveSurveyData: (data) => set({ activeSurveyData: data }),
  onSurveyComplete: null,
  setOnSurveyComplete: (callback) => set({ onSurveyComplete: callback }),
}));
