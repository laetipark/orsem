import { Badge } from './ui';
import { disclosureDescriptions, disclosureLabels, priorityLabels } from '../lib/domain-labels';
import './domain-badges.css';
import type {
  Direction,
  DisclosureType,
  EffectiveState,
  EvidenceGrade,
  Priority,
  RightsMode,
  SubmissionKind,
  TransactionNature,
} from '../types';

const natureLabels: Record<TransactionNature, string> = {
  MARKET_BUY: '장내매수',
  MARKET_SELL: '장내매도',
  BLOCK_BUY: '시간외 취득',
  BLOCK_SELL: '시간외 처분',
  OFF_MARKET_BUY: '장외매수',
  OFF_MARKET_SELL: '장외매도',
  AFTER_HOURS_BUY: '시간외매수',
  AFTER_HOURS_SELL: '시간외매도',
  STOCK_COMPENSATION: '주식 보상',
  NEW_SHARE_SUBSCRIPTION: '신주 인수',
  SECURITIES_SUBSCRIPTION: '증권 인수',
  STOCK_LENDING: '주식 대차',
  REPORTING_STATUS_CHANGE: '보고자 지위 변경',
  RIGHTS_CHANGE: '권리 변경',
  STOCK_DIVIDEND: '주식 배당',
  CAPITAL_REDUCTION: '감자',
  GIFT_CANCELLATION: '증여 취소',
  TENDER_OFFER_APPLICATION: '공개매수 응모',
  GIFT_IN: '수증',
  GIFT_OUT: '증여',
  OPTION_EXERCISE: '스톡옵션 행사',
  RSU_RSA: 'RSU·RSA',
  CONVERSION: '전환·권리행사',
  STOCK_SPLIT_MERGER: '합병·분할',
  TRUST_TRANSFER: '신탁 이전',
  INHERITANCE: '상속',
  OTHER: '기타',
  UNKNOWN: '미분류',
};

export function EventTypeBadge({ type }: { type: DisclosureType }) {
  const map: Record<
    DisclosureType,
    { label: string; tone: 'teal' | 'orange' | 'blue' | 'violet' | 'neutral' }
  > = {
    D001: { label: disclosureLabels.D001, tone: 'violet' },
    D002: { label: disclosureLabels.D002, tone: 'teal' },
    D003: { label: disclosureLabels.D003, tone: 'blue' },
    D004: { label: disclosureLabels.D004, tone: 'violet' },
    D005: { label: disclosureLabels.D005, tone: 'orange' },
    NEWS: { label: disclosureLabels.NEWS, tone: 'blue' },
    SEC: { label: disclosureLabels.SEC, tone: 'neutral' },
  };
  const item = map[type];
  return (
    <Badge className="domain-badge" tone={item.tone} title={disclosureDescriptions[type]}>
      {item.label}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  const tone = priority === 'P1' ? 'orange' : priority === 'P2' ? 'teal' : 'neutral';
  return (
    <Badge className="domain-badge" tone={tone}>
      {priorityLabels[priority]}
    </Badge>
  );
}

export function NatureBadge({ nature }: { nature: TransactionNature | null }) {
  if (!nature) return <Badge>해당 없음</Badge>;
  const tone = nature === 'UNKNOWN' ? 'orange' : nature.startsWith('MARKET_') ? 'teal' : 'blue';
  return <Badge tone={tone}>{natureLabels[nature]}</Badge>;
}

export function DirectionBadge({ direction }: { direction: Direction }) {
  const labels: Record<Direction, string> = {
    INCREASE: '보유 증가',
    DECREASE: '보유 감소',
    NEUTRAL: '중립',
    UNKNOWN: '방향 미확인',
  };
  return <Badge tone={direction === 'UNKNOWN' ? 'orange' : 'neutral'}>{labels[direction]}</Badge>;
}

export function EvidenceBadge({ grade }: { grade: EvidenceGrade }) {
  return (
    <Badge tone={grade === 'A' ? 'teal' : grade === 'UNVERIFIED' ? 'orange' : 'neutral'}>
      근거 {grade}
    </Badge>
  );
}

export function RightsBadge({ status }: { status: RightsMode }) {
  const labels: Record<RightsMode, string> = {
    OFFICIAL_PUBLIC_DATA: '공식 공개데이터',
    PRIVATE_DISPLAY_ONLY: '개인 화면만',
    STORE_METADATA_ONLY: '메타데이터만',
    LINK_ONLY: '링크만',
    NO_REDISTRIBUTION: '재배포 금지',
  };
  return (
    <Badge
      tone={status === 'OFFICIAL_PUBLIC_DATA' ? 'teal' : status === 'LINK_ONLY' ? 'blue' : 'orange'}
    >
      {labels[status]}
    </Badge>
  );
}

export function EventStateBadge({
  submissionKind,
  effectiveState,
}: {
  submissionKind: SubmissionKind;
  effectiveState: EffectiveState;
}) {
  const labels: Record<SubmissionKind, string> = {
    INITIAL: '최초',
    CORRECTION: '정정',
    ATTACHMENT_CORRECTION: '첨부정정',
    WITHDRAWAL: '철회',
    UNKNOWN: '제출종류 미확인',
  };
  const suffix =
    effectiveState === 'SUPERSEDED'
      ? ' · 대체됨'
      : effectiveState === 'ACTIVE'
        ? ''
        : ` · ${effectiveState}`;
  return (
    <Badge
      tone={
        submissionKind === 'INITIAL'
          ? 'neutral'
          : submissionKind === 'CORRECTION'
            ? 'orange'
            : 'red'
      }
    >
      {labels[submissionKind]}
      {suffix}
    </Badge>
  );
}
