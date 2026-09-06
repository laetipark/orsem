export type InformationField = {
  key: string;
  label: string;
  value: string | null;
  unit: string | null;
  basis: string;
  source: string;
  sourceUrl: string;
  observedAt: string | null;
};
export function financialNumber(value: string, compact = false) {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) return value;
  const number = Number(value);
  if (compact && Math.abs(number) >= 1e12)
    return `${(number / 1e12).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}조`;
  if (compact && Math.abs(number) >= 1e8)
    return `${(number / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}억`;
  return /^-?\d+$/u.test(value)
    ? BigInt(value).toLocaleString('ko-KR')
    : number.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
}
export function companyFieldValue(field?: InformationField, compact = false) {
  if (field?.value == null || field.value.trim() === '') return '—';
  const value = field.value;
  if (field.key === 'industry') return value;
  if (field.key === 'established')
    return /^\d{8}$/u.test(value)
      ? `${value.slice(0, 4)}.${value.slice(4, 6)}.${value.slice(6)}`
      : value;
  if (field.key === 'fiscalMonth') return /^\d{1,2}$/u.test(value) ? `${Number(value)}월` : value;
  if (field.key === 'range52w')
    return (
      value
        .split('–')
        .map((v) => financialNumber(v))
        .join(' – ') + (field.unit === 'KRW' ? '원' : field.unit === 'USD' ? ' USD' : '')
    );
  const unit = field.unit === 'KRW' ? '원' : field.unit === 'USD' ? ' USD' : (field.unit ?? '');
  return `${financialNumber(value, compact)}${unit}`;
}
