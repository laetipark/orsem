import { z } from 'zod';
import { newsContentBlockSchema, type NewsContentBlock } from '@orsem/contracts';
import { validateTranslationFacts } from './news-translation-facts';
import { validateTranslationLanguage } from './news-translation-language';

export const newsTranslationOutputSchema = z
  .object({
    title: z.string().trim().min(1).max(1600),
    description: z.string().trim().min(1).max(3000).nullable(),
  })
  .strict();

export interface NewsTranslationInput {
  readonly title: string;
  readonly description: string | null;
  readonly tickers: readonly string[];
}

export const newsContentTranslationOutputSchema = z
  .object({ blocks: z.array(newsContentBlockSchema).min(1).max(50) })
  .strict();

export const NEWS_CONTENT_TRANSLATION_FAILURE_CODES = [
  'TIMEOUT',
  'OUTPUT_TRUNCATED',
  'INVALID_JSON',
  'VALIDATION',
  'LOCAL_HTTP',
  'UNKNOWN',
] as const;

export type NewsContentTranslationFailureCode =
  (typeof NEWS_CONTENT_TRANSLATION_FAILURE_CODES)[number];

export class NewsContentTranslationError extends Error {
  public constructor(public readonly failureCode: NewsContentTranslationFailureCode) {
    super('Local content translation failed.');
    this.name = 'NewsContentTranslationError';
  }
}

export function validateNewsTranslation(input: NewsTranslationInput, value: unknown) {
  const output = newsTranslationOutputSchema.parse(value);
  if (
    !/[가-힣]/u.test(output.title) ||
    (input.description === null) !== (output.description === null)
  ) {
    throw new Error('Local translation did not match the requested Korean fields.');
  }
  for (const field of ['title', 'description'] as const) {
    const original = input[field] ?? '';
    const translated = output[field] ?? '';
    if (input[field] !== null) validateTranslationLanguage(original, translated);
    validateTranslationFacts(original, translated, input.tickers);
  }
  return output;
}

function blockTexts(block: NewsContentBlock): readonly string[] {
  return block.type === 'LIST' ? block.items : [block.text];
}

export function validateNewsContentTranslation(
  input: readonly NewsContentBlock[],
  tickers: readonly string[],
  value: unknown,
): readonly NewsContentBlock[] {
  const output = newsContentTranslationOutputSchema.parse(value).blocks;
  if (output.length !== input.length) throw new Error('Local translation changed content blocks.');
  for (let index = 0; index < input.length; index++) {
    const original = input[index]!;
    const translated = output[index]!;
    if (
      original.type !== translated.type ||
      (original.type === 'HEADING' &&
        translated.type === 'HEADING' &&
        original.level !== translated.level) ||
      (original.type === 'LIST' &&
        translated.type === 'LIST' &&
        (original.ordered !== translated.ordered ||
          original.items.length !== translated.items.length))
    ) {
      throw new Error('Local translation changed content structure.');
    }
    const originals = blockTexts(original);
    const translations = blockTexts(translated);
    for (let textIndex = 0; textIndex < originals.length; textIndex++) {
      const before = originals[textIndex]!;
      const after = translations[textIndex]!;
      validateTranslationLanguage(before, after);
      validateTranslationFacts(before, after, tickers);
    }
  }
  return output;
}
