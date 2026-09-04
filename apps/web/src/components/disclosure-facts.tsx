import type { EventDetail } from '../types';
import { formatDate, formatKst } from '../lib/format';
import { Card, CardContent, CardHeader } from './ui';
import './disclosure-facts.css';

/** Decimal strings retain their source precision, including amounts larger than JS safe integers. */
export function exactDisclosureNumber(value: string | null | undefined, unit = ''): string {
  if (value == null || value === '') return '—';
  const [integer, fraction] = value.split('.');
  return `${integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}${unit}`;
}

function Fact({ name, value }: { name: string; value: string | null | undefined }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value || '—'}</dd>
    </div>
  );
}

function period(start: string | null, end: string | null): string {
  return start || end ? `${formatDate(start)} ~ ${formatDate(end)}` : '—';
}

export function DisclosureFacts({
  data,
}: {
  data: Pick<
    EventDetail,
    | 'detailType'
    | 'largeHolding'
    | 'proxySolicitation'
    | 'tenderOffer'
    | 'tradePlan'
    | 'parserVersion'
  >;
}) {
  const proxy = data.proxySolicitation;
  const tender = data.tenderOffer;
  const holding = data.largeHolding;
  const plan = data.tradePlan;
  const hasFacts = Boolean(proxy || tender || holding || plan);
  return (
    <Card className="disclosure-facts">
      <CardHeader>
        <div>
          <span className="section-kicker">FACTS</span>
          <h2>
            {data.detailType === 'D003'
              ? '의결권 위임 권유 주요내용'
              : data.detailType === 'D004'
                ? '공개매수 주요내용'
                : data.detailType === 'D005'
                  ? '주식 거래계획 주요내용'
                  : '대량보유 보고 내용'}
          </h2>
        </div>
      </CardHeader>
      <CardContent>
        <p className="disclosure-facts__status">
          {hasFacts
            ? '원문 근거 · 검증 후 활성화된 추출 결과'
            : '원문 근거 · 검증된 주요내용 대기 중입니다. 공식 원문을 확인해 주세요.'}
        </p>
        {proxy ? (
          <>
            <p>의결권 대리행사를 권유하는 내용입니다. 주식 거래·보유 변동으로 계산하지 않습니다.</p>
            <dl className="fact-grid">
              <Fact name="권유자" value={proxy.solicitorName} />
              <Fact name="대상 회사" value={proxy.targetCompanyName} />
              <Fact name="대상 회사와의 관계" value={proxy.relationshipRaw} />
              <Fact name="주주총회 날짜" value={formatDate(proxy.meetingDate)} />
              <Fact
                name="주주총회 시간"
                value={proxy.meetingAt ? formatKst(proxy.meetingAt) : proxy.meetingTimeRaw}
              />
              <Fact name="총회 장소" value={proxy.meetingLocation} />
              <Fact
                name="권유 기간"
                value={period(proxy.solicitationStartDate, proxy.solicitationEndDate)}
              />
              <Fact
                name="전자투표"
                value={
                  proxy.electronicVoting === null
                    ? null
                    : proxy.electronicVoting
                      ? '가능'
                      : '미실시'
                }
              />
              <Fact name="권유 목적" value={proxy.purposeRaw} />
            </dl>
            <h3>주주총회 안건</h3>
            {proxy.agendas.length ? (
              <ol className="disclosure-facts__agendas">
                {proxy.agendas.map((item) => (
                  <li key={item.ordinal}>{item.title}</li>
                ))}
              </ol>
            ) : (
              <p>확인된 안건이 없습니다.</p>
            )}
          </>
        ) : null}
        {tender ? (
          <>
            <p>
              {tender.documentKind === 'RESULT'
                ? '공개매수 결과 보고입니다. 응모 수량과 실제 취득 수량을 구분합니다.'
                : '공개매수 예정 조건입니다. 예정·청약 수량을 실제 취득으로 계산하지 않습니다.'}
            </p>
            <dl className="fact-grid">
              <Fact
                name="문서 구분"
                value={
                  {
                    REPORT: '공개매수 신고',
                    EXPLANATION: '공개매수 설명',
                    RESULT: '공개매수 결과',
                    OTHER: '기타 문서',
                  }[tender.documentKind]
                }
              />
              <Fact name="공개매수자" value={tender.offerorName} />
              <Fact name="대상 회사" value={tender.targetCompanyName} />
              <Fact
                name="청약 기간"
                value={period(tender.subscriptionStartDate, tender.subscriptionEndDate)}
              />
              <Fact name="결제일" value={formatDate(tender.settlementDate)} />
              <Fact name="목적" value={tender.purposeRaw} />
              <Fact name="조건" value={tender.conditionsRaw} />
            </dl>
            <h3>증권별 조건·결과</h3>
            <div className="disclosure-facts__securities">
              {tender.securities.map((row) => (
                <section key={row.rowIndex}>
                  <h4>{row.securityTypeRaw || '증권 종류 미확인'}</h4>
                  <dl className="fact-grid">
                    <Fact
                      name="공개매수 가격"
                      value={exactDisclosureNumber(
                        row.unitPrice,
                        row.currency ? ` ${row.currency}` : '',
                      )}
                    />
                    <Fact
                      name="최소 예정 수량"
                      value={exactDisclosureNumber(row.minQuantity, '주')}
                    />
                    <Fact
                      name="최대 예정 수량"
                      value={exactDisclosureNumber(row.maxQuantity, '주')}
                    />
                    <Fact
                      name="기존 보유 수량"
                      value={exactDisclosureNumber(row.heldQuantity, '주')}
                    />
                    <Fact
                      name="취득 후 예상 보유 최소"
                      value={exactDisclosureNumber(row.expectedHoldingsMin, '주')}
                    />
                    <Fact
                      name="취득 후 예상 보유 최대"
                      value={exactDisclosureNumber(row.expectedHoldingsMax, '주')}
                    />
                    {tender.documentKind === 'RESULT' ? (
                      <>
                        <Fact
                          name="응모 수량"
                          value={exactDisclosureNumber(row.offeredQuantity, '주')}
                        />
                        <Fact
                          name="실제 취득 수량"
                          value={exactDisclosureNumber(row.acquiredQuantity, '주')}
                        />
                        <Fact
                          name="실제 취득 금액"
                          value={exactDisclosureNumber(
                            row.actualAmount,
                            row.currency ? ` ${row.currency}` : '',
                          )}
                        />
                      </>
                    ) : null}
                  </dl>
                </section>
              ))}
            </div>
            {!tender.securities.length ? <p>확인된 증권별 조건이 없습니다.</p> : null}
          </>
        ) : null}
        {plan ? (
          <>
            <p>
              앞으로의 거래 계획입니다. 계획 수량·금액을 실제 체결로 계산하지 않으며 후속 보유
              공시로 집행을 확인합니다.
            </p>
            <dl className="fact-grid">
              <Fact name="계획 기간" value={period(plan.plannedStartDate, plan.plannedEndDate)} />
              <Fact name="계획 수량" value={exactDisclosureNumber(plan.plannedQuantity, '주')} />
              <Fact name="계획 금액" value={exactDisclosureNumber(plan.plannedAmount, ' KRW')} />
              <Fact name="원문 방법" value={plan.methodRaw} />
              <Fact
                name="계획 상태"
                value={
                  {
                    PLANNED: '계획됨',
                    PARTIALLY_EXECUTED: '일부 집행',
                    EXECUTED: '집행 확인',
                    CANCELLED: '취소됨',
                  }[plan.planStatus]
                }
              />
            </dl>
          </>
        ) : null}
        {holding ? (
          <>
            <p>
              {holding.reportReasonKind === 'CONTRACT_CHANGE'
                ? '주요 계약 변경 보고입니다. 거래가 없는 보고를 미분류 거래로 보지 않습니다.'
                : holding.reportReasonKind === 'REPORTING_STATUS_CHANGE'
                  ? '보고자 지위 변경 보고입니다. 거래가 없는 보고를 미분류 거래로 보지 않습니다.'
                  : '보유 수량과 보고 사유를 구분합니다. 수량 증가만으로 장내매수를 추정하지 않습니다.'}
            </p>
            <dl className="fact-grid">
              <Fact name="보고자" value={holding.reporterName} />
              <Fact name="보고 사유" value={holding.reportReasonRaw} />
              <Fact name="보유 목적" value={holding.holdingPurposeRaw} />
              <Fact name="변동 전 보유" value={exactDisclosureNumber(holding.sharesBefore, '주')} />
              <Fact name="변동 후 보유" value={exactDisclosureNumber(holding.sharesAfter, '주')} />
              <Fact
                name="변동 전 비율"
                value={exactDisclosureNumber(holding.ownershipRateBefore, '%')}
              />
              <Fact
                name="변동 후 비율"
                value={exactDisclosureNumber(holding.ownershipRateAfter, '%')}
              />
            </dl>
            {holding.changes.length ? (
              <>
                <h3>보유 변동 내역</h3>
                <ul className="disclosure-facts__agendas">
                  {holding.changes.map((row) => (
                    <li key={row.id}>
                      {formatDate(row.eventDate)} · {row.methodRaw ?? '원문 방법 미기재'} ·{' '}
                      {exactDisclosureNumber(row.shareChange, '주')}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>확인된 거래·보유변동 행이 없습니다.</p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
