/**
 * Survey-related types for flow-survey element
 */

export enum SurveyType {
  SURVEYJS = 'surveyjs',
}

/**
 * Survey results - responses from completed survey
 */
export type SurveyResults = Record<string, unknown>;

export interface FlowSurvey {
  survey_type: SurveyType;
  survey_data: Record<string, unknown>; // SurveyJS JSON schema
}
