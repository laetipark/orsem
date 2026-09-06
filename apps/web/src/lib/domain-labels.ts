import type { DisclosureType, Priority } from '../types';

export const priorityLabels: Record<Priority, string> = {
  P1: '시총 상위 20종목',
  P2: '이전 관심 분류',
  P3: '시장 동향',
  P4: '일반 뉴스',
};

export const disclosureLabels: Record<DisclosureType, string> = {
  D001: '대량보유 공시',
  D002: '임원·주요주주 보유',
  D003: '의결권 위임 권유',
  D004: '공개매수',
  D005: '주식 거래계획',
  NEWS: '뉴스 후보',
  SEC: 'SEC 공시 접수',
};

export const disclosureDescriptions: Partial<Record<DisclosureType, string>> = {
  D001: '5% 이상 보유와 보유 목적의 변동',
  D002: '임원·주요주주의 보유·소유 변동',
  D003: '의결권 대리행사 권유와 주주총회 주요 안건',
  D004: '공개매수 조건·청약 일정과 실제 결과',
  D005: '앞으로의 거래 계획 · 실제 체결과 구분',
};

// Use only for application explanations and labels. Source quotes and stored fields stay intact.
export function displayDomainText(value: string): string {
  return value.replace(
    /(?<![\p{L}\p{N}_])(?:P[1-4]|D00[1-5])(?![\p{L}\p{N}_])/gu,
    (code) => priorityLabels[code as Priority] ?? disclosureLabels[code as DisclosureType] ?? code,
  );
}

export const filingTypes = ['D001', 'D002', 'D003', 'D004', 'D005'] as const;
export const defaultNotificationFilingTypes = ['D001', 'D002', 'D005'] as const;
