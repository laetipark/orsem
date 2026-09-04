import { canonicalizeXmlTables } from '../src/xml-tables';
import { extractD001 } from '../src/extractors/d001';
import { extractD002 } from '../src/extractors/d002';
import { extractD005 } from '../src/extractors/d005';

const tables = (xml: string) =>
  canonicalizeXmlTables(`<DOCUMENT>${xml}</DOCUMENT>`, 'synthetic.xml').tables;
const typedHeader = `<TR><TH ROWSPAN="2">보고사유</TH><TH ROWSPAN="2">변동일*</TH><TH ROWSPAN="2">특정증권등의 종류</TH><TH COLSPAN="3">소유주식수(주)</TH><TH ROWSPAN="2">취득/처분단가(원)**</TH></TR><TR><TH>변동전</TH><TH>증감</TH><TH>변동후</TH></TR>`;

describe('source-shaped extraction regressions', () => {
  it('retains typed cells, multilevel headers and original coordinates in a merged grid', () => {
    const canonical = tables(
      `<TABLE>${typedHeader}<TR><TU AUNIT="RPT_RSN">장내매수(+)</TU><TU>2026년 08월 26일</TU><TU>보통주</TU><TE>-</TE><TE>731</TE><TE>731</TE><TE>3,504</TE></TR></TABLE>`,
    );
    expect(canonical[0]?.grid[1]?.[0]).toMatchObject({
      tag: 'TH',
      sourceRowIndex: 0,
      sourceColumnIndex: 0,
    });
    const result = extractD002(canonical);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      eventDate: '2026-08-26',
      methodRaw: '장내매수(+)',
      nature: 'MARKET_BUY',
      quantity: '731',
      unitPrice: '3504',
      sharesAfter: '731',
      amount: '2561424',
      currency: 'KRW',
    });
    expect(result.transactions[0]?.provenance?.quantity).toEqual({
      sourcePath: ['DOCUMENT', 'TABLE'],
      sourceEntryName: 'synthetic.xml',
      tableIndex: 0,
      rowIndex: 2,
      columnIndex: 4,
      sourceRowIndex: 2,
      sourceColumnIndex: 4,
      headerPath: ['소유주식수(주)', '증감'],
      rawText: '731',
    });
    expect(result.transactions[0]?.provenance?.methodRaw?.rawText).toBe('장내매수(+)');
  });

  it('selects current-report values and the explicit change row, never the adjacent rate header', () => {
    const result = extractD001(
      tables(`<TABLE>
      <TR><TH ROWSPAN="3">보유주식등의 수 및 보유비율</TH><TH></TH><TH>보유주식등의 수</TH><TH>보유비율</TH></TR>
      <TR><TD>직전 보고서</TD><TE>900</TE><TE>9.0</TE></TR><TR><TD>이번 보고서</TD><TE>600</TE><TE>6.0</TE></TR>
    </TABLE><TABLE><TR><TH ROWSPAN="2">구분</TH><TH COLSPAN="2">주식등</TH><TH COLSPAN="2">주권</TH></TR>
      <TR><TH>주식등의 수(주)</TH><TH>비율(%)</TH><TH>주식수(주)</TH><TH>비율(%)</TH></TR>
      <TR><TD>직전보고서</TD><TE>900</TE><TE>9</TE><TE>800</TE><TE>8</TE></TR>
      <TR><TD>이번보고서</TD><TE>600</TE><TE>6</TE><TE>500</TE><TE>5</TE></TR>
      <TR><TD>증 감</TD><TE>-300</TE><TE>-3</TE><TE>-300</TE><TE>-3</TE></TR></TABLE>`),
    );
    expect(result).toMatchObject({
      sharesAfter: '600',
      ownershipRateAfter: '6',
      sharesChange: '-300',
      ownershipRateChange: '-3',
      confidence: 0,
    });
    expect(result.provenance.sharesAfter).toMatchObject({
      tableIndex: 0,
      rowIndex: 2,
      columnIndex: 2,
      rawText: '600',
    });
    expect(result.warnings.some((warning) => warning.code === 'INVALID_INTEGER')).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'REQUIRED_HEADER_NOT_FOUND' }),
    );
  });

  it('extracts D001 change context without converting stock consolidation into a market trade', () => {
    const result = extractD001(
      tables(
        `<TABLE><TR><TH ROWSPAN="2">변동일</TH><TH ROWSPAN="2">취득/처분방법</TH><TH ROWSPAN="2">주식등의종류</TH><TH COLSPAN="3">변동내역</TH></TR><TR><TH>변동전</TH><TH>증감</TH><TH>변동후</TH></TR><TR><TU>2026.07.23</TU><TU>주식병합</TU><TU>의결권있는 주식</TU><TE>1,000</TE><TE>-800</TE><TE>200</TE></TR></TABLE>`,
      ),
    );
    expect(result.changes[0]).toMatchObject({
      methodRaw: '주식병합',
      quantity: '-800',
      direction: 'DECREASE',
    });
    expect(result.changes[0]).not.toHaveProperty('nature');
  });

  it('reads reporter role instead of a subheading or the contact person role', () => {
    const result = extractD002(
      tables(
        `<TABLE><TR><TD ROWSPAN="2">발행회사와의 관계</TD><TD>임원(등기여부)</TD><TU>등기임원</TU><TD>직위명</TD><TU>대표이사</TU></TR><TR><TD>주요주주</TD><TU>-</TU></TR><TR><TD>업무상 연락처및 담당자</TD><TD>직위</TD><TE>대리</TE></TR></TABLE>`,
      ),
    );
    expect(result).toMatchObject({ relationshipRaw: '등기임원', positionRaw: '대표이사' });
    const corporation = extractD002(
      tables(
        `<TABLE><TR><TD ROWSPAN="2">발행회사와의 관계</TD><TD>임원(등기여부)</TD><TU>-</TU><TD>직위명</TD><TU>-</TU></TR><TR><TD>주요주주</TD><TU>10%이상주주</TU></TR><TR><TD>업무상 연락처및 담당자</TD><TD>직위</TD><TE>대리</TE></TR></TABLE>`,
      ),
    );
    expect(corporation).toMatchObject({ relationshipRaw: '10%이상주주', positionRaw: null });
  });

  it.each([
    ['', 'TABLE_NOT_FOUND'],
    ['<TABLE><TR><TD>요약</TD><TD>내용</TD></TR></TABLE>', 'REQUIRED_HEADER_NOT_FOUND'],
    [
      `<TABLE>${typedHeader}<TR><TU>-</TU><TU>-</TU><TU>-</TU><TE>-</TE><TE>-</TE><TE>-</TE><TE>-</TE></TR></TABLE>`,
      'NO_DATA_ROWS',
    ],
    [
      `<TABLE>${typedHeader}<TR><TU>장내매수(+)</TU><TU>2026.09.01</TU><TU>보통주</TU><TE>0</TE><TE>알수없음</TE><TE>0</TE><TE>1,000</TE></TR></TABLE>`,
      'ROWS_FOUND_BUT_INVALID',
    ],
  ])(
    'keeps explicit zero-confidence diagnostics for empty or invalid extraction (%s)',
    (xml, code) => {
      const result = extractD002(tables(xml));
      expect(result.confidence).toBe(0);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code }));
      if (result.transactions.length) expect(result.transactions[0]?.confidence).toBe(0);
    },
  );

  it('keeps unknown positive methods unknown after TU alignment', () => {
    const result = extractD002(
      tables(
        `<TABLE>${typedHeader}<TR><TU>미확인취득</TU><TU>2026.09.01</TU><TU>보통주</TU><TE>0</TE><TE>100</TE><TE>100</TE><TE>1,000</TE></TR></TABLE>`,
      ),
    );
    expect(result.transactions[0]).toMatchObject({
      quantity: '100',
      nature: 'UNKNOWN',
      amount: null,
      confidence: 0.25,
    });
  });

  it('extracts only future-plan rows in D005 and retains reported price without inventing a price range', () => {
    const result = extractD005(
      tables(`<TABLE><TR><TH>거래일(결제일)</TH><TH>거래방법</TH><TH>특정증권등의종류</TH><TH>특정증권등의수(주식수)</TH></TR><TR><TU>2026.08.01</TU><TU>장내매수(+)</TU><TU>보통주</TU><TE>500</TE></TR></TABLE>
      <TABLE><TR><TH>거래개시일(결제일)</TH><TH>거래종료일(결제일)</TH><TH>거래기간</TH><TH>거래방법</TH><TH>특정증권등의종류</TH><TH>특정증권등의수(주식수)①</TH><TH>취득/처분단가(원)②</TH><TH>거래금액③</TH></TR><TR><TU>2026.10.02</TU><TU>2026.10.31</TU><TE>30</TE><TU>장내매수(+)</TU><TU>보통주</TU><TE>100</TE><TE>7,100</TE><TE>710,000</TE></TR></TABLE>`),
    );
    expect(result.planItems).toHaveLength(1);
    expect(result.planItems[0]).toMatchObject({
      plannedStartDate: '2026-10-02',
      plannedEndDate: '2026-10-31',
      quantity: '100',
      plannedUnitPrice: '7100',
      plannedAmount: '710000',
      priceMin: null,
      priceMax: null,
      currency: 'KRW',
    });
    expect(result.planItems[0]?.provenance?.quantity?.tableIndex).toBe(1);
  });

  it('ignores correction comparison rows while preserving distinct physical body rows', () => {
    const row =
      '<TR><TU>장내매수(+)</TU><TU>2026.09.01</TU><TU>보통주</TU><TE>0</TE><TE>100</TE><TE>100</TE><TE>1,000</TE></TR>';
    const result = extractD002(
      tables(
        `<BODY><LIBRARY><CORRECTION><TABLE>${typedHeader}${row}</TABLE><TABLE>${typedHeader}${row}</TABLE></CORRECTION><SECTION-1><TABLE>${typedHeader}${row}${row}</TABLE></SECTION-1></LIBRARY></BODY>`,
      ),
    );
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.map((row) => row.rowIndex)).toEqual([2, 3]);
    expect(result.transactions[0]?.provenance?.quantity?.sourcePath).toContain('SECTION-1');
    expect(result.transactions[0]?.provenance?.quantity?.tableIndex).toBe(2);
    const comparisonOnly = extractD002(
      tables(`<CORRECTION><TABLE>${typedHeader}${row}</TABLE></CORRECTION>`),
    );
    expect(comparisonOnly.transactions).toHaveLength(0);
    expect(comparisonOnly.confidence).toBe(0);
  });

  it('keeps source table and row ordinals and treats an inline TU as one containing cell', () => {
    const canonical = tables(
      '<TABLE></TABLE><TABLE><TR></TR><TR><TD><TU>값</TU></TD><TE>10</TE></TR></TABLE>',
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.index).toBe(1);
    expect(canonical[0]?.rows[1]).toEqual(['값', '10']);
    expect(canonical[0]?.grid[1]?.[0]).toMatchObject({
      tag: 'TD',
      sourceRowIndex: 1,
      sourceColumnIndex: 0,
    });
  });

  it.each(['증감금액', '증감비율', '증감(원)'])(
    'never reads a D001 monetary or percentage change as shares: %s',
    (leaf) => {
      const result = extractD001(
        tables(
          `<TABLE><TR><TH ROWSPAN="2">변동일</TH><TH ROWSPAN="2">취득/처분방법</TH><TH COLSPAN="3">변동내역</TH></TR><TR><TH>변동전</TH><TH>${leaf}</TH><TH>변동후</TH></TR><TR><TU>2026.09.01</TU><TU>장내매수(+)</TU><TE>0</TE><TE>100</TE><TE>100</TE></TR></TABLE>`,
        ),
      );
      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'REQUIRED_HEADER_NOT_FOUND' }),
      );
    },
  );

  it('rejects an explicit money unit on a share-count header', () => {
    const result = extractD002(
      tables(
        '<TABLE><TR><TH>변동일</TH><TH>보고사유</TH><TH>변동수량(원)</TH></TR><TR><TU>2026.09.01</TU><TU>장내매수(+)</TU><TE>100</TE></TR></TABLE>',
      ),
    );
    expect(result.transactions).toHaveLength(0);
    expect(result.confidence).toBe(0);
  });

  it('decodes source entities once and preserves the original encoded cell text', () => {
    const table = tables('<TABLE><TR><TU>A &amp; B &lt;기준&gt; &amp;lt;</TU></TR></TABLE>')[0]!;
    expect(table.rows[0]?.[0]).toBe('A & B <기준> &lt;');
    expect(table.grid[0]?.[0]?.rawText).toBe('A &amp; B &lt;기준&gt; &amp;lt;');
  });
});
