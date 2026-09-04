import { OpenDartApiError } from '@orsem/opendart-parser';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  OpenDartClient,
  openDartViewerUrl,
  redactOpenDartUrl,
  type FetchImplementation,
} from '../src/opendart/opendart.client';

describe('OpenDartClient', () => {
  const config = loadWorkerConfig({
    OPENDART_API_KEY: 'x'.repeat(40),
    HTTP_TIMEOUT_MS: '5000',
  });

  it('returns an empty page for status 013 and sends the detail type explicitly', async () => {
    let requestedUrl = '';
    const fetcher: FetchImplementation = async (input) => {
      requestedUrl = new URL(input instanceof Request ? input.url : input.toString()).toString();
      return new Response(JSON.stringify({ status: '013', message: '조회된 데이터가 없습니다.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = new OpenDartClient(config, fetcher);
    const page = await client.listDisclosures({
      detailType: 'D002',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      page: 1,
    });
    expect(page.items).toEqual([]);
    const requested = new URL(requestedUrl);
    expect(requested.searchParams.get('pblntf_detail_ty')).toBe('D002');
    expect(requested.searchParams.has('pblntf_ty')).toBe(false);
    expect(requested.searchParams.get('last_reprt_at')).toBe('N');
  });

  it('accepts uppercase alphanumeric six-character KRX stock codes', async () => {
    const fetcher: FetchImplementation = async () =>
      new Response(
        JSON.stringify({
          status: '000',
          message: '정상',
          page_no: 1,
          page_count: 100,
          total_count: 1,
          total_page: 1,
          list: [
            {
              corp_code: '01805705',
              corp_name: '신한제18호스팩',
              stock_code: '0129K0',
              corp_cls: 'K',
              report_nm: '주식등의대량보유상황보고서',
              rcept_no: '20260903000001',
              flr_nm: '신고인',
              rcept_dt: '20260903',
              rm: '',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const client = new OpenDartClient(config, fetcher);
    const page = await client.listDisclosures({
      detailType: 'D001',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      page: 1,
    });
    expect(page.items[0]?.stock_code).toBe('0129K0');
  });

  it('maps a binary endpoint XML error without exposing the API key', async () => {
    const fetcher: FetchImplementation = async () =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?><result><status>014</status><message>요청 ${config.openDartApiKey} 파일이 존재하지 않습니다.</message></result>`,
        { status: 200, headers: { 'content-type': 'application/xml' } },
      );
    const client = new OpenDartClient(config, fetcher);
    try {
      await client.fetchDocument('20260903000001');
      throw new Error('expected OpenDART error');
    } catch (error) {
      expect(error).toMatchObject<Partial<OpenDartApiError>>({
        status: '014',
        retryPolicy: 'DELAYED_DOCUMENT',
      });
      expect(String(error)).toContain('[REDACTED]');
      expect(String(error)).not.toContain(config.openDartApiKey);
    }
  });

  it('redacts query credentials and validates viewer links', () => {
    expect(
      redactOpenDartUrl('https://opendart.fss.or.kr/api/list.json?crtfc_key=secret&page_no=1'),
    ).not.toContain('secret');
    expect(openDartViewerUrl('20260903000001')).toContain('rcpNo=20260903000001');
  });
});
