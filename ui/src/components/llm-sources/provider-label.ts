import { LMApiProvider } from '@sdk';

import { providerSpec } from '@src/components/llm-endpoints/endpoint-catalog';

/**
 * Display name for an LLM key provider: the brand the endpoint catalog already declares, so a
 * new provider is named in one place. FlowPad's hub endpoint is not a catalog provider (nobody
 * keys it by hand), so it is the one name kept here.
 */
export const providerLabel = (provider: string): string =>
  provider === (LMApiProvider.FlowPad as string) ? 'FlowPad Hub endpoint' : (providerSpec(provider)?.brand ?? provider);
