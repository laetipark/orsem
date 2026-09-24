import type { DisclosureDetailType } from './enums';

export const disclosureTypeLabels: Record<DisclosureDetailType, string> = {
  D001: '대량보유 공시',
  D002: '임원·주요주주 보유',
  D003: '의결권 위임 권유',
  D004: '공개매수',
  D005: '주식 거래계획',
};

/** Display application prose without changing source fields or protocol identifiers. */
export function displayDisclosureText(value: string): string {
  return value.replace(
    /(?<![A-Za-z0-9_])D00[1-5](?![A-Za-z0-9_])/gu,
    (code) => disclosureTypeLabels[code as DisclosureDetailType],
  );
}
