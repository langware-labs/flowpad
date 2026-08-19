/**
 * LLM API-provider identifiers.
 *
 * Hand-maintained 1:1 mirror of the Python `LMApiProvider` StrEnum in
 * `flow_sdk/flowpad_types/enums/lm_provider_enums.py`. A provider is an
 * account/endpoint a key authenticates against — not a model (GLM is a model
 * reached via OpenRouter, not a provider).
 */
export enum LMApiProvider {
  OpenRouter = 'openrouter',
  Anthropic = 'anthropic',
  OpenAI = 'openai',
  /** The FlowPad hub's LLMEndpoint: authenticated by the box's hub login, bound
   *  by the hub after login. No key to paste — see `LmApiKeySummary.managed`. */
  FlowPad = 'flowpad',
}
