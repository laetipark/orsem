import { BadRequestException } from '@nestjs/common';
import { NEWS_MATCHER_VERSION, type resolveReviewSchema } from '@orsem/contracts';
import {
  CompanyEntity,
  FilingEntity,
  NewsSourceCompanyEntity,
  SourceItemEntity,
  isReadableOfficialNewsSource,
  type ReviewEntity,
} from '@orsem/database';
import { In, type EntityManager } from 'typeorm';
import type { z } from 'zod';
import { newsAudienceAllows } from './news-access';

export type NewsReviewInput = z.infer<typeof resolveReviewSchema>;

/** Explicit administrator linkage only. Never changes a filing/event grade or compares facts. */
export async function resolveNewsReview(
  manager: EntityManager,
  review: ReviewEntity,
  input: NewsReviewInput,
  adminId: string,
  at: Date,
): Promise<Record<string, unknown>> {
  const repository = manager.getRepository(SourceItemEntity);
  const source = await repository.findOne({
    where: { id: review.subjectId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!source || !input.sourceHash || source.rawHash !== input.sourceHash)
    throw new BadRequestException('뉴스 원본이 변경되었습니다. 검토를 다시 불러오세요.');
  if (
    !newsAudienceAllows(source, 'ADMIN_UI') ||
    source.sourcePolicyJson?.metadataStorageAllowed !== true ||
    source.sourcePolicyJson?.displayAllowed !== true ||
    source.sourcePolicyJson.rightsMode !== source.rightsMode
  )
    throw new BadRequestException('현재 표시가 허용된 뉴스만 검토할 수 있습니다.');
  if (input.resolution === 'CORRECTION_LINKED')
    throw new BadRequestException('뉴스 검토는 공시 정정 계보를 변경하지 않습니다.');
  const metadata = source.rawMetadataJson ?? {};
  const previous = {
    manualCompanyIds: metadata.manualCompanyIds ?? [],
    officialReferences: metadata.officialReferences ?? [],
    officialVerification: metadata.officialVerification ?? 'UNVERIFIED',
  };
  let references = Array.isArray(metadata.officialReferences)
    ? metadata.officialReferences
        .filter((value): value is Record<string, unknown> =>
          Boolean(value && typeof value === 'object' && !Array.isArray(value)),
        )
        .map((value) => ({ ...value }))
    : [];
  let companyIds = Array.isArray(metadata.manualCompanyIds)
    ? metadata.manualCompanyIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (input.resolution === 'CONFIRMED' && !input.companyIds?.length && !input.officialTarget)
    throw new BadRequestException('연결할 기존 회사 또는 공식 자료를 선택하세요.');
  if (input.companyIds) {
    companyIds = [...new Set(input.companyIds)];
    const companies = companyIds.length
      ? await manager
          .getRepository(CompanyEntity)
          .find({ where: { id: In(companyIds), isListed: true } })
      : [];
    if (companies.length !== companyIds.length)
      throw new BadRequestException('유효한 기존 상장기업만 연결할 수 있습니다.');
    if (input.resolution !== 'CONFIRMED')
      throw new BadRequestException('회사 연결은 확인 처리에서만 변경할 수 있습니다.');
    const relations = manager.getRepository(NewsSourceCompanyEntity);
    const old = await relations.find({ where: { sourceItemId: source.id } });
    for (const row of old)
      if (row.matchMethod === 'MANUAL_REVIEW' && !companyIds.includes(row.companyId))
        await relations.delete(row.id);
    for (const companyId of companyIds) {
      const existing = old.find((row) => row.companyId === companyId);
      await relations.save(
        relations.create({
          ...existing,
          sourceItemId: source.id,
          companyId,
          matchMethod: 'MANUAL_REVIEW',
          inputHash: source.rawHash!,
          matcherVersion: NEWS_MATCHER_VERSION,
        }),
      );
    }
  }
  if (input.officialTarget) {
    const target = input.officialTarget;
    const candidate = references.find(
      (entry) =>
        entry.kind === target.kind && entry.id === target.id && entry.sourceHash === source.rawHash,
    );
    if (!candidate)
      throw new BadRequestException('현재 원본에 등록된 공식 자료 후보를 선택하세요.');
    if (target.kind === 'FILING') {
      const filing = await manager.getRepository(FilingEntity).findOneBy({ id: target.id });
      if (!filing || filing.source !== 'OPENDART')
        throw new BadRequestException('기존 DART 공시만 연결할 수 있습니다.');
    } else {
      const official = await repository.findOne({
        where: { id: target.id },
        lock: { mode: 'pessimistic_read' },
      });
      if (
        !official ||
        official.id === source.id ||
        !newsAudienceAllows(official, 'ADMIN_UI') ||
        !isReadableOfficialNewsSource(official) ||
        (candidate.targetHash && candidate.targetHash !== official.rawHash)
      )
        throw new BadRequestException('공식 자료가 변경되었거나 현재 연결이 허용되지 않습니다.');
      candidate.targetHash = official.rawHash;
    }
    candidate.status = input.resolution === 'CONFIRMED' ? 'CONFIRMED' : 'REJECTED';
    candidate.reviewedAt = at.toISOString();
    candidate.reviewedByAdminId = adminId;
  }
  references = references.map((entry) =>
    entry.sourceHash === source.rawHash ? entry : { ...entry, status: 'RELATED' },
  );
  const verification = references.some(
    (entry) => entry.status === 'CONFIRMED' && entry.sourceHash === source.rawHash,
  )
    ? 'CONFIRMED'
    : references.some((entry) => entry.status === 'RELATED')
      ? 'LINKED'
      : 'UNVERIFIED';
  const audit = {
    reviewId: review.id,
    sourceHash: source.rawHash,
    reviewedAt: at.toISOString(),
    reviewedByAdminId: adminId,
    resolution: input.resolution,
    note: input.note ?? null,
    previous,
    companyIds,
    officialTarget: input.officialTarget ?? null,
  };
  source.rawMetadataJson = {
    ...metadata,
    manualCompanyIds: companyIds,
    officialReferences: references,
    officialVerification: verification,
    newsReview: audit,
  };
  await repository.save(source);
  return audit;
}
