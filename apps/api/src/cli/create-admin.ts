import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../app.module';
import { AuthService } from '../auth/auth.service';
import { generateTotpCode } from '../auth/totp';

async function main(): Promise<void> {
  const email = argument('--email') ?? positional(0) ?? process.env.ADMIN_EMAIL;
  const configuredPassword = argument('--password') ?? positional(1) ?? process.env.ADMIN_PASSWORD;
  const password = configuredPassword ?? randomBytes(24).toString('base64url');
  if (!email || password.length < 14) {
    throw new Error(
      'Usage: npm run admin:create -- --email admin@example.com [--password "a-password-with-14+-characters"]',
    );
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const auth = app.get(AuthService);
    const result = await auth.createAdmin(email, password);
    const enrollment = await auth.beginTotp(result.admin.id);
    const confirmation = await auth.confirmTotp(
      result.admin.id,
      generateTotpCode(enrollment.secret),
    );
    const output = [
      `Created single admin: ${result.admin.email}`,
      `Initial password: ${password}`,
      `TOTP enrollment URI: ${enrollment.otpauthUri}`,
      'Recovery codes (shown once):',
      ...confirmation.recoveryCodes,
    ];
    process.stdout.write(`${output.join('\n')}\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positional(index: number): string | undefined {
  return process.argv.slice(2).filter((value, itemIndex, values) => {
    if (value.startsWith('--')) return false;
    return itemIndex === 0 || !values[itemIndex - 1]?.startsWith('--');
  })[index];
}
