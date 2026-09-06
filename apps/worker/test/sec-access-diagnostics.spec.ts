import { readSecAccessCode, safeSecAccessCode } from '../src/connectors/sec-access-diagnostics';
import { connectorFailureMessage, fetchJson } from '../src/connectors/connector-adapters';
import { SecAccessCooldownError } from '../src/connectors/sec-access-policy';

it.each([
  ['<title>Undeclared Automated Tool</title>', 'SEC_UNDECLARED_AUTOMATION'],
  ['Request Rate Threshold Exceeded', 'SEC_RATE_LIMIT'],
  ['Your request rate has exceeded the SEC limit', 'SEC_RATE_LIMIT'],
  ['Access Denied', 'SEC_ACCESS_DENIED'],
  ['unrelated private provider response', null],
  ['x'.repeat(8192) + 'Undeclared Automated Tool', null],
])('classifies bounded SEC response signatures: %s', async (body, expected) => {
  expect(await readSecAccessCode(new Response(body, { status: 403 }))).toBe(expected);
});

it('recognizes signatures split over chunks and discards unapproved diagnostic values', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('Undeclared Auto'));
      controller.enqueue(new TextEncoder().encode('mated Tool private test data'));
      controller.close();
    },
  });
  expect(await readSecAccessCode(new Response(body, { status: 403 }))).toBe(
    'SEC_UNDECLARED_AUTOMATION',
  );
  expect(safeSecAccessCode('private test data')).toBeNull();
  expect(await readSecAccessCode(new Response('', { status: 429 }))).toBe('SEC_RATE_LIMIT');
});

it('preserves only approved SEC diagnostic codes through discovery errors and shows actionable guidance', async () => {
  for (const code of ['SEC_UNDECLARED_AUTOMATION', 'private echoed secret']) {
    const fetcher = jest.fn().mockRejectedValue(
      Object.assign(new SecAccessCooldownError(new Date('2026-09-06T08:40:00Z'), 403, false), {
        providerCode: code,
      }),
    );
    const error = await fetchJson(
      'SEC',
      'submissions',
      fetcher,
      new URL('https://data.sec.gov/submissions/CIK0001045810.json'),
      {},
      1000,
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({
      httpStatus: 403,
      requestAttempted: false,
      providerCode: code === 'SEC_UNDECLARED_AUTOMATION' ? code : null,
    });
    const message = connectorFailureMessage(error);
    expect(message).toContain('대기 중');
    expect(message).toContain(
      code === 'SEC_UNDECLARED_AUTOMATION' ? 'SEC Webmaster' : '원인을 확정할 수 없습니다',
    );
    expect(message).toContain('접근 복구를 보장하지 않습니다');
    expect(message).not.toContain('private echoed secret');
  }
});
