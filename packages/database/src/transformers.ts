import type { ValueTransformer } from 'typeorm';

/** 정확한 SQL 숫자 값이 JavaScript의 안전한 숫자 범위를 벗어나 손실되지 않도록 합니다. */
export const numericStringTransformer: ValueTransformer = {
  to(value: string | null | undefined): string | null {
    return value ?? null;
  },
  from(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  },
};

export function dateToIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
