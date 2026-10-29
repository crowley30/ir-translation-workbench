// Public, non-secret catalog snapshot. No discovery or provider request runs here.
// Verified 2026-10-29 against official model pages; see docs/openai-official-reference.md.
// USD microdollars per one million tokens. Input reserves use the higher 12-hour
// cache-write rate, not the cheaper nominal/cached-input rate. These rates are
// planning assumptions for Standard, global, short-context text requests only.
export interface OpenAIModel {
  readonly id: string;
  readonly label: string;
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly maxOutputTokens: number;
  readonly defaultOutputTokens: number;
}

export const OPENAI_MODELS: readonly OpenAIModel[] = Object.freeze([
  Object.freeze({
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna（低成本；翻译质量未实测）',
    inputMicrosPerMillion: 250_000,
    outputMicrosPerMillion: 500_000,
    maxOutputTokens: 8_192,
    defaultOutputTokens: 4_096,
  }),
  Object.freeze({
    id: 'gpt-6.1-terra',
    label: 'GPT-6.1 Terra（翻译质量未实测）',
    inputMicrosPerMillion: 2_500_000,
    outputMicrosPerMillion: 5_000_000,
    maxOutputTokens: 8_192,
    defaultOutputTokens: 4_096,
  }),
]);

export const OPENAI_DEFAULT_MODEL = 'gpt-6-luna';
// The serialized request (instructions, context, terms and source) must also be
// bounded by the server. This application cap is far below the long-context tier.
export const OPENAI_MAX_INPUT_BYTES = 64_000;

export function findOpenAIModel(model: string): OpenAIModel | undefined {
  return OPENAI_MODELS.find((entry) => entry.id === model);
}
