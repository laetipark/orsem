import type {
  CanonicalTable,
  DisclosureDocumentContext,
  ParsedD003Report,
  ParsedProxyAgenda,
  ParserWarning,
} from '../types';
import { disclosureBodyTables, fieldProvenance, summaryProvenance } from './shared';
import {
  dateTokens,
  documentProvenance,
  findCodedField,
  findColumnField,
  findField,
  requiredFieldsWarning,
  singleDate,
} from './narrative-shared';

type D003Facts = Omit<
  ParsedD003Report,
  'detailType' | 'parserVersion' | 'source' | 'tablesScanned'
>;
export interface D003Extraction extends D003Facts {
  readonly score: number;
}

export function meetingInstant(
  date: string | null,
  raw: string | null,
): { meetingTimeRaw: string | null; meetingAt: string | null } {
  if (!date || !raw) return { meetingTimeRaw: null, meetingAt: null };
  const match = /(오전|오후)?\s*(\d{1,2})\s*(?:시(?:\s*(\d{1,2})\s*분)?|:(\d{2}))/u.exec(
    raw.replace(/\d{4}\s*(?:년|[./-])\s*\d{1,2}\s*(?:월|[./-])\s*\d{1,2}\s*일?/u, ''),
  );
  if (!match) return { meetingTimeRaw: null, meetingAt: null };
  let hour = Number(match[2]);
  const minute = Number(match[3] ?? match[4] ?? 0);
  if (hour > 23 || minute > 59 || (match[1] && (hour < 1 || hour > 12)))
    return { meetingTimeRaw: match[0].trim(), meetingAt: null };
  if (match[1]) hour = (hour % 12) + (match[1] === '오후' ? 12 : 0);
  return {
    meetingTimeRaw: match[0].trim(),
    meetingAt: new Date(
      `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`,
    ).toISOString(),
  };
}

export function extractD003(
  tables: readonly CanonicalTable[],
  context: DisclosureDocumentContext,
): D003Extraction {
  tables = disclosureBodyTables(tables);
  const warnings: ParserWarning[] = [];
  const summaries = tables.filter(
    (table) =>
      table.rows.some((row) => row.some((text) => /권유자/.test(text))) &&
      table.rows.some((row) => row.some((text) => /권유취지|권유시작일|권유 시작일/.test(text))),
  );
  const summary = summaries[0];
  if (summaries.length > 1)
    warnings.push({
      code: 'AMBIGUOUS_DISCLOSURE_SUMMARY',
      message: '의결권 권유 요약표가 여러 개입니다.',
    });
  const selected = summary ? [summary] : [];
  const located = {
    solicitorName: findCodedField(selected, ['REC_NM']) ?? findField(selected, ['권유자']),
    relationshipRaw:
      findCodedField(selected, ['REC_COP_RL']) ?? findField(selected, ['회사와의 관계']),
    purposeRaw: findCodedField(selected, ['REC_PPS']) ?? findField(selected, ['권유취지']),
    meetingDate: findField(selected, ['주주총회일']),
    meetingDateTime: findField(
      tables.filter((t) => t.rows.some((r) => r.some((v) => /^장\s*소$/u.test(v)))),
      ['일시'],
    ),
    meetingLocation: findField(tables, ['장소']),
    solicitationStartDate:
      findColumnField(
        tables.filter((t) =>
          t.rows.some((r) => r.some((v) => /권유종료일/u.test(v.replace(/\s/g, '')))),
        ),
        ['권유시작일'],
      ) ?? findField(selected, ['권유시작일']),
    solicitationEndDate: findColumnField(tables, ['권유종료일']),
    electronicVoting: findField(selected, ['전자/서면투표여부']),
  };
  const solicitorName = located.solicitorName?.value ?? null;
  const targetCompanyName = context.companyName;
  const summaryDate = singleDate(located.meetingDate, 'meetingDate', warnings);
  const detailDates = dateTokens(located.meetingDateTime?.value ?? '');
  const meetingDate = detailDates.length === 1 ? detailDates[0]! : summaryDate;
  if (summaryDate && meetingDate !== summaryDate)
    warnings.push({
      code: 'DISCLOSURE_DATE_CONFLICT',
      message: '총회 요약 날짜와 상세 일시가 일치하지 않습니다.',
      field: 'meetingDate',
    });
  const timing = meetingInstant(meetingDate, located.meetingDateTime?.value ?? null);
  if (timing.meetingTimeRaw && !timing.meetingAt)
    warnings.push({
      code: 'INVALID_MEETING_TIME',
      message: '총회 시각이 유효하지 않습니다.',
      field: 'meetingAt',
    });
  const solicitationStartDate = singleDate(
    located.solicitationStartDate,
    'solicitationStartDate',
    warnings,
  );
  const solicitationEndDate = singleDate(
    located.solicitationEndDate,
    'solicitationEndDate',
    warnings,
  );
  if (solicitationStartDate && solicitationEndDate && solicitationStartDate > solicitationEndDate)
    warnings.push({
      code: 'INVALID_DATE_RANGE',
      message: '권유 시작일이 종료일보다 늦습니다.',
      field: 'solicitationEndDate',
    });
  const vote = located.electronicVoting?.value.replace(/\s/g, '') ?? '';
  const electronicVoting = /^전자투표가능$/u.test(vote)
    ? true
    : /^(?:해당사항없음|전자투표불가|전자투표불가능)$/u.test(vote)
      ? false
      : null;
  const agendas: ParsedProxyAgenda[] = [];
  if (summary) {
    const start = summary.rows.findIndex((row) =>
      row.some((text) => /주주총회목적사항/u.test(text.replace(/\s/g, ''))),
    );
    for (let row = start + 1; start >= 0 && row < summary.rows.length; row += 1) {
      const title = [...new Set(summary.rows[row])]
        .join(' ')
        .replace(/^[□■]\s*/u, '')
        .trim();
      if (!title || !/^\s*[□■]/u.test(summary.rows[row]?.[0] ?? '')) continue;
      agendas.push({
        ordinal: agendas.length + 1,
        title,
        provenance: { title: fieldProvenance(summary, row, 0, ['주주총회 목적사항']) },
      });
    }
  }
  if (!agendas.length)
    warnings.push({
      code: 'MISSING_AGENDAS',
      message: '주주총회 안건을 확인할 수 없습니다.',
      field: 'agendas',
    });
  requiredFieldsWarning(
    { solicitorName, targetCompanyName, meetingDate, solicitationStartDate, solicitationEndDate },
    warnings,
  );
  return {
    solicitorName,
    targetCompanyName,
    relationshipRaw: located.relationshipRaw?.value ?? null,
    meetingDate,
    ...timing,
    meetingLocation: located.meetingLocation?.value ?? null,
    solicitationStartDate,
    solicitationEndDate,
    purposeRaw: located.purposeRaw?.value ?? null,
    electronicVoting,
    agendas,
    confidence: warnings.length ? 0.5 : 0.95,
    provenance: {
      ...summaryProvenance(located),
      ...(targetCompanyName
        ? { targetCompanyName: documentProvenance(context, 'COMPANY-NAME', targetCompanyName) }
        : {}),
    },
    warnings,
    score: summary ? 100 + agendas.length : 0,
  };
}
