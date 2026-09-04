import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthAuditLogEntity, MemberEntity, PushDeliveryEntity, dateToIso } from '@orsem/database';
import { AlertStatus, memberViewSchema, type MemberView } from '@orsem/contracts';
import { In } from 'typeorm';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';

@Injectable()
export class MemberService {
  constructor(private readonly database: DatabaseRuntimeService) {}

  async getMember(id: string): Promise<MemberView | null> {
    const source = this.database.dataSource;
    if (!source) return null;
    const row = await source.getRepository(MemberEntity).findOneBy({ id });
    if (!row || row.provider !== 'KAKAO' || row.role !== 'VIEWER') return null;
    return this.view(row);
  }

  async signInKakao(subject: string, displayName: string | null): Promise<MemberView> {
    if (!/^[1-9]\d{0,63}$/.test(subject))
      throw new UnauthorizedException('카카오 회원 식별자를 확인하지 못했습니다.');
    const source = this.database.requireDataSource();
    const repository = source.getRepository(MemberEntity);
    const now = new Date();
    const safeName = displayName
      ? Array.from(displayName)
          .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
          .join('')
          .trim()
          .slice(0, 80) || null
      : null;
    // 기존 회원은 REJECTED를 포함한 승인 상태와 역할을 유지합니다.
    // 별도 회원 테이블에는 이메일 필드나 관리자 계정 자동 연결이 없습니다.
    await repository
      .createQueryBuilder()
      .insert()
      .values({
        provider: 'KAKAO',
        providerSubject: subject,
        role: 'VIEWER',
        status: 'PENDING',
        displayName: safeName,
        lastLoginAt: now,
        reviewedAt: null,
        reviewedByAdminId: null,
      })
      .orIgnore()
      .execute();
    const row = await repository.findOneByOrFail({ provider: 'KAKAO', providerSubject: subject });
    if (row.role !== 'VIEWER') throw new UnauthorizedException('회원 권한을 확인하지 못했습니다.');
    await repository.update(
      { id: row.id },
      { lastLoginAt: now, ...(safeName ? { displayName: safeName } : {}) },
    );
    await source.getRepository(AuthAuditLogEntity).save({
      adminId: null,
      action: 'KAKAO_LOGIN',
      success: true,
      ipHash: null,
      userAgent: null,
      metadataJson: { memberId: row.id },
    });
    return this.view(await repository.findOneByOrFail({ id: row.id }));
  }

  async list(status?: MemberView['status']): Promise<{ items: MemberView[]; nextCursor: null }> {
    const rows = await this.database
      .requireDataSource()
      .getRepository(MemberEntity)
      .find({
        where: status ? { status } : {},
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 100,
      });
    return { items: rows.map((row) => this.view(row)), nextCursor: null };
  }

  async review(id: string, status: 'APPROVED' | 'REJECTED', adminId: string): Promise<MemberView> {
    return this.database.requireDataSource().transaction(async (manager) => {
      const repository = manager.getRepository(MemberEntity);
      const row = await repository
        .createQueryBuilder('member')
        .setLock('pessimistic_write')
        .where('member.id = :id', { id })
        .getOne();
      if (!row) throw new NotFoundException('회원을 찾을 수 없습니다.');
      const previousStatus = row.status;
      row.status = status;
      row.role = 'VIEWER';
      row.reviewedAt = new Date();
      row.reviewedByAdminId = adminId;
      await repository.save(row);
      if (status === 'REJECTED') {
        // Invalidate outstanding claims atomically with approval revocation, so the
        // sender's final claim check also observes revocations during validation.
        await manager.getRepository(PushDeliveryEntity).update(
          {
            ownerKey: `MEMBER:${row.id}`,
            status: In([AlertStatus.PENDING, AlertStatus.SENDING]),
          },
          {
            status: AlertStatus.CANCELLED,
            leaseUntil: null,
            lastError: '회원 이용 승인이 취소되어 알림을 취소했습니다.',
          },
        );
      }
      await manager.getRepository(AuthAuditLogEntity).save({
        adminId,
        action: 'MEMBER_REVIEW',
        success: true,
        ipHash: null,
        userAgent: null,
        metadataJson: { memberId: id, previousStatus, status },
      });
      return this.view(row);
    });
  }

  private view(row: MemberEntity): MemberView {
    return memberViewSchema.parse({
      id: row.id,
      provider: row.provider,
      role: row.role,
      status: row.status,
      displayName: row.displayName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastLoginAt: dateToIso(row.lastLoginAt),
      reviewedAt: dateToIso(row.reviewedAt),
    });
  }
}
