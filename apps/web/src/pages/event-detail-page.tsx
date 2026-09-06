import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarClock,
  FileCheck2,
  Fingerprint,
  GitBranch,
  UserRound,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate, formatKst, formatMoney, formatNumber } from '../lib/format';
import { disclosureLabels, displayDomainText } from '../lib/domain-labels';
import {
  DirectionBadge,
  EventStateBadge,
  EventTypeBadge,
  EvidenceBadge,
  NatureBadge,
  PriorityBadge,
  RightsBadge,
} from '../components/domain-badges';
import { DisclosureFacts } from '../components/disclosure-facts';
import { ObservationDisclaimer } from '../components/disclaimer';
import { TranslatedText } from '../components/translated-text';
import { ArticleLanguageSwitch, useArticleLanguage } from '../components/article-language';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  ErrorState,
  LoadingState,
  Progress,
} from '../components/ui';

const classificationLabels = {
  RULE_CONFIRMED: '규칙 기반 확인',
  AI_CONFIRMED: 'AI + 규칙 확인',
  AI_SUGGESTED: 'AI 제안 · 미확정',
  REVIEW_REQUIRED: '사람 검토 필요',
} as const;

export function EventDetailPage() {
  const { id = '' } = useParams();
  const [language, setLanguage] = useArticleLanguage(id);
  const event = useQuery({
    queryKey: ['event', id],
    queryFn: ({ signal }) => api.event(id, signal),
    enabled: Boolean(id),
  });

  if (event.isPending) return <LoadingState label="공시 원문 근거를 불러오는 중입니다." />;
  if (event.isError)
    return <ErrorState message={event.error.message} onRetry={() => void event.refetch()} />;
  const data = event.data;
  const hasTranslation =
    data.detailType === 'NEWS' &&
    data.translation?.language === 'ko' &&
    Boolean(data.translation.title.trim());
  const showTranslation = hasTranslation && language === 'translation';

  return (
    <div className="page-stack detail-page">
      <Link className="back-link" to="/events">
        <ArrowLeft size={15} /> 이벤트 목록
      </Link>
      <section className="detail-heading">
        <div className="detail-heading__meta">
          <EventTypeBadge type={data.detailType} />
          <PriorityBadge priority={data.priority} />
          <EventStateBadge
            submissionKind={data.submissionKind}
            effectiveState={data.effectiveState}
          />
          <EvidenceBadge grade={data.evidenceGrade} />
        </div>
        <div className="detail-heading__title">
          <div>
            <Link to={`/companies/${data.companyId}`} className="company-link">
              {data.companyName}
              <ArrowUpRight size={15} />
            </Link>
            <TranslatedText
              title={data.title}
              description={data.summary}
              translation={showTranslation ? data.translation : null}
              heading="h2"
            />
            {hasTranslation ? (
              <ArticleLanguageSwitch language={language} onChange={setLanguage} />
            ) : null}
          </div>
          <a
            className="button button--primary button--md"
            href={data.officialUrl}
            target="_blank"
            rel="noreferrer"
          >
            공식 원문 <ArrowUpRight size={16} />
          </a>
        </div>
      </section>

      {data.detailType === 'D005' ? (
        <div className="semantic-callout semantic-callout--orange">
          <CalendarClock size={19} />
          <div>
            <strong>거래 예정 공시입니다.</strong>
            <p>
              계획의 변경·철회 또는 일부 집행 가능성이 있으므로 실제 거래로 계산하지 않습니다. 후속
              {disclosureLabels.D002} 공시와의 연결을 기다립니다.
            </p>
          </div>
        </div>
      ) : null}

      {data.detailType === 'SEC' ? (
        <div className="semantic-callout">
          <FileCheck2 size={19} aria-hidden="true" />
          <div>
            <strong>SEC 공시 접수 기록입니다.</strong>
            <p>
              공시 종류·접수일·원문 링크를 제공합니다. Form 4 거래 내역이나 8-K 본문 분석은 포함하지
              않습니다.
            </p>
          </div>
        </div>
      ) : null}

      {['D001', 'D003', 'D004', 'D005'].includes(data.detailType) ? (
        <DisclosureFacts data={data} />
      ) : null}

      <section className={data.detailType === 'SEC' ? 'page-stack' : 'detail-grid'}>
        {data.detailType === 'D002' ? (
          <Card>
            <CardHeader>
              <div>
                <span className="section-kicker">FACTS</span>
                <h2>보고 사실</h2>
              </div>
            </CardHeader>
            <CardContent>
              <dl className="fact-grid">
                <div>
                  <dt>신고자</dt>
                  <dd>{data.reporterName ?? data.filerName}</dd>
                </div>
                <div>
                  <dt>관계·직위</dt>
                  <dd>{[data.relationship, data.position].filter(Boolean).join(' · ') || '—'}</dd>
                </div>
                <div>
                  <dt>거래 성격</dt>
                  <dd>
                    <NatureBadge nature={data.nature} />
                  </dd>
                </div>
                <div>
                  <dt>소유 방향</dt>
                  <dd>
                    <DirectionBadge direction={data.direction} />
                  </dd>
                </div>
                <div>
                  <dt>변동 전</dt>
                  <dd className="mono">{formatNumber(data.ownershipBefore)}주</dd>
                </div>
                <div>
                  <dt>변동 후</dt>
                  <dd className="mono">{formatNumber(data.ownershipAfter)}주</dd>
                </div>
                <div>
                  <dt>수량 변화</dt>
                  <dd className="mono">{formatNumber(data.ownershipChange)}주</dd>
                </div>
                <div>
                  <dt>변동 후 비율</dt>
                  <dd>{data.ownershipRateAfter ? `${data.ownershipRateAfter}%` : '—'}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">TIMING</span>
              <h2>시간 구분</h2>
            </div>
          </CardHeader>
          <CardContent>
            <div className="time-sequence">
              {['D001', 'D002', 'D005'].includes(data.detailType) ? (
                <div>
                  <span className="time-sequence__dot" />
                  <div>
                    <small>{data.detailType === 'D005' ? '계획 시작일' : '실제 사건일'}</small>
                    <strong>{formatDate(data.eventAt)}</strong>
                    <p>
                      {data.detailType === 'D005' ? '실제 거래일과 구분' : '거래·소유변동 기준일'}
                    </p>
                  </div>
                </div>
              ) : null}
              <div>
                <span className="time-sequence__dot" />
                <div>
                  <small>{data.rceptDate ? '공시 접수일' : '게시 시각'}</small>
                  <strong>
                    {data.rceptDate ? formatDate(data.rceptDate) : formatKst(data.publishedAt)}
                  </strong>
                  <p>
                    {data.rceptDate
                      ? data.detailType === 'SEC'
                        ? 'SEC가 제공하는 공시 접수 날짜'
                        : 'OpenDART가 제공하는 날짜 전용 필드'
                      : '소스가 제공한 게시 timestamp'}
                  </p>
                </div>
              </div>
              <div>
                <span className="time-sequence__dot" />
                <div>
                  <small>최초 감지</small>
                  <strong>{formatKst(data.firstObservedAt)}</strong>
                  <p>ORSEM이 처음 확인한 시각</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {data.detailType === 'D002' ? (
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">TRANSACTIONS</span>
              <h2>원문 거래 내역</h2>
            </div>
            <Badge tone={data.classificationStatus === 'REVIEW_REQUIRED' ? 'orange' : 'teal'}>
              {classificationLabels[data.classificationStatus]}
            </Badge>
          </CardHeader>
          <CardContent>
            {data.transactions.length ? (
              <div className="transaction-list">
                {data.transactions.map((transaction) => (
                  <article className="transaction-card" key={transaction.id}>
                    <div className="transaction-card__head">
                      <NatureBadge nature={transaction.nature} />
                      <DirectionBadge direction={transaction.direction} />
                      <span>{formatDate(transaction.eventDate)}</span>
                    </div>
                    <dl className="transaction-grid">
                      <div>
                        <dt>수량</dt>
                        <dd>{formatNumber(transaction.quantity)}주</dd>
                      </div>
                      <div>
                        <dt>단가</dt>
                        <dd>{formatMoney(transaction.unitPrice, transaction.currency)}</dd>
                      </div>
                      <div>
                        <dt>거래금액</dt>
                        <dd>{formatMoney(transaction.amount, transaction.currency)}</dd>
                      </div>
                      <div>
                        <dt>거래 후</dt>
                        <dd>{formatNumber(transaction.sharesAfter)}주</dd>
                      </div>
                    </dl>
                    <div className="raw-field">
                      <span>원문 방법</span>
                      <code>{transaction.methodRaw}</code>
                    </div>
                    <div className="confidence">
                      <span>파서 확신도 {Math.round(transaction.parserConfidence * 100)}%</span>
                      <Progress value={transaction.parserConfidence * 100} label="파서 확신도" />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="semantic-callout">
                <Fingerprint size={18} />
                <div>
                  <strong>구조화된 거래 행이 없습니다.</strong>
                  <p>
                    해당 공시는 거래별 행이 없거나 아직 파싱·검토 중입니다. 방향을 임의로 추정하지
                    않습니다.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <section className="detail-grid detail-grid--evidence">
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">EVIDENCE</span>
              <h2>출처와 이용 범위</h2>
            </div>
          </CardHeader>
          <CardContent className="evidence-list">
            {data.evidence.map((evidence) => (
              <article className="evidence-item" key={evidence.id}>
                <div className="evidence-item__icon">
                  <FileCheck2 size={18} />
                </div>
                <div>
                  <div className="evidence-item__badges">
                    <EvidenceBadge grade={evidence.grade} />
                    <RightsBadge status={evidence.rightsMode} />
                    {evidence.isOfficial ? <Badge tone="teal">공식</Badge> : <Badge>보조</Badge>}
                  </div>
                  <strong>{evidence.sourceName}</strong>
                  {!showTranslation ||
                  (evidence.translation?.language === 'ko' && evidence.translation.title.trim()) ? (
                    <TranslatedText
                      title={evidence.title}
                      description={evidence.description}
                      translation={showTranslation ? evidence.translation : null}
                    />
                  ) : (
                    <p>이 출처의 번역은 제공되지 않습니다. 원문에서 확인하세요.</p>
                  )}
                  {!showTranslation ? <p>{evidence.excerpt}</p> : null}
                  <span>
                    {evidence.publishedAt ? `게시 ${formatKst(evidence.publishedAt)} · ` : ''}감지{' '}
                    {formatKst(evidence.firstObservedAt)}
                  </span>
                </div>
                <a
                  href={evidence.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${evidence.sourceName} 원문 열기`}
                  title="원문 열기"
                >
                  <ArrowUpRight size={17} />
                </a>
              </article>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <span className="section-kicker">LINEAGE</span>
              <h2>정정 계보</h2>
            </div>
          </CardHeader>
          <CardContent>
            <div className="lineage-list">
              {data.lineage.map((item, index) => (
                <div className="lineage-item" key={item.id}>
                  <span className="lineage-item__node">
                    <GitBranch size={15} />
                  </span>
                  <div>
                    <strong>{item.label}</strong>
                    <small>
                      {item.rceptDate
                        ? `접수 ${formatDate(item.rceptDate)}`
                        : formatKst(item.publishedAt)}
                    </small>
                  </div>
                  <EventStateBadge
                    submissionKind={item.submissionKind}
                    effectiveState={item.effectiveState}
                  />
                  {index < data.lineage.length - 1 ? <i /> : null}
                </div>
              ))}
            </div>
            <div className="parser-meta">
              <UserRound size={15} />
              <span>파서 {data.parserVersion ?? '해당 없음'} · 원문 필드 보존</span>
            </div>
          </CardContent>
        </Card>
      </section>

      <aside className="limitations">
        <strong>해석 한계</strong>
        <ul>
          {data.limitations.map((limitation) => (
            <li key={limitation}>{displayDomainText(limitation)}</li>
          ))}
        </ul>
      </aside>
      <ObservationDisclaimer />
    </div>
  );
}
