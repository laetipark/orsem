import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpRight,
  Braces,
  CheckCircle2,
  CircleHelp,
  GitMerge,
  ShieldAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import { disclosureLabels, displayDomainText } from '../lib/domain-labels';
import type { ReviewItem, ReviewResolution } from '../types';
import { EventTypeBadge, NatureBadge } from '../components/domain-badges';
import { ObservationDisclaimer } from '../components/disclaimer';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Progress,
} from '../components/ui';

const resolutions: Array<{
  value: ReviewResolution['resolution'];
  label: string;
  description: string;
  icon: typeof CheckCircle2;
}> = [
  {
    value: 'CONFIRMED',
    label: '분류 확인',
    description: '원문과 제안 분류가 일치함',
    icon: CheckCircle2,
  },
  {
    value: 'UNKNOWN',
    label: 'UNKNOWN 유지',
    description: '근거 부족 · 추정하지 않음',
    icon: CircleHelp,
  },
  {
    value: 'CORRECTION_LINKED',
    label: '정정 연결',
    description: '원공시와 정정 계보로 연결',
    icon: GitMerge,
  },
  { value: 'DUPLICATE', label: '중복 처리', description: '같은 사건의 반복 수집 건', icon: Braces },
];

export function ReviewCard({
  review,
  onResolve,
  pending,
  onConfirmSource,
}: {
  review: ReviewItem;
  onResolve: (
    resolution: ReviewResolution['resolution'],
    note: string | null,
    planExecutionMatchId?: string,
  ) => void;
  pending: boolean;
  onConfirmSource?: (note: string | null) => void;
}) {
  const [selected, setSelected] = useState<ReviewResolution['resolution']>('CONFIRMED');
  const [note, setNote] = useState('');
  const [selectedMatchId, setSelectedMatchId] = useState(
    review.planExecutionCandidates?.[0]?.matchId,
  );
  const unsupported = review.classificationStatus === 'UNSUPPORTED';
  const cannotActivate = unsupported || review.validationStatus === 'REJECTED';
  const sourceReviewPending = review.sourceReviewRequired && !review.sourceReviewConfirmed;
  const crosscheckPending =
    review.staged &&
    !cannotActivate &&
    review.crosscheckReady !== true &&
    !review.sourceReviewRequired;
  return (
    <article className="review-card">
      <div className="review-card__heading">
        <span className="review-index">
          <ShieldAlert size={18} />
        </span>
        <div>
          <div>
            {unsupported ? (
              <Badge>지원 범위 밖 공시</Badge>
            ) : (
              <EventTypeBadge type={review.detailType} />
            )}
            <Badge tone="orange">검토 필요</Badge>
          </div>
          <h3>{review.companyName}</h3>
          <p>{displayDomainText(review.reason)}</p>
        </div>
        {(unsupported || review.sourceReviewRequired) && review.officialUrl ? (
          <a
            href={review.officialUrl}
            target="_blank"
            rel="noreferrer"
            title="공시 원문 열기"
            aria-label={`${review.companyName} 공시 원문 열기`}
          >
            <ArrowUpRight size={18} />
          </a>
        ) : (
          <Link
            to={`/events/${review.eventId}`}
            title="이벤트 근거 열기"
            aria-label={`${review.companyName} 이벤트 근거 열기`}
          >
            <ArrowUpRight size={18} />
          </Link>
        )}
      </div>
      {!review.sourceReviewRequired ? (
        <div className="review-evidence-grid">
          <div>
            <span>원문 method</span>
            <code>{review.methodRaw ?? '필드 없음'}</code>
          </div>
          <div>
            <span>추출 문맥</span>
            <blockquote>{review.extractedText ?? '추출된 문맥이 없습니다.'}</blockquote>
          </div>
          <div>
            <span>제안 분류</span>
            <NatureBadge nature={review.proposedNature} />
          </div>
          <div>
            <span>파서 확신도 · {Math.round(review.parserConfidence * 100)}%</span>
            <Progress value={review.parserConfidence * 100} label="파서 확신도" />
          </div>
        </div>
      ) : null}
      {review.staged || review.sourceReviewRequired ? (
        <details
          className="review-candidate-evidence"
          open={Boolean(crosscheckPending || sourceReviewPending)}
        >
          <summary>
            {review.sourceReviewRequired
              ? `원문 대조용 비활성 주요내용 · ${review.candidateRowCount ?? 0}개 목록`
              : `비활성 추출 근거 · ${review.candidateRowCount ?? 0}행`}
          </summary>
          <p>
            {review.sourceReviewRequired
              ? '이 유형은 공식 요약 API가 없습니다. 아래 주요내용과 공식 원문 전체를 대조한 뒤 원문 대조 완료를 기록하고, 다시 별도로 확정하세요.'
              : `공식 요약 검증: ${review.crosscheckStatus ?? '미실행'}. 먼저 공식 요약을 조회하고, 원문 전체와 추출 값을 확인한 뒤 다시 확정하세요.`}
          </p>
          {review.candidateEvidence?.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
          {!review.sourceReviewRequired && (review.candidateRowCount ?? 0) > 5 ? (
            <p>앞의 5행만 표시합니다. 전체 행은 원문과 파싱 감사 결과에서 확인하세요.</p>
          ) : null}
          {review.officialUrl ? (
            <a href={review.officialUrl} target="_blank" rel="noreferrer">
              공시 원문 확인
            </a>
          ) : null}
          {review.crosscheckEvidence ? (
            <pre>{JSON.stringify(review.crosscheckEvidence, null, 2)}</pre>
          ) : null}
          {review.candidateWarnings?.length ? (
            <details>
              <summary>추출·검증 유의사항</summary>
              {review.candidateWarnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          ) : null}
        </details>
      ) : null}
      {review.planExecutionCandidates?.length ? (
        <fieldset className="review-match-candidates">
          <legend>
            {disclosureLabels.D005}과 {disclosureLabels.D002} 공시 연결 후보
          </legend>
          <p>
            확정할 실제 계획 연결을 선택하세요. 수량이나 방법이 다르면 UNKNOWN으로 남길 수 있습니다.
          </p>
          <div>
            {review.planExecutionCandidates.map((candidate) => (
              <label
                key={candidate.matchId}
                className={selectedMatchId === candidate.matchId ? 'active' : ''}
              >
                <input
                  type="radio"
                  name={`plan-match-${review.id}`}
                  value={candidate.matchId}
                  checked={selectedMatchId === candidate.matchId}
                  onChange={() => setSelectedMatchId(candidate.matchId)}
                />
                <span>
                  <strong>
                    {candidate.eventDate ?? '거래일 미확인'} · 일치도{' '}
                    {Math.round(candidate.confidence * 100)}%
                  </strong>
                  <small>
                    실행 {candidate.actualQuantity ?? '—'}주 / 계획{' '}
                    {candidate.plannedQuantity ?? '—'}주
                  </small>
                  <small>
                    {candidate.actualMethodRaw} / {candidate.plannedMethodRaw ?? '계획 방법 미기재'}
                  </small>
                  <small>일치 필드: {candidate.matchedFields.join(', ') || '없음'}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="review-resolution" role="radiogroup" aria-label="검토 결과">
        {resolutions.map(({ value, label, description, icon: Icon }) => (
          <button
            key={value}
            className={selected === value ? 'active' : ''}
            role="radio"
            aria-checked={selected === value}
            onClick={() => setSelected(value)}
          >
            <Icon size={16} />
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
          </button>
        ))}
      </div>
      {review.sourceReviewRequired ? (
        <div className="review-source-review">
          <p>
            {review.sourceReviewConfirmed
              ? `원문 대조 기록 완료 · ${formatKst(review.sourceReviewConfirmedAt ?? null)}`
              : '공식 원문 전체와 추출된 주요내용을 직접 대조해야 합니다. 이 단계에서는 활성화하거나 알림을 발송하지 않습니다.'}
          </p>
          {!review.sourceReviewConfirmed ? (
            <Button
              disabled={pending || cannotActivate || !onConfirmSource}
              onClick={() => onConfirmSource?.(note.trim() || null)}
            >
              원문 대조 완료 기록
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="review-card__action">
        <Input
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="선택 근거 메모 (선택)"
          aria-label="검토 근거 메모"
        />
        <Button
          onClick={() =>
            onResolve(
              selected,
              note.trim() || null,
              review.planExecutionCandidates?.some(
                (candidate) => candidate.matchId === selectedMatchId,
              )
                ? selectedMatchId
                : undefined,
            )
          }
          disabled={
            pending || ((cannotActivate || sourceReviewPending) && selected === 'CONFIRMED')
          }
        >
          {sourceReviewPending && selected === 'CONFIRMED'
            ? '먼저 원문 대조 필요'
            : cannotActivate && selected === 'CONFIRMED'
              ? '추출 검증 필요'
              : crosscheckPending && selected === 'CONFIRMED'
                ? '공식 요약 검증'
                : '검토 확정'}
        </Button>
      </div>
      <time>생성 {formatKst(review.createdAt)}</time>
    </article>
  );
}

export function ReviewsPage() {
  const queryClient = useQueryClient();
  const reviews = useInfiniteQuery({
    queryKey: ['reviews'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.reviews(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const integrity = useQuery({ queryKey: ['parse-integrity'], queryFn: api.parseIntegrity });
  const items = reviews.data?.pages.flatMap((page) => page.items) ?? [];
  const confirmSource = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string | null }) =>
      api.confirmReviewSource(id, note),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['reviews'] }),
  });
  const resolve = useMutation({
    mutationFn: ({
      id,
      resolution,
      note,
      planExecutionMatchId,
    }: {
      id: string;
      resolution: ReviewResolution['resolution'];
      note: string | null;
      planExecutionMatchId?: string;
    }) => api.resolveReview(id, resolution, note, planExecutionMatchId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reviews'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['parse-integrity'] }),
      ]);
    },
  });

  return (
    <div className="page-stack">
      <div className="page-lead">
        <div>
          <p>
            낮은 확신도, 정정 연결, 공식 원문 미확인 항목만 사람이 판정합니다. 근거가 부족하면
            UNKNOWN이 정답입니다.
          </p>
        </div>
      </div>
      <Card>
        <CardHeader>
          <div>
            <span className="section-kicker">HUMAN-IN-THE-LOOP</span>
            <h2>
              분류 검토 대기 {integrity.data ? `${integrity.data.currentReviewSubjects}건` : ''}
            </h2>
            {reviews.data ? <p>현재 {items.length}건 표시</p> : null}
          </div>
          <Badge tone="orange">자동 시그널 생성 안 함</Badge>
        </CardHeader>
        <CardContent className="review-list">
          {reviews.isPending ? <LoadingState label="검토 대기열을 불러오는 중입니다." /> : null}
          {reviews.isError ? (
            <ErrorState message={reviews.error.message} onRetry={() => void reviews.refetch()} />
          ) : null}
          {resolve.isError || confirmSource.isError ? (
            <p role="alert" className="form-error">
              {resolve.error?.message ?? confirmSource.error?.message}
            </p>
          ) : null}
          {items.map((review) => (
            <ReviewCard
              key={review.id}
              review={review}
              pending={
                (resolve.isPending && resolve.variables?.id === review.id) ||
                (confirmSource.isPending && confirmSource.variables?.id === review.id)
              }
              onConfirmSource={(note) => confirmSource.mutate({ id: review.id, note })}
              onResolve={(resolution, note, planExecutionMatchId) =>
                resolve.mutate({
                  id: review.id,
                  resolution,
                  note,
                  planExecutionMatchId,
                })
              }
            />
          ))}
          {reviews.hasNextPage ? (
            <Button
              disabled={reviews.isFetchingNextPage}
              onClick={() => void reviews.fetchNextPage()}
            >
              {reviews.isFetchingNextPage ? '불러오는 중…' : '검토 항목 더 보기'}
            </Button>
          ) : null}
          {reviews.data && !items.length ? (
            <EmptyState
              title="검토 대기열이 비었습니다"
              description="규칙으로 확정할 수 없거나 근거가 부족한 항목이 들어오면 여기에 표시됩니다."
            />
          ) : null}
        </CardContent>
      </Card>
      <ObservationDisclaimer compact />
    </div>
  );
}
