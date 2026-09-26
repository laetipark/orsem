import { companyFieldValue } from '../lib/company-fields';
import { useQuery } from '@tanstack/react-query';
import { companyInformationQuery } from '../lib/company-query';
import { formatDate, formatMoney, formatPercent } from '../lib/format';
import type { CompanyTimeline } from '../types';
import { Card, CardContent, CardHeader, EmptyState, LoadingState } from './ui';

export function CompanyKeyStats({ companyId }: { companyId: string }) {
  const query = useQuery(companyInformationQuery(companyId));
  const values = [
    ['previousClose', '전 거래일'],
    ['open', '시가'],
    ['high', '고가'],
    ['low', '저가'],
    ['volume', '거래량'],
    ['marketCap', '시가총액'],
  ] as const;
  const date = query.data?.fields
    .find((field) => field.key === 'close' && field.value)
    ?.basis.match(/\d{4}-\d{2}-\d{2}/u)?.[0];
  return (
    <div className="company-key-summary">
      <dl className="company-key-stats" aria-label="주요 시세 정보">
        {values.map(([key, label]) => {
          const field = query.data?.fields.find((item) => item.key === key);
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd title={field?.value ? field.basis : undefined}>
                {companyFieldValue(field, key === 'marketCap')}
              </dd>
            </div>
          );
        })}
      </dl>
      {date ? (
        <small className="company-key-summary__date">{formatDate(date)} 일별 시세</small>
      ) : null}
    </div>
  );
}

export function CompanyDailyPrices({
  timeline,
  loading,
}: {
  timeline?: CompanyTimeline;
  loading: boolean;
}) {
  const prices = timeline?.prices ?? [];
  const rows = prices
    .map((point, index) => ({
      ...point,
      change:
        index && prices[index - 1]!.close > 0
          ? (point.close / prices[index - 1]!.close - 1) * 100
          : null,
    }))
    .reverse();
  return (
    <Card className="company-daily-prices">
      <CardHeader>
        <div>
          <h2>일별 시세</h2>
          <p className="muted">
            {timeline?.priceSources.map((source) => source.attribution).join(' · ') ||
              '수집된 일별 가격'}{' '}
            · 최근 {rows.length}개 봉
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !rows.length ? (
          <LoadingState label="일별 시세를 불러오고 있습니다." />
        ) : rows.length ? (
          <div className="company-daily-prices__table">
            <table>
              <thead>
                <tr>
                  {['날짜', '종가', '등락률', '시가', '고가', '저가', '거래량'].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.time}>
                    <th scope="row">{formatDate(row.sessionDate ?? row.time)}</th>
                    <td>{formatMoney(row.close, timeline?.currency)}</td>
                    <td
                      className={
                        (row.change ?? 0) > 0 ? 'positive' : (row.change ?? 0) < 0 ? 'negative' : ''
                      }
                    >
                      {formatPercent(row.change)}
                    </td>
                    <td>{formatMoney(row.open, timeline?.currency)}</td>
                    <td>{formatMoney(row.high, timeline?.currency)}</td>
                    <td>{formatMoney(row.low, timeline?.currency)}</td>
                    <td>{row.volume.toLocaleString('ko-KR')}주</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="수집된 일별 시세가 없습니다" />
        )}
      </CardContent>
    </Card>
  );
}
