import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { strToU8 } from 'fflate';
import { TransactionNature } from '@orsem/contracts';
import {
  canonicalizeXmlTables,
  classifyTransactionMethod,
  createCanonicalizationBudget,
  OpenDartPayloadError,
  parseDecimal,
  parseInteger,
  parseOpenDartDisclosure,
} from '../src';

const fixture = (name: string) => readFile(path.join(__dirname, 'fixtures', name));

async function fixtureArchive(name: string): Promise<Uint8Array> {
  const xml = await fixture(name);
  return zipSync({ [`reports/${name}`]: xml });
}

describe('OpenDART deterministic parser', () => {
  it('expands rowspan and colspan into a canonical grid', async () => {
    const xml = (await fixture('d002.xml')).toString('utf8');
    const result = canonicalizeXmlTables(xml, 'd002.xml');
    const transactionTable = result.tables[1];
    expect(transactionTable?.rows[1]).toEqual([
      '소유상황 변동일',
      '특정증권등의 종류',
      '취득/처분방법',
      '증감수량',
      '주당 거래단가',
    ]);
  });

  it('keeps a semantic table nested inside a layout table', () => {
    const result = canonicalizeXmlTables(
      `<DOCUMENT><TABLE><TR><TD>layout<TABLE>
        <TR><TH>변동일</TH><TH>증감수량</TH></TR>
        <TR><TD>2026-09-01</TD><TD>100</TD></TR>
      </TABLE></TD></TR></TABLE></DOCUMENT>`,
      'nested.xml',
    );
    expect(result.tables).toHaveLength(2);
    expect(result.tables[1]?.rows[0]).toEqual(['변동일', '증감수량']);
  });

  it('parses D002 market and non-market ownership changes separately', async () => {
    const result = await parseOpenDartDisclosure({
      detailType: 'D002',
      archive: await fixtureArchive('d002.xml'),
    });
    expect(result.detailType).toBe('D002');
    if (result.detailType !== 'D002') throw new Error('unreachable');
    expect(result.reporterName).toBe('홍길동');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      eventDate: '2026-09-01',
      nature: TransactionNature.MARKET_BUY,
      quantity: '10000',
      unitPrice: '32500',
      amount: '325000000',
    });
    expect(result.transactions[1]?.nature).toBe(TransactionNature.OPTION_EXERCISE);
  });

  it('scans every XML candidate and deterministically selects the recognized report', async () => {
    const report = await fixture('d002.xml');
    const result = await parseOpenDartDisclosure({
      detailType: 'D002',
      archive: zipSync({
        '00-cover.xml': strToU8('<DOCUMENT><P>cover only</P></DOCUMENT>'),
        '10-report.xml': report,
      }),
    });
    expect(result.source.candidateEntries).toEqual(['00-cover.xml', '10-report.xml']);
    expect(result.source.selectedEntryName).toBe('10-report.xml');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'NO_RECOGNIZED_DISCLOSURE_TABLE',
          entryName: '00-cover.xml',
        }),
      ]),
    );
  });

  it('parses D001 into the separate large-holder shape', async () => {
    const result = await parseOpenDartDisclosure({
      detailType: 'D001',
      archive: await fixtureArchive('d001.xml'),
    });
    expect(result.detailType).toBe('D001');
    if (result.detailType !== 'D001') throw new Error('unreachable');
    expect(result.reportTypeRaw).toBe('신규보고');
    expect(result.sharesAfter).toBe('1200000');
    expect(result.changes[0]?.quantity).toBe('200000');
  });

  it('keeps D005 plans distinct from completed transactions', async () => {
    const result = await parseOpenDartDisclosure({
      detailType: 'D005',
      archive: await fixtureArchive('d005.xml'),
    });
    expect(result.detailType).toBe('D005');
    if (result.detailType !== 'D005') throw new Error('unreachable');
    expect(result.planItems[0]).toMatchObject({
      plannedStartDate: '2026-09-05',
      plannedEndDate: '2026-10-04',
      nature: TransactionNature.MARKET_SELL,
      quantity: '-50000',
    });
  });

  it('does not collapse same-sized D001 changes for different securities', async () => {
    const xml = `<DOCUMENT><TABLE>
      <TR><TH>변동일</TH><TH>증권의 종류</TH><TH>변동방법</TH><TH>변동수량</TH></TR>
      <TR><TD>2026-09-01</TD><TD>보통주</TD><TD>장내매수</TD><TD>100</TD></TR>
      <TR><TD>2026-09-01</TD><TD>우선주</TD><TD>장내매수</TD><TD>100</TD></TR>
    </TABLE></DOCUMENT>`;
    const result = await parseOpenDartDisclosure({
      detailType: 'D001',
      archive: zipSync({ 'd001-multi-security.xml': strToU8(xml) }),
    });
    if (result.detailType !== 'D001') throw new Error('unreachable');
    expect(result.changes.map((row) => row.securityTypeRaw)).toEqual(['보통주', '우선주']);
  });

  it('does not collapse D005 rows with distinct security or price bounds', async () => {
    const xml = `<DOCUMENT><TABLE>
      <TR><TH>거래시작일</TH><TH>거래종료일</TH><TH>증권의 종류</TH><TH>거래방법</TH><TH>예정수량</TH><TH>최저가격</TH><TH>최고가격</TH></TR>
      <TR><TD>2026-09-05</TD><TD>2026-10-04</TD><TD>보통주</TD><TD>장내매도</TD><TD>100</TD><TD>1000</TD><TD>1100</TD></TR>
      <TR><TD>2026-09-05</TD><TD>2026-10-04</TD><TD>우선주</TD><TD>장내매도</TD><TD>100</TD><TD>1000</TD><TD>1200</TD></TR>
    </TABLE></DOCUMENT>`;
    const result = await parseOpenDartDisclosure({
      detailType: 'D005',
      archive: zipSync({ 'd005-distinct.xml': strToU8(xml) }),
    });
    if (result.detailType !== 'D005') throw new Error('unreachable');
    expect(result.planItems).toHaveLength(2);
    expect(result.planItems[1]).toMatchObject({
      securityTypeRaw: '우선주',
      priceMax: '1200',
    });
  });

  it('preserves physically distinct rows even when every parsed value matches', async () => {
    const xml = `<DOCUMENT><TABLE>
      <TR><TH>변동일</TH><TH>증권의 종류</TH><TH>취득/처분방법</TH><TH>증감수량</TH><TH>주당거래단가</TH></TR>
      <TR><TD>2026-09-01</TD><TD>보통주</TD><TD>장내매수</TD><TD>100</TD><TD>1000</TD></TR>
      <TR><TD>2026-09-01</TD><TD>보통주</TD><TD>장내매수</TD><TD>100</TD><TD>1000</TD></TR>
    </TABLE></DOCUMENT>`;
    const result = await parseOpenDartDisclosure({
      detailType: 'D002',
      archive: zipSync({ 'duplicate-values.xml': strToU8(xml) }),
    });
    if (result.detailType !== 'D002') throw new Error('unreachable');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.map((row) => row.rowIndex)).toEqual([1, 2]);
  });

  it('splits a D005 range joined by a bare hyphen', async () => {
    const xml = `<DOCUMENT><TABLE>
      <TR><TH>거래예정기간</TH><TH>증권의 종류</TH><TH>거래방법</TH><TH>예정수량</TH></TR>
      <TR><TD>2026-09-05-2026-10-04</TD><TD>보통주</TD><TD>장내매도</TD><TD>100</TD></TR>
    </TABLE></DOCUMENT>`;
    const result = await parseOpenDartDisclosure({
      detailType: 'D005',
      archive: zipSync({ 'bare-hyphen-range.xml': strToU8(xml) }),
    });
    if (result.detailType !== 'D005') throw new Error('unreachable');
    expect(result.planItems[0]).toMatchObject({
      plannedStartDate: '2026-09-05',
      plannedEndDate: '2026-10-04',
    });
  });

  it('never infers a market buy from positive quantity alone', () => {
    const result = classifyTransactionMethod('기타 증가', '100');
    expect(result.nature).toBe(TransactionNature.UNKNOWN);
    expect(result.warnings[0]?.code).toBe('UNKNOWN_METHOD');
  });

  it('never interprets a money unit as a share quantity', () => {
    expect(parseInteger('10억원', 'quantity')).toMatchObject({
      value: null,
      unitRaw: '억원',
      warning: expect.objectContaining({ code: 'INVALID_SHARE_UNIT' }),
    });
  });

  it('rejects values that cannot fit the database exact-numeric contract', () => {
    expect(parseInteger('9'.repeat(33), 'quantity')).toMatchObject({
      value: null,
      warning: expect.objectContaining({ code: 'NUMERIC_OUT_OF_RANGE' }),
    });
    expect(parseDecimal('1.1234567', 'price')).toMatchObject({
      value: null,
      warning: expect.objectContaining({ code: 'NUMERIC_SCALE_EXCEEDED' }),
    });
  });

  it('does not select a monetary increase column as share quantity', async () => {
    const xml = `<DOCUMENT><TABLE>
      <TR><TH>변동일</TH><TH>증권의 종류</TH><TH>취득/처분방법</TH><TH>증감금액(억원)</TH><TH>증감수량</TH></TR>
      <TR><TD>2026-09-01</TD><TD>보통주</TD><TD>장내매수</TD><TD>10</TD><TD>25</TD></TR>
    </TABLE></DOCUMENT>`;
    const result = await parseOpenDartDisclosure({
      detailType: 'D002',
      archive: zipSync({ 'money-before-shares.xml': strToU8(xml) }),
    });
    if (result.detailType !== 'D002') throw new Error('unreachable');
    expect(result.transactions[0]?.quantity).toBe('25');
  });

  it('applies explicit table-header units before calculating an amount', async () => {
    const xml = `<DOCUMENT>
      <TABLE><TR><TD>보고자</TD><TD>김테스트</TD></TR></TABLE>
      <TABLE>
        <TR><TH>변동일</TH><TH>증권의 종류</TH><TH>취득/처분방법</TH><TH>증감수량(천주)</TH><TH>주당거래단가(천원)</TH></TR>
        <TR><TD>2026-09-01</TD><TD>보통주</TD><TD>장내매수</TD><TD>2</TD><TD>3</TD></TR>
      </TABLE>
    </DOCUMENT>`;
    const result = await parseOpenDartDisclosure({
      detailType: 'D002',
      archive: zipSync({ 'scaled.xml': strToU8(xml) }),
    });
    if (result.detailType !== 'D002') throw new Error('unreachable');
    expect(result.transactions[0]).toMatchObject({
      quantity: '2000',
      unitPrice: '3000',
      amount: '6000000',
    });
  });

  it('rejects XML trees deeper than the canonicalization budget', () => {
    const deepXml = `${'<N>'.repeat(130)}value${'</N>'.repeat(130)}`;
    try {
      canonicalizeXmlTables(deepXml, 'deep.xml');
      throw new Error('expected complexity rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenDartPayloadError);
      expect(error).toMatchObject({ code: 'XML_COMPLEXITY_LIMIT' });
    }
  });

  it('rejects a single pathological table cell before normalization', () => {
    expect(() =>
      canonicalizeXmlTables(
        `<DOCUMENT><TABLE><TR><TD>${'x'.repeat(16_385)}</TD></TR></TABLE></DOCUMENT>`,
        'huge-cell.xml',
      ),
    ).toThrow(expect.objectContaining({ code: 'XML_COMPLEXITY_LIMIT' }));
  });

  it('enforces one canonicalization budget across XML candidates', () => {
    const shared = createCanonicalizationBudget();
    shared.expandedCells = 1_999_999;
    expect(() =>
      canonicalizeXmlTables(
        '<DOCUMENT><TABLE><TR><TD>a</TD><TD>b</TD></TR></TABLE></DOCUMENT>',
        'second.xml',
        shared,
      ),
    ).toThrow(expect.objectContaining({ code: 'XML_COMPLEXITY_LIMIT' }));
  });
});
