import { useQuery } from '@tanstack/react-query';
import { companyInformationQuery } from '../lib/company-query';
import { companyFieldValue } from '../lib/company-fields';
import { ErrorState, LoadingState } from './ui';

const groups = [
  {
    title: '시세',
    keys: ['close', 'open', 'high', 'low', 'previousClose', 'volume', 'range52w', 'marketCap'],
  },
  { title: '기업개요', keys: ['ceo', 'industry', 'established', 'fiscalMonth'] },
  {
    title: '재무·배당',
    keys: [
      'revenue',
      'operatingProfit',
      'netIncome',
      'assets',
      'liabilities',
      'equity',
      'eps',
      'per',
      'pbr',
      'dividend',
    ],
  },
];
export function CompanyInformation({ companyId }: { companyId: string }) {
  const query = useQuery(companyInformationQuery(companyId));
  if (query.isPending) return <LoadingState label="종목 기본정보를 불러오는 중입니다." />;
  if (query.isError)
    return (
      <ErrorState
        message="종목 기본정보를 불러오지 못했습니다."
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <div className="company-fundamentals">
      {groups.map((group) => {
        const fields = group.keys.flatMap((key) =>
          query.data.fields.filter((field) => field.key === key),
        );
        const period =
          group.title === '시세'
            ? fields.find((field) => field.key === 'close' && field.value)?.basis
            : group.title === '재무·배당'
              ? fields
                  .find((field) => field.value && field.basis.match(/\d{4}년/u))
                  ?.basis.replace(/ · 공시된.*$/u, '')
              : null;
        return (
          <section key={group.title}>
            <header>
              <h3>{group.title}</h3>
              {period ? <small>{period}</small> : null}
            </header>
            <dl>
              {fields.map((field) => (
                <div key={field.key}>
                  <dt>
                    {field.label}
                    {['per', 'pbr'].includes(field.key) && field.value ? (
                      <span className="sr-only"> {field.basis}</span>
                    ) : null}
                  </dt>
                  <dd title={field.value ? field.basis : undefined}>
                    {companyFieldValue(
                      field,
                      [
                        'marketCap',
                        'revenue',
                        'operatingProfit',
                        'netIncome',
                        'assets',
                        'liabilities',
                        'equity',
                      ].includes(field.key),
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        );
      })}
    </div>
  );
}
