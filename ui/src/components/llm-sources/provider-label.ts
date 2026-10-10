import { LMApiProvider } from '@sdk';

/** Display names for the LLM key providers. Brand names: not translated. */
const PROVIDER_LABEL: Record<string, string> = {
  [LMApiProvider.OpenRouter]: 'OpenRouter',
  [LMApiProvider.Anthropic]: 'Anthropic',
  [LMApiProvider.OpenAI]: 'OpenAI',
  [LMApiProvider.FlowPad]: 'FlowPad Hub endpoint',
};

/** Display name for a provider value, falling back to the raw value. */
export const providerLabel = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;
