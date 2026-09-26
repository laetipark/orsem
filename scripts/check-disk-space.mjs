import { statfs } from 'node:fs/promises';

export function evaluateDiskSpace({ bsize, blocks, bavail }) {
  if (bsize <= 0n || blocks <= 0n || bavail < 0n || bavail > blocks) {
    return { state: 'WARN', detail: 'available disk space could not be verified' };
  }
  const available = bsize * bavail;
  const total = bsize * blocks;
  const mebibytes = Number(available / (1024n * 1024n));
  const percent = Number((available * 1_000n) / total) / 10;
  const state = available < 128n * 1024n * 1024n ? 'FAIL' : available * 20n < total ? 'WARN' : 'OK';
  return {
    state,
    detail: `${mebibytes} MiB available (${percent.toFixed(1)}%); minimum 128 MiB, recommended at least 5% free`,
  };
}

export async function checkDiskSpace(directory, { readStats = statfs } = {}) {
  try {
    return evaluateDiskSpace(await readStats(directory, { bigint: true }));
  } catch {
    return { state: 'WARN', detail: 'available disk space could not be checked' };
  }
}
