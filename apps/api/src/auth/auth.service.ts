import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AdminEntity,
  AdminTotpSecretEntity,
  AuthAuditLogEntity,
  TotpRecoveryCodeEntity,
} from '@orsem/database';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  totpUri,
  verifyTotp,
} from './totp';

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  totpEnabled: boolean;
}

@Injectable()
export class AuthService {
  private fixtureTotpSecret: string | null = null;
  private fixtureTotpEnabled = false;
  private fixtureRecoveryHashes: string[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
  ) {}

  async setupRequired(): Promise<boolean> {
    if (this.config.fixtureMode) return false;
    const source = this.database.dataSource;
    if (!source) return true;
    return (await source.getRepository(AdminEntity).count()) === 0;
  }

  async getAdmin(id: string): Promise<AuthenticatedAdmin | null> {
    if (this.config.fixtureMode) {
      return id === 'fixture-admin'
        ? { id, email: this.config.fixtureAdminEmail, totpEnabled: this.fixtureTotpEnabled }
        : null;
    }
    const source = this.database.dataSource;
    if (!source) return null;
    const admin = await source.getRepository(AdminEntity).findOneBy({ id, isActive: true });
    return admin ? this.toAdmin(admin) : null;
  }

  async authenticate(
    email: string,
    password: string,
    totpCode: string | undefined,
    recoveryCode: string | undefined,
    audit: { ipHash: string | null; userAgent: string | null },
  ): Promise<AuthenticatedAdmin> {
    if (this.config.fixtureMode) {
      const emailOk = safeTextEqual(
        email.toLowerCase(),
        this.config.fixtureAdminEmail.toLowerCase(),
      );
      const passwordOk = safeTextEqual(password, this.config.fixtureAdminPassword);
      if (!emailOk || !passwordOk)
        throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다.');
      if (
        this.fixtureTotpEnabled &&
        !(await this.verifySecondFactor('fixture-admin', totpCode, recoveryCode))
      ) {
        throw new UnauthorizedException({
          code: 'MFA_REQUIRED',
          message: 'TOTP 또는 복구 코드가 필요합니다.',
        });
      }
      return {
        id: 'fixture-admin',
        email: this.config.fixtureAdminEmail,
        totpEnabled: this.fixtureTotpEnabled,
      };
    }

    const source = this.database.dataSource;
    if (!source) throw new UnauthorizedException('인증 저장소를 사용할 수 없습니다.');
    const repository = source.getRepository(AdminEntity);
    const admin = await repository.findOneBy({ email: email.toLowerCase() });
    const now = new Date();
    if (
      !admin ||
      !admin.isActive ||
      (admin.lockedUntil && admin.lockedUntil > now) ||
      !(await verify(admin.passwordHash, password))
    ) {
      if (admin) {
        admin.failedLoginCount += 1;
        if (admin.failedLoginCount >= 5) admin.lockedUntil = new Date(Date.now() + 15 * 60_000);
        await repository.save(admin);
      }
      await this.audit(admin?.id ?? null, 'LOGIN', false, audit);
      throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    if (admin.totpEnabled && !(await this.verifySecondFactor(admin.id, totpCode, recoveryCode))) {
      admin.failedLoginCount += 1;
      if (admin.failedLoginCount >= 5) admin.lockedUntil = new Date(Date.now() + 15 * 60_000);
      await repository.save(admin);
      await this.audit(admin.id, 'LOGIN_MFA', false, audit);
      throw new UnauthorizedException({
        code: 'MFA_REQUIRED',
        message: 'TOTP 또는 복구 코드가 필요합니다.',
      });
    }
    admin.failedLoginCount = 0;
    admin.lockedUntil = null;
    admin.lastLoginAt = now;
    await repository.save(admin);
    await this.audit(admin.id, 'LOGIN', true, audit);
    return this.toAdmin(admin);
  }

  async beginTotp(adminId: string): Promise<{ secret: string; otpauthUri: string }> {
    const admin = await this.getAdmin(adminId);
    if (!admin) throw new UnauthorizedException('관리자 계정을 찾을 수 없습니다.');
    if (admin.totpEnabled) {
      throw new BadRequestException(
        '이미 TOTP가 활성화되어 있습니다. 기존 비밀키를 덮어쓰지 않고 복구 코드를 별도로 재발급하세요.',
      );
    }
    const secret = generateTotpSecret();
    if (this.config.fixtureMode) {
      this.fixtureTotpSecret = secret;
    } else {
      const repository = this.database.requireDataSource().getRepository(AdminTotpSecretEntity);
      const existing = await repository.findOneBy({ adminId });
      await repository.save(
        repository.create({
          ...existing,
          adminId,
          encryptedSecret: encryptTotpSecret(secret, this.config.totpEncryptionKey),
          confirmedAt: null,
        }),
      );
    }
    return { secret, otpauthUri: totpUri(secret, admin.email) };
  }

  async confirmTotp(adminId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const secret = await this.secretFor(adminId);
    if (!secret || !verifyTotp(secret, code))
      throw new UnauthorizedException('TOTP 코드가 올바르지 않습니다.');
    if (this.config.fixtureMode) {
      this.fixtureTotpEnabled = true;
    } else {
      const source = this.database.requireDataSource();
      const secretRow = await source
        .getRepository(AdminTotpSecretEntity)
        .findOneByOrFail({ adminId });
      secretRow.confirmedAt = new Date();
      await source.getRepository(AdminTotpSecretEntity).save(secretRow);
      await source.getRepository(AdminEntity).update({ id: adminId }, { totpEnabled: true });
    }
    return { recoveryCodes: await this.replaceRecoveryCodes(adminId) };
  }

  async replaceRecoveryCodes(adminId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () =>
      formatRecoveryCode(randomBytes(8).toString('hex')),
    );
    const hashes = await Promise.all(codes.map((code) => secureHash(code)));
    if (this.config.fixtureMode) {
      this.fixtureRecoveryHashes = hashes;
      return codes;
    }
    const source = this.database.requireDataSource();
    await source.transaction(async (manager) => {
      await manager.getRepository(TotpRecoveryCodeEntity).delete({ adminId });
      await manager
        .getRepository(TotpRecoveryCodeEntity)
        .save(
          hashes.map((codeHash) =>
            manager
              .getRepository(TotpRecoveryCodeEntity)
              .create({ adminId, codeHash, usedAt: null }),
          ),
        );
    });
    return codes;
  }

