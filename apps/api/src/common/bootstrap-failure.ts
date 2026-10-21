import { writeSync } from 'node:fs';

const STARTUP_FAILURE_MESSAGE =
  'API startup failed; check configuration and database/Redis availability. The process will restart.';

/** PM2 can log unhandled Promise rejections without exiting the failed application. */
export async function failBootstrap(
  close: () => Promise<unknown>,
  {
    timeoutMs = 5_000,
    log = (message: string): void => {
      // stderr may be a PM2 pipe; write before the guaranteed exit can truncate buffered output.
      writeSync(2, `${message}\n`);
    },
    exit = (code: number): void => process.exit(code),
  } = {},
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Startup and cleanup errors can contain URLs, credentials, or provider responses.
    log(STARTUP_FAILURE_MESSAGE);
    await Promise.race([
      Promise.resolve().then(close),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Cleanup failure must not prevent a nonzero process exit.
  } finally {
    clearTimeout(timer);
    exit(1);
  }
}
