import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Model } from 'survey-core';
import { Survey } from 'survey-react-ui';
import { DefaultLight, DefaultDark } from 'survey-core/themes';
import 'survey-core/survey-core.min.css';
import { FlowSurvey, SurveyResults, SurveyType } from '@sdk';

interface SurveyViewProps {
  surveyData: FlowSurvey;
  onComplete: (results: SurveyResults) => void;
}

export function SurveyView({ surveyData, onComplete }: SurveyViewProps) {
  const { resolvedTheme } = useTheme();
  const [survey, setSurvey] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initialize survey model
  useEffect(() => {
    try {
      // Validate survey type
      if (surveyData.survey_type !== SurveyType.SURVEYJS) {
        throw new Error(`Unsupported survey type: ${String(surveyData.survey_type)}`);
      }

      const model = new Model(surveyData.survey_data);
      setSurvey(model);
      setError(null);
    } catch (err) {
      console.error('[SurveyView] Failed to initialize survey:', err);
      setError(err instanceof Error ? err.message : 'Invalid survey JSON');
      setSurvey(null);
    }
  }, [surveyData]);

  // Apply theme based on next-themes
  useEffect(() => {
    if (!survey) return;

    const theme = resolvedTheme === 'dark' ? DefaultDark : DefaultLight;
    survey.applyTheme(theme);
  }, [resolvedTheme, survey]);

  // Handle survey completion
  useEffect(() => {
    if (!survey) return;

    const handleComplete = (sender: Model) => {
      onComplete(sender.data);
    };

    survey.onComplete.add(handleComplete);
    return () => {
      survey.onComplete.remove(handleComplete);
    };
  }, [survey, onComplete]);

  // Error state - show JSON as text
  if (error) {
    return (
      <div className="survey-view h-full overflow-auto p-6">
        <div className="mb-4 rounded border border-destructive bg-destructive/10 p-4">
          <h3 className="font-semibold text-destructive">Survey Error</h3>
          <p className="text-sm text-destructive">{error}</p>
        </div>
        <div className="rounded bg-muted p-4">
          <h4 className="mb-2 text-sm font-semibold">Survey Data:</h4>
          <pre className="overflow-auto text-xs">{JSON.stringify(surveyData, null, 2)}</pre>
        </div>
      </div>
    );
  }

  if (!survey) {
    return <div className="p-6">Loading survey...</div>;
  }

  return (
    <div className="survey-view h-full overflow-auto p-6">
      <Survey model={survey} />
      <div className="mt-6 flex justify-end">
        <button
          onClick={() => survey.completeLastPage()}
          disabled={survey.isCurrentPageHasErrors}
          className="rounded bg-primary px-6 py-2 text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
