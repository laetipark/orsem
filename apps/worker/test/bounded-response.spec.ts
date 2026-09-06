import { readBoundedResponseBytes, readBoundedResponseText } from '../src/common/bounded-response';

const limit = { maxBytes: 8, errorMessage: 'Test response exceeded its size limit.' };

function streamedResponse(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let index = 0;
  const cancel = jest.fn();
  const pull = jest.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks[index++];
    if (chunk) controller.enqueue(chunk);
    else controller.close();
  });
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), body, cancel, pull };
}

describe('bounded provider response reads', () => {
  it('accepts the exact byte limit and decodes UTF-8 characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('가😀Z');
    expect(bytes.byteLength).toBe(8);
    const { response, body } = streamedResponse([
      bytes.slice(0, 2),
      bytes.slice(2, 5),
      bytes.slice(5),
    ]);
    await expect(readBoundedResponseText(response, limit)).resolves.toBe('가😀Z');
    expect(body.locked).toBe(false);
  });

  it('cancels an oversized declaration before acquiring a reader or reading the body', async () => {
    const { response, body, pull, cancel } = streamedResponse([new Uint8Array([1])], {
      'content-length': '9',
    });
    await expect(readBoundedResponseBytes(response, limit)).rejects.toThrow(limit.errorMessage);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it.each([undefined, '9'])(
    'preserves the size error when cleanup rejects (declared %s)',
    async (declared) => {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array(9));
          },
          cancel() {
            throw new Error('cleanup failed');
          },
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body, {
        headers: declared ? { 'content-length': declared } : {},
      });
      await expect(readBoundedResponseBytes(response, limit)).rejects.toThrow(limit.errorMessage);
      expect(body.locked).toBe(false);
    },
  );

  it.each([null, '1', 'not-a-number'])(
    'enforces actual bytes with Content-Length %s and cancels before reading the remaining data',
    async (declared) => {
      const { response, body, cancel, pull } = streamedResponse(
        [new Uint8Array(4), new Uint8Array(5), new Uint8Array(8)],
        declared === null ? {} : { 'content-length': declared },
      );
      await expect(
        readBoundedResponseBytes(response, { ...limit, cancelReason: 'provider limit' }),
      ).rejects.toThrow(limit.errorMessage);
      expect(cancel).toHaveBeenCalledWith('provider limit');
      expect(pull).toHaveBeenCalledTimes(2);
      expect(body.locked).toBe(false);
    },
  );

  it('preserves binary data but rejects malformed UTF-8 in text reads', async () => {
    const bytes = new Uint8Array([0xff, 0x00]);
    await expect(
      readBoundedResponseBytes(streamedResponse([bytes]).response, limit),
    ).resolves.toEqual(bytes);
    await expect(
      readBoundedResponseText(streamedResponse([bytes]).response, limit),
    ).rejects.toThrow();
  });

  it('propagates stream failures and releases the reader lock', async () => {
    const failure = new Error('Test interrupted stream.');
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    await expect(readBoundedResponseBytes(new Response(body), limit)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });

  it('keeps body-less response fallbacks bounded by bytes, including multi-byte text', async () => {
    const text = jest.fn().mockResolvedValue('가가가');
    const response = { headers: new Headers(), body: null, text } as unknown as Response;
    await expect(readBoundedResponseText(response, limit)).rejects.toThrow(limit.errorMessage);
    text.mockResolvedValue('가가');
    await expect(readBoundedResponseText(response, limit)).resolves.toBe('가가');

    const arrayBuffer = jest.fn().mockResolvedValue(new Uint8Array(9).buffer);
    const binary = { headers: new Headers(), body: null, arrayBuffer } as unknown as Response;
    await expect(readBoundedResponseBytes(binary, limit)).rejects.toThrow(limit.errorMessage);
    arrayBuffer.mockResolvedValue(new Uint8Array([0xff]).buffer);
    await expect(readBoundedResponseBytes(binary, limit)).resolves.toEqual(new Uint8Array([0xff]));
  });
});
