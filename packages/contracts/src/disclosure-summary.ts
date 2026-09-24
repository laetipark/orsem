import { disclosureTypeLabels } from './disclosure-labels';

type Row = Record<string, unknown>;
const buyNatures = new Set(['MARKET_BUY', 'BLOCK_BUY', 'AFTER_HOURS_BUY', 'OFF_MARKET_BUY']);
const sellNatures = new Set(['MARKET_SELL', 'BLOCK_SELL', 'AFTER_HOURS_SELL', 'OFF_MARKET_SELL']);
const text = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const quantity = (value: unknown): bigint | null =>
  typeof value === 'string' && /^[+-]?\d{1,38}$/.test(value) ? BigInt(value) : null;
const rows = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter(
        (row): row is Row => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
      )
    : [];
const join = (...parts: (string | null)[]): string => parts.filter(Boolean).join(' ');

function signal(row: Row): string | null {
  const amount = quantity(row.quantity);
  if (amount === null) return null;
  if (buyNatures.has(text(row.nature)) && row.direction === 'INCREASE' && amount > 0n)
    return '매수신호';
  if (sellNatures.has(text(row.nature)) && row.direction === 'DECREASE' && amount < 0n)
    return '매도신호';
  return null;
}

export type DisclosureSignal = 'BUY' | 'SELL' | 'MIXED' | 'NONE';

/** Transaction evidence only; ownership increases and future plans are not purchases. */
export function disclosureSignal(value: unknown): DisclosureSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'NONE';
  const parsed = value as Row;
  if (parsed.detailType !== 'D002') return 'NONE';
  const signals = new Set(rows(parsed.transactions).map(signal));
  const buy = signals.has('매수신호');
  const sell = signals.has('매도신호');
  return buy && sell ? 'MIXED' : buy ? 'BUY' : sell ? 'SELL' : 'NONE';
}

function transactionSummary(items: Row[], planned = false): string {
  const groups = new Map<
    string,
    { amount: bigint | null; method: string; security: string; unit: string }
  >();
  items.forEach((row, index) => {
    const amount = quantity(row.quantity);
    const unit =
      row.quantityUnitRaw === '개' || row.quantityUnitRaw === '좌' ? row.quantityUnitRaw : '주';
    const method = text(row.methodRaw);
    const security = text(row.securityTypeRaw);
    const key = JSON.stringify([
      row.nature,
      row.direction,
      method,
      security,
      unit,
      amount === null ? index : null,
    ]);
    const group = groups.get(key);
    if (group && group.amount !== null && amount !== null) group.amount += amount;
    else groups.set(key, { amount, method, security, unit });
  });
  const values = [...groups.values()];
  const multipleSecurities = new Set(values.map((row) => row.security)).size > 1;
  const fragments = values.slice(0, 3).map((row) => {
    const formatted =
      row.amount === null
        ? '수량 확인 필요'
        : `${row.amount > 0n && !planned ? '+' : ''}${row.amount.toLocaleString('en-US')}${row.unit}`;
    return join(multipleSecurities ? row.security : '', formatted, row.method || '방법 확인 필요');
  });
  if (groups.size > 3) fragments.push(`외 ${groups.size - 3}종`);
  return fragments.join(' · ') || '거래 내역 확인 필요';
}

/** Render the active parse without rewriting archived source fields or historical alerts. */
export function formatDisclosureSummary(
  value: unknown,
  companyName?: string | null,
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Row;
  const kind = parsed.detailType;
  if (typeof kind !== 'string' || !Object.hasOwn(disclosureTypeLabels, kind)) return null;
  const company = text(companyName) ? `(${text(companyName)})` : '';
  const reporter = text(parsed.reporterName) || '보고자 확인 필요';
  const identity = [
    ...new Set([reporter, text(parsed.positionRaw), text(parsed.relationshipRaw)].filter(Boolean)),
  ].join(' ');
  if (kind === 'D002') {
    const transactions = rows(parsed.transactions);
    const label = {
      BUY: '[매수신호]',
      SELL: '[매도신호]',
      MIXED: '[매수신호] [매도신호]',
      NONE: '[소유변동]',
    }[disclosureSignal(parsed)];
    return join(label, company, identity, transactionSummary(transactions));
  }
  if (kind === 'D004') {
    const label = parsed.documentKind === 'RESULT' ? '공개매수 결과' : '공개매수 문서';
    return join(
      `[${label}]`,
      company,
      text(parsed.offerorName) || '공개매수자 확인 필요',
      text(parsed.targetCompanyName) || '대상회사 확인 필요',
    );
  }
  const detail =
    kind === 'D005'
      ? `${identity} ${transactionSummary(rows(parsed.planItems), true)} 예정`
      : kind === 'D001'
        ? `${reporter} ${text(parsed.reportReasonRaw) || '사유 확인 필요'}`
        : `${text(parsed.solicitorName) || '권유자 확인 필요'} 주주총회 ${text(parsed.meetingDate) || '일자 확인 필요'}, 안건 ${rows(parsed.agendas).length}건`;
  return join(
    `[${disclosureTypeLabels[kind as keyof typeof disclosureTypeLabels]}]`,
    company,
    detail,
  );
}