  async changePassword(
    adminId: string,
    currentPassword: string,
    nextPassword: string,
  ): Promise<void> {
    if (this.config.fixtureMode)
      throw new UnauthorizedException('fixture 계정 비밀번호는 환경 변수로 변경하세요.');
    const repository = this.database.requireDataSource().getRepository(AdminEntity);
    const admin = await repository.findOneByOrFail({ id: adminId });
    if (!(await verify(admin.passwordHash, currentPassword)))
      throw new UnauthorizedException('현재 비밀번호가 올바르지 않습니다.');
    admin.passwordHash = await secureHash(nextPassword);
    await repository.save(admin);
  }

  async createAdmin(
    email: string,
    password: string,
  ): Promise<{ admin: AuthenticatedAdmin; recoveryCodes: string[] }> {
    if (this.config.fixtureMode) throw new Error('Cannot create a persisted admin in fixture mode');
    const source = this.database.requireDataSource();
    if ((await source.getRepository(AdminEntity).count()) > 0)
      throw new Error('A single admin already exists');
    const entity = source.getRepository(AdminEntity).create({
      email: email.toLowerCase(),
      passwordHash: await secureHash(password),
      totpEnabled: false,
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
    });
    await source.getRepository(AdminEntity).save(entity);
    return { admin: this.toAdmin(entity), recoveryCodes: [] };
  }

  private async verifySecondFactor(
    adminId: string,
    totpCode?: string,
    recoveryCode?: string,
  ): Promise<boolean> {
    const secret = await this.secretFor(adminId);
    if (totpCode && secret && verifyTotp(secret, totpCode)) return true;
    if (!recoveryCode) return false;
    if (this.config.fixtureMode) {
      for (let index = 0; index < this.fixtureRecoveryHashes.length; index += 1) {
        if (await verify(this.fixtureRecoveryHashes[index]!, recoveryCode)) {
          this.fixtureRecoveryHashes.splice(index, 1);
          return true;
        }
      }
      return false;
    }
    return this.database.requireDataSource().transaction(async (manager) => {
      const repository = manager.getRepository(TotpRecoveryCodeEntity);
      const candidates = await repository
        .createQueryBuilder('code')
        .setLock('pessimistic_write')
        .where('code.adminId = :adminId', { adminId })
        .andWhere('code.usedAt IS NULL')
        .getMany();
      for (const candidate of candidates) {
        if (await verify(candidate.codeHash, recoveryCode)) {
          candidate.usedAt = new Date();
          await repository.save(candidate);
          return true;
        }
      }
      return false;
    });
  }

  private async secretFor(adminId: string): Promise<string | null> {
    if (this.config.fixtureMode) return this.fixtureTotpSecret;
    const source = this.database.dataSource;
    if (!source) return null;
    const row = await source.getRepository(AdminTotpSecretEntity).findOneBy({ adminId });
    return row ? decryptTotpSecret(row.encryptedSecret, this.config.totpEncryptionKey) : null;
  }

  private toAdmin(admin: AdminEntity): AuthenticatedAdmin {
    return { id: admin.id, email: admin.email, totpEnabled: admin.totpEnabled };
  }

  private async audit(
    adminId: string | null,
    action: string,
    success: boolean,
    input: { ipHash: string | null; userAgent: string | null },
  ): Promise<void> {
    const source = this.database.dataSource;
    if (!source) return;
    const repository = source.getRepository(AuthAuditLogEntity);
    await repository.save(
      repository.create({ adminId, action, success, ...input, metadataJson: null }),
    );
  }
}

export function secureHash(value: string): Promise<string> {
  return hash(value, { type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
}

function safeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function formatRecoveryCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}`;
}
