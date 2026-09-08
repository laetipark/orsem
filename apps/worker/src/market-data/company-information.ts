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
const listRows = (raw: Row | null | undefined): Row[] =>
  Array.isArray(raw?.list)
    ? raw.list.filter((row): row is Row => !!row && typeof row === 'object' && !Array.isArray(row))
    : [];
const receiptUrl = (row?: Row) =>
  typeof row?.rcept_no === 'string' && /^\d{14}$/u.test(row.rcept_no)
    ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.rcept_no}`
    : 'https://opendart.fss.or.kr/';
function decimal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > 80 || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(text)) return null;
  const [integer = '', fraction = ''] = text.replaceAll(',', '').replace(/^-/, '').split('.');
  const whole = integer.replace(/^0+(?=\d)/u, '');
  const rest = fraction.replace(/0+$/u, '');
  const normalized = `${whole}${rest ? `.${rest}` : ''}`;
  return text.startsWith('-') && normalized !== '0' ? `-${normalized}` : normalized;
}
const isPreferred = (row: Row) =>
  /우선|preferred|preference/iu.test(
    [row.account_id, row.account_nm, row.account_detail, row.stock_knd].join(' '),
  );
function sameReport(row: Row, year: number, report: string, statement: string, required = false) {
  return (
    ((!required && row.bsns_year == null) || String(row.bsns_year) === String(year)) &&
    ((!required && row.reprt_code == null) || row.reprt_code === report) &&
    (row.fs_div == null || row.fs_div === statement)
  );
}
function uniqueAmount(rows: Row[], key: string): { row: Row; value: string } | null {
  if (!rows.length) return null;
  const values = rows.map((row) => decimal(row[key]));
  if (values.some((value) => value === null) || new Set(values).size !== 1) return null;
  return { row: rows[0]!, value: values[0]! };
}
function reportEps(rows: Row[], dividends: Row[], year: number, report: string, statement: string) {
  if (report !== '11011' || !['CFS', 'OFS'].includes(statement))
    return { value: null, basis: '연간 EPS는 사업보고서 기준', row: undefined };
  const candidates = rows.filter(
    (row) =>
      ['ifrs-full_BasicEarningsLossPerShare', 'ifrs_BasicEarningsLossPerShare'].includes(
        String(row.account_id),
      ) &&
      ['IS', 'CIS'].includes(String(row.sj_div)) &&
      row.currency === 'KRW' &&
      !isPreferred(row) &&
      sameReport(row, year, report, statement),
  );
  if (candidates.length) {
    const selected = uniqueAmount(candidates, 'thstrm_amount');
    return {
      value: selected?.value ?? null,
      row: selected?.row ?? candidates[0],
      basis: selected
        ? '공시된 보통주 기본주당이익 · IFRS 기본 EPS'
        : '기본 EPS 중복값 또는 금액 확인 필요',
    };
  }
  const fallback = dividends.filter(
    (row) =>
      typeof row.se === 'string' &&
      /주당\s*순이익/u.test(row.se) &&
      typeof row.stock_knd === 'string' &&
      /보통/u.test(row.stock_knd) &&
      !isPreferred(row) &&
      !/희석/u.test(row.se) &&
      (row.currency == null || row.currency === 'KRW') &&
      (row.currency === 'KRW' || /\(원\)\s*$/u.test(row.se)) &&
      !/천원|백만원|달러|USD|JPY|EUR/iu.test(row.se) &&
      (statement === 'CFS' ? !/별도|개별/u.test(row.se) : !/연결/u.test(row.se)) &&
      sameReport(row, year, report, statement),
  );
  const selected = uniqueAmount(fallback, 'thstrm');
  return {
    value: selected?.value ?? null,
    row: selected?.row ?? fallback[0],
    basis: selected ? '공시된 보통주 주당순이익 · 배당사항' : '보통주 연간 기본 EPS 공시 확인 필요',
  };
}
function calendarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})[.-](\d{2})[.-](\d{2})(?:\s*현재)?$/u.exec(value.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  return date.toISOString().slice(0, 10) === normalized ? normalized : null;
}
function financialDate(row: Row, profile: Row | null, year: number, report: string) {
  if (row.thstrm_dt != null) return calendarDate(row.thstrm_dt);
  // The all-accounts API omits an end date. Only December reporters have an
  // unambiguous calendar quarter-end from the requested business year/report.
  if (profile?.acc_mt !== '12') return null;
  const ends: Record<string, string> = {
    '11011': '12-31',
    '11012': '06-30',
    '11013': '03-31',
    '11014': '09-30',
  };
  return ends[report] ? `${year}-${ends[report]}` : null;
}
function shareCount(row: Row, key: string): bigint | null {
  const value = decimal(row[key]);
  return value !== null && /^\d+$/u.test(value) ? BigInt(value) : null;
}
function bookValuePerShare(equity: string, shares: bigint): string {
  const negative = equity.startsWith('-');
  const [whole, fraction = ''] = equity.replace(/^-/, '').split('.');
  const numerator = BigInt(`${whole}${fraction}`) * 1_000_000n;
  const denominator = shares * 10n ** BigInt(fraction.length);
  const rounded = (numerator + denominator / 2n) / denominator;
  const text = `${rounded / 1_000_000n}.${String(rounded % 1_000_000n).padStart(6, '0')}`;
  return decimal(`${negative ? '-' : ''}${text}`)!;
}
function reportBps(raw: FinancialRaw, rows: Row[], year: number, report: string) {
  const unavailable = (reason: string, row?: Row) => ({
    value: null,
    basis: `BPS 산출 보류 · ${reason}`,
    row,
  });
  if (!['CFS', 'OFS'].includes(raw.statement))
    return unavailable('재무제표 연결·별도 구분 확인 필요');
  const financial = rows.filter(
    (row) =>
      row.sj_div === 'BS' &&
      row.currency === 'KRW' &&
      !isPreferred(row) &&
      sameReport(row, year, report, raw.statement, true),
  );
  const explicit = financial.filter(
    (row) =>
      typeof row.account_nm === 'string' &&
      /^(?:보통주주당순자산(?:가액|가치)?|보통주주당장부가액)$/u.test(
        row.account_nm.replace(/[\s()]/gu, '').replace(/원$/u, ''),
      ),
  );
  if (explicit.length) {
    const selected = uniqueAmount(explicit, 'thstrm_amount');
    const end = selected && financialDate(selected.row, raw.profile, year, report);
    return selected && end
      ? { ...selected, basis: `${end} 기말 · 공시된 보통주 주당순자산` }
      : unavailable('공시 BPS 금액 또는 기준일 확인 필요', explicit[0]);
  }
  const ids =
    raw.statement === 'CFS'
      ? ['ifrs-full_EquityAttributableToOwnersOfParent', 'ifrs_EquityAttributableToOwnersOfParent']
      : ['ifrs-full_Equity', 'ifrs_Equity'];
  const equityRows = financial.filter((row) => ids.includes(String(row.account_id)));
  const equity = uniqueAmount(equityRows, 'thstrm_amount');
  if (!equity) return unavailable('보통주 귀속 자본 금액 확인 필요', equityRows[0]);
  const end = financialDate(equity.row, raw.profile, year, report);
  if (!end) return unavailable('재무제표 기준일 확인 필요', equity.row);
  const shareRows = listRows(raw.shares);
  if (shareRows.some((row) => typeof row.se !== 'string' || !row.se.trim()))
    return unavailable('주식 발행종류 구분 확인 필요', equity.row);
  const classes = shareRows.filter(
    (row) =>
      typeof row.se === 'string' && !/^(?:합계|총계|계|비고)$/u.test(row.se.replaceAll(' ', '')),
  );
  const common = classes.filter((row) =>
    /^(?:기명식)?보통주(?:식)?$/u.test(String(row.se).replaceAll(' ', '')),
  );
  if (common.length !== 1) return unavailable('단일 보통주 발행종류 확인 필요', equity.row);
  const share = common[0]!;
  const issued = shareCount(share, 'istc_totqy');
  const treasury = shareCount(share, 'tesstk_co');
  const outstanding = shareCount(share, 'distb_stock_co');
  if (
    issued === null ||
    treasury === null ||
    outstanding === null ||
    outstanding <= 0n ||
    issued - treasury !== outstanding
  )
    return unavailable('발행주식·자기주식·유통주식 수 불일치', equity.row);
  const totals = shareRows.filter((row) =>
    /^(?:합계|총계|계)$/u.test(String(row.se).replaceAll(' ', '')),
  );
  const totalsMatch =
    totals.length > 0 &&
    totals.every(
      (row) =>
        shareCount(row, 'istc_totqy') === issued &&
        shareCount(row, 'tesstk_co') === treasury &&
        shareCount(row, 'distb_stock_co') === outstanding,
    );
  const countKeys = ['istc_totqy', 'tesstk_co', 'distb_stock_co'];
  for (const row of classes.filter((item) => item !== share)) {
    const zero = countKeys.every((key) => shareCount(row, key) === 0n);
    const unissued = totalsMatch && countKeys.every((key) => row[key] === '-');
    if (!zero && !unissued)
      return unavailable('우선주 등 다른 발행종류의 자본 배분 확인 필요', equity.row);
  }
  if (
    totals.some(
      (row) =>
        shareCount(row, 'istc_totqy') !== issued ||
        shareCount(row, 'tesstk_co') !== treasury ||
        shareCount(row, 'distb_stock_co') !== outstanding,
    )
  )
    return unavailable('종류별 주식 수와 합계 불일치', equity.row);
  if (
    !/^\d{14}$/u.test(String(equity.row.rcept_no)) ||
    !/^\d{8}$/u.test(String(equity.row.corp_code)) ||
    [...classes, ...totals].some(
      (row) =>
        calendarDate(row.stlm_dt) !== end ||
        row.rcept_no !== equity.row.rcept_no ||
        row.corp_code !== equity.row.corp_code,
    )
  )
    return unavailable('재무제표와 주식 수의 회사·보고서·기준일 불일치', equity.row);
  return {
    value: bookValuePerShare(equity.value, outstanding),
    row: equity.row,
    basis: `${end} 기말 · ${raw.statement === 'CFS' ? '지배기업 소유주지분' : '자본총계'} / 보통주 유통주식수 ${outstanding}주(자기주식 제외) · 동일 보고서 · 소수 6자리 반올림`,
  };
}
export interface FinancialRaw {
  profile: Row | null;
  financials: Row | null;
  dividends: Row | null;
  shares?: Row | null;
  statement: string;
}

export function financialFields(
  raw: FinancialRaw,
  year: number,
  report: string,
  observedAt: string,
): InformationField[] {
  const rows = listRows(raw.financials);
  const dividends = listRows(raw.dividends);
  const period = `${year}년 ${{ '11011': '연간', '11012': '반기', '11013': '1분기', '11014': '3분기' }[report]} · ${raw.statement === 'CFS' ? '연결' : '별도'}`;
  const url = receiptUrl;
  const number = decimal;
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
  const eps = reportEps(rows, dividends, year, report, raw.statement);
  const bps = reportBps(raw, rows, year, report);
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
    value: eps.value,
    unit: 'KRW',
    basis: `${period} · ${eps.basis}`,
    source: 'OpenDART',
    sourceUrl: url(eps.row),
    observedAt,
  });
  result.push({
    key: 'bps',
    label: 'BPS',
    value: bps.value,
    unit: 'KRW',
    basis: `${period} · ${bps.basis}`,
    source: 'OpenDART',
    sourceUrl: url(bps.row),
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
