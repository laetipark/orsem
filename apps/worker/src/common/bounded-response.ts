export interface ResponseSizeLimit {
  readonly maxBytes: number;
  readonly errorMessage: string;
  readonly cancelReason?: string;
}

function assertSize(size: number, limit: ResponseSizeLimit): void {
  if (Number.isFinite(size) && size > limit.maxBytes) throw new Error(limit.errorMessage);
}

async function assertDeclaredSize(response: Response, limit: ResponseSizeLimit): Promise<void> {
  try {
    assertSize(Number(response.headers.get('content-length') ?? 0), limit);
  } catch (error) {
    await response.body?.cancel(limit.cancelReason).catch(() => undefined);
    throw error;
  }
}

/** Limit actual streamed bytes as well as Content-Length, which may be absent or inaccurate. */
export async function readBoundedResponseBytes(
  response: Response,
  limit: ResponseSizeLimit,
): Promise<Uint8Array> {
  await assertDeclaredSize(response, limit);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertSize(bytes.byteLength, limit);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit.maxBytes) {
        await reader.cancel(limit.cancelReason).catch(() => undefined);
        throw new Error(limit.errorMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedResponseText(
  response: Response,
  limit: ResponseSizeLimit,
): Promise<string> {
  if (!response.body) {
    await assertDeclaredSize(response, limit);
    const text = await response.text();
    assertSize(Buffer.byteLength(text, 'utf8'), limit);
    return text;
  }
  // Decode once after joining chunks so a multi-byte character can cross a stream boundary.
  return new TextDecoder('utf-8', { fatal: true }).decode(
    await readBoundedResponseBytes(response, limit),
  );
}
