import { zipSync, strToU8 } from 'fflate';
import { canonicalizeXmlTables, parseOpenDartDisclosure } from '../src';
import { extractD001 } from '../src/extractors/d001';
import { extractD002 } from '../src/extractors/d002';

const archive = (xml: string) => zipSync({ 'report.xml': strToU8(xml) });
const tables = (xml: string) =>
  canonicalizeXmlTables(`<DOCUMENT>${xml}</DOCUMENT>`, 'synthetic.xml').tables;

describe('five disclosure domains', () => {
  it('extracts a proxy solicitation without treating ballot bullets as booleans', async () => {
    const result = await parseOpenDartDisclosure({
      detailType: 'D003',
      archive: archive(`<DOCUMENT>
      <DOCUMENT-NAME>의결권대리행사권유참고서류</DOCUMENT-NAME><COMPANY-NAME>대상회사</COMPANY-NAME><BODY>
      <TABLE><TR><TD>가. 권유자</TD><TU ACODE="REC_NM">외부주주</TU><TD>나. 회사와의 관계</TD><TU ACODE="REC_COP_RL">주주</TU></TR>
      <TR><TD>주주총회일</TD><TD>2026년 9월 22일</TD><TD>권유시작일</TD><TD>2026년 9월 3일</TD></TR>
      <TR><TD>권유취지</TD><TU ACODE="REC_PPS">의결권 확보</TU></TR><TR><TD>전자/서면투표여부</TD><TD>전자투표 가능</TD></TR>
      <TR><TD>주주총회 목적사항</TD><TD></TD></TR><TR><TD>□ 정관의 변경</TD></TR><TR><TD>□ 이사 선임</TD></TR></TABLE>
      <TABLE><TR><TH>주주총회소집공고일</TH><TH>권유시작일</TH><TH>권유종료일</TH><TH>주주총회일</TH></TR><TR><TD>2026.09.02</TD><TD>2026.09.03</TD><TD>2026.09.21</TD><TD>2026.09.22</TD></TR></TABLE>
      <TABLE><TR><TD>일 시</TD><TD>2026년 9월 22일 오전 9시 30분</TD></TR><TR><TD>장 소</TD><TD>서울 본사</TD></TR></TABLE>
      </BODY></DOCUMENT>`),
    });
    expect(result).toMatchObject({
      detailType: 'D003',
      solicitorName: '외부주주',
      targetCompanyName: '대상회사',
      electronicVoting: true,
      meetingAt: '2026-09-22T00:30:00.000Z',
      agendas: [
        { ordinal: 1, title: '정관의 변경' },
        { ordinal: 2, title: '이사 선임' },
      ],
    });
  });

  it('keeps a tender report as planned quantities and preserves its document stage', async () => {
    const result = await parseOpenDartDisclosure({
      detailType: 'D004',
      archive:
        archive(`<DOCUMENT><DOCUMENT-NAME>[기재정정] 공개매수신고서</DOCUMENT-NAME><COMPANY-NAME>대상회사</COMPANY-NAME><BODY><TABLE>
      <TR><TD>공개매수자</TD><TD>ㆍ성명 : 매수회사 ■ 회사 □ 개인</TD></TR><TR><TD>공개매수 대상회사명</TD><TD>대상회사</TD></TR>
      <TR><TD>공개매수 목적</TD><TD>경영권 확보</TD></TR><TR><TD>공개매수대상 주식등</TD><TD>주식등의 종류</TD><TD>보통주식</TD></TR>
      <TR><TD>공개매수대상 주식등</TD><TD>매수 예정 수량(비율)</TD><TD>최소 3,000 주 최대 9,000 주</TD></TR><TR><TD>공개매수대상 주식등</TD><TD>매수 가격</TD><TD>주당 48,000원</TD></TR>
      <TR><TD>공개매수조건</TD><TD>최소수량 충족 조건</TD></TR><TR><TD>공개매수기간</TD><TD>2026.07.20.-2026.09.17. (결제일: 2026.09.21.)</TD></TR>
      <TR><TD>신고서제출일현재</TD><TD>보유 수량</TD><TD>2,000주</TD></TR><TR><TD>공개매수후(예정)</TD><TD>보유 수량</TD><TD>최소 5,000주 최대 11,000주</TD></TR>
    </TABLE></BODY></DOCUMENT>`),
    });
    expect(result).toMatchObject({
      detailType: 'D004',
      documentKind: 'REPORT',
      offerorName: '매수회사',
      targetCompanyName: '대상회사',
      subscriptionStartDate: '2026-07-20',
      subscriptionEndDate: '2026-09-17',
      settlementDate: '2026-09-21',
      securities: [
        {
          unitPrice: '48000',
          currency: 'KRW',
          minQuantity: '3000',
          maxQuantity: '9000',
          heldQuantity: '2000',
          expectedHoldingsMin: '5000',
          expectedHoldingsMax: '11000',
          offeredQuantity: null,
          acquiredQuantity: null,
        },
      ],
    });
  });

  it('extracts only the verified tender result tables and calculates the actual amount', async () => {
    const result = await parseOpenDartDisclosure({
      detailType: 'D004',
      archive:
        archive(`<DOCUMENT><DOCUMENT-NAME>공개매수결과보고서</DOCUMENT-NAME><COMPANY-NAME>대상회사</COMPANY-NAME><BODY>
      <COVER><TABLE><TR><TD>보 고 자</TD><TD>성 명 : 결과보고자</TD></TR></TABLE></COVER>
      <SECTION-1><TABLE><TR><TH>주식등의 종류</TH><TH>매수가격</TH><TH>매수예정수량</TH><TH>결제수단</TH></TR><TR><TD>기명식 보통주식</TD><TD>주당 6,700원</TD><TD>5,742,701주</TD><TD>현금</TD></TR></TABLE>
      <TABLE><TR><TH>주식등의 종류</TH><TH>예정주식 수</TH><TH>응모주식 수</TH><TH>매수주식 수</TH></TR><TR><TD>기명식 보통주식</TD><TD>5,742,701주</TD><TD>100주</TD><TD>90주</TD></TR></TABLE></SECTION-1>
      </BODY></DOCUMENT>`),
    });
    expect(result).toMatchObject({
      detailType: 'D004',
      documentKind: 'RESULT',
      offerorName: '결과보고자',
      targetCompanyName: '대상회사',
      confidence: 0.95,
      securities: [
        {
          unitPrice: '6700',
          currency: 'KRW',
          maxQuantity: '5742701',
          offeredQuantity: '100',
          acquiredQuantity: '90',
          actualAmount: '603000',
        },
      ],
    });
    expect(result.warnings).toEqual([]);
  });

  it('never promotes an unverified result layout into acquired quantities', async () => {
    const result = await parseOpenDartDisclosure({
      detailType: 'D004',
      archive: archive(
        '<DOCUMENT><DOCUMENT-NAME>공개매수결과보고서</DOCUMENT-NAME><COMPANY-NAME>대상</COMPANY-NAME><BODY><TABLE><TR><TD>공개매수 대상회사명</TD><TD>대상</TD></TR><TR><TD>공개매수 목적</TD><TD>목적</TD></TR><TR><TD>공개매수기간</TD><TD>2026.01.01.-2026.01.02.</TD></TR></TABLE></BODY></DOCUMENT>',
      ),
    });
    expect(result).toMatchObject({
      detailType: 'D004',
      documentKind: 'RESULT',
      securities: [],
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'UNVERIFIED_TENDER_RESULT_TEMPLATE' }),
      ]),
    });
  });

  it('accepts a strictly evidenced non-trading D001 report, but not a vague empty report', () => {
    const strict = extractD001(
      tables(
        `<TABLE><TR><TD>보고유형</TD><TD>변경보고</TD></TR><TR><TD>대표보고자</TD><TD>김보고</TD></TR><TR><TD>보고사유</TD><TD>담보계약 해지</TD></TR><TR><TD>보유주식등의수</TD><TD>100</TD></TR><TR><TD>보유비율</TD><TD>1.0</TD></TR><TR><TD>보유주식등의증감</TD><TD>0</TD></TR><TR><TD>보유비율증감</TD><TD>0</TD></TR></TABLE><TABLE><TR><TH>변동일</TH><TH>변동방법</TH><TH>변동수량</TH></TR></TABLE>`,
      ),
    );
    expect(strict).toMatchObject({
      nonTradingReport: true,
      reportReasonKind: 'CONTRACT_CHANGE',
      changes: [],
      confidence: 0.95,
    });
    expect(
      extractD001(tables('<TABLE><TR><TD>보고사유</TD><TD>기타</TD></TR></TABLE>')),
    ).toMatchObject({ nonTradingReport: false, reportReasonKind: 'UNKNOWN', confidence: 0 });
  });

  it.each([
    ['2,650(원)', '2650'],
    ['취득(13,950)', '13950'],
    ['(31,630원)', '31630'],
    ['전환가액조정(4,141원)', null],
  ])('parses only documented D002 price forms: %s', (raw, expected) => {
    const result = extractD002(
      tables(
        `<TABLE><TR><TH>변동일</TH><TH>특정증권등의 종류</TH><TH>취득/처분방법</TH><TH>증감수량</TH><TH>취득/처분단가</TH></TR><TR><TD>2026.09.01</TD><TD>보통주</TD><TD>장외매수(+)</TD><TD>10</TD><TD>${raw}</TD></TR></TABLE>`,
      ),
    );
    expect(result.transactions[0]?.unitPrice).toBe(expected);
  });
});
