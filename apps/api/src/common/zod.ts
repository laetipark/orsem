import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

export function parseWith<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new BadRequestException({
    message: '요청 값이 올바르지 않습니다.',
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}
