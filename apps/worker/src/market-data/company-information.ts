type Row = Record<string, unknown>;
export interface InformationField {
  key: string;
  label: string;
  value: string | null;
  unit: string | null;
  basis: string;
  source: string;
  sourceUrl: string;
  observedAt: string;
}
export function financialFields(
  raw: { profile: Row | null; financials: Row | null; dividends: Row | null; statement: string },
  year: number,
  report: string,
  observedAt: string,
): InformationField[] {
  const rows = Array.isArray(raw.financials?.list) ? (raw.financials.list as Row[]) : [];
  const dividends = Array.isArray(raw.dividends?.list) ? (raw.dividends.list as Row[]) : [];
  const period = `${year}년 ${{ '11011': '연간', '11012': '반기', '11013': '1분기', '11014': '3분기' }[report]} · ${raw.statement === 'CFS' ? '연결' : '별도'}`;
  const url = (r?: Row) =>
    typeof r?.rcept_no === 'string' && /^\d{14}$/u.test(r.rcept_no)
      ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}`
      : 'https://opendart.fss.or.kr/';
  const number = (value: unknown) => {
    const s = typeof value === 'string' ? value.replaceAll(',', '').trim() : '';
    return /^-?\d+(?:\.\d+)?$/u.test(s) ? s : null;
  };
  const result: InformationField[] = [];
  for (const [key, label, ids] of [
    ['revenue', '매출액', ['ifrs-full_Revenue', 'ifrs_Revenue']],
    ['operatingProfit', '영업이익', ['dart_OperatingIncomeLoss']],
    ['netIncome', '당기순이익', ['ifrs-full_ProfitLoss', 'ifrs_ProfitLoss']],
    ['assets', '자산', ['ifrs-full_Assets', 'ifrs_Assets']],
    ['liabilities', '부채', ['ifrs-full_Liabilities', 'ifrs_Liabilities']],
    ['equity', '자본', ['ifrs-full_Equity', 'ifrs_Equity']],
  ] as const) {
    const row = rows.find((r) => ids.some((id) => id === r.account_id));
    const flow = ['revenue', 'operatingProfit', 'netIncome'].includes(key);
    const cumulative = flow && report !== '11011';
    result.push({
      key,
      label,
      value: number(cumulative ? row?.thstrm_add_amount : row?.thstrm_amount),
      unit: typeof row?.currency === 'string' ? row.currency : null,
      basis: `${period}${flow ? (cumulative ? ' · 누적' : '') : ' · 기말'}`,
      source: 'OpenDART',
      sourceUrl: url(row),
      observedAt,
    });
  }
  const eps = dividends.find(
    (r) =>
      typeof r.se === 'string' &&
      /주당순이익/u.test(r.se) &&
      typeof r.stock_knd === 'string' &&
      /보통/u.test(r.stock_knd),
  );
  const dividend = dividends.find(
    (r) =>
      typeof r.se === 'string' &&
      /주당\s*현금배당금/u.test(r.se) &&
      typeof r.stock_knd === 'string' &&
      /보통/u.test(r.stock_knd),
  );
  result.push({
    key: 'eps',
    label: 'EPS',
    value: number(eps?.thstrm),
    unit: 'KRW',
    basis: `${period} · 공시된 보통주 주당순이익`,
    source: 'OpenDART',
    sourceUrl: url(eps),
    observedAt,
  });
  result.push({
    key: 'dividend',
    label: '주당 현금배당',
    value: number(dividend?.thstrm),
    unit: 'KRW',
    basis: period,
    source: 'OpenDART',
    sourceUrl: url(dividend),
    observedAt,
  });
  for (const [key, label, sourceKey] of [
    ['ceo', '대표자', 'ceo_nm'],
    ['industry', '업종 코드', 'induty_code'],
    ['established', '설립일', 'est_dt'],
    ['fiscalMonth', '결산월', 'acc_mt'],
  ] as const) {
    const value = raw.profile?.[sourceKey];
    result.push({
      key,
      label,
      value: typeof value === 'string' ? value : null,
      unit: null,
      basis: '기업개요 조회 시점',
      source: 'OpenDART',
      sourceUrl: url(),
      observedAt,
    });
  }
  return result;
}
