import { BadRequestException } from '@nestjs/common';

export interface CursorValue {
  sort: string;
  id: string;
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(value?: string): CursorValue | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof (decoded as CursorValue).sort !== 'string' ||
      typeof (decoded as CursorValue).id !== 'string'
    ) {
      throw new Error('invalid cursor payload');
    }
    return decoded as CursorValue;
  } catch {
    throw new BadRequestException('유효하지 않은 페이지 커서입니다.');
  }
}

export function cursorInstant(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new BadRequestException('페이지 커서의 시간 값이 올바르지 않습니다.');
  return parsed;
}
