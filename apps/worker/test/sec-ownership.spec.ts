import { parseSecOwnership, SEC_OWNERSHIP_MAX_BYTES } from '../src/sec/ownership-parser';
import { ownershipXmlUrl } from '../src/sec/ownership-ingestion';

const provenance = {
  expectedCik: '0000000123',
  accessionNumber: '0000000123-26-000001',
  filingDate: '2026-09-05',
  acceptanceDateTime: '2026-09-05T10:00:00Z',
  sourceUrl: 'https://www.sec.gov/Archives/edgar/data/123/000000012326000001/ownership.xml',
};
const transaction = (
  code: string,
  price = '<transactionPricePerShare><value>12.340000</value><footnoteId id="F1"/></transactionPricePerShare>',
) => `<nonDerivativeTransaction>
<securityTitle><value>Common stock</value></securityTitle><transactionDate><value>2026-09-04</value></transactionDate>
<transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts>
<transactionShares><value>9007199254740993.123400</value></transactionShares>${price}<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>9999999999999999.000001</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>`;
const document = (
  rows = transaction('P'),
  type = '4',
) => `<?xml version="1.0"?><ownershipDocument><documentType>${type}</documentType><periodOfReport>2026-09-04</periodOfReport>
<issuer><issuerCik>123</issuerCik><issuerName>Synthetic &amp; Company</issuerName><issuerTradingSymbol>TEST</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>456</rptOwnerCik><rptOwnerName>Synthetic Owner</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer><isTenPercentOwner>1</isTenPercentOwner><isOther>0</isOther><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable>${rows}</nonDerivativeTable><footnotes><footnote id="F1">Private transaction terms.</footnote></footnotes></ownershipDocument>`;
it('preserves exact decimal strings, dates, raw codes, private purchase meaning, owner roles and footnotes', () => {
  const parsed = parseSecOwnership(document(), provenance);
  expect(parsed.issuer).toEqual({ cik: '0000000123', name: 'Synthetic & Company', ticker: 'TEST' });
  expect(parsed.reportingOwners[0]).toMatchObject({
    name: 'Synthetic Owner',
    isDirector: true,
    isOfficer: false,
    isTenPercentOwner: true,
  });
  expect(parsed.transactions[0]).toMatchObject({
    transactionShares: '9007199254740993.123400',
    transactionPrice: '12.340000',
    transactionDate: '2026-09-04',
    transactionCode: 'P',
    acquiredDisposedCode: 'A',
    derivedTransactionKind: 'OPEN_MARKET_OR_PRIVATE_PURCHASE',
    footnoteReferences: ['F1'],
  });
  expect(parsed.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(parsed.footnotes).toEqual([{ id: 'F1', text: 'Private transaction terms.' }]);
});
it.each(['P', 'S', 'A', 'M', 'F', 'G', 'J', 'C', 'D', 'Z'])(
  'preserves transaction code %s independently of acquisition direction',
  (code) => {
    const parsed = parseSecOwnership(document(transaction(code, '')), provenance);
    expect(parsed.transactions[0]?.transactionCode).toBe(code);
    expect(parsed.transactions[0]?.acquiredDisposedCode).toBe('A');
    expect(parsed.transactions[0]?.transactionPrice).toBeNull();
    if (code === 'Z') expect(parsed.transactions[0]?.derivedTransactionKind).toBe('UNKNOWN');
  },
);
it('retains multiple transactions and derivative facts separately', () => {
  const xml = document(transaction('A') + transaction('S')).replace(
    '</ownershipDocument>',
    `<derivativeTable>${transaction('M').replaceAll('nonDerivativeTransaction', 'derivativeTransaction')}</derivativeTable></ownershipDocument>`,
  );
  const parsed = parseSecOwnership(xml, provenance);
  expect(parsed.transactions.map((row) => row.derivative)).toEqual([false, false, true]);
  expect(parsed.transactions.map((row) => row.rowIndex)).toEqual([0, 1, 2]);
});
it.each(['3', '5', '4/A'])(
  'supports Form %s, holdings and amendment identity without inventing transactions',
  (type) => {
    const parsed = parseSecOwnership(
      document(
        '<nonDerivativeHolding><securityTitle><value>Common</value></securityTitle></nonDerivativeHolding>',
        type,
      ),
      provenance,
    );
    expect(parsed.transactions).toEqual([]);
    expect(parsed.holdings).toHaveLength(1);
    expect(parsed.amendment).toBe(type.endsWith('/A'));
  },
);
it.each([
  '<!DOCTYPE root [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
  '<!ENTITY x "external">',
  '<?other unsafe?>',
])('rejects unsafe declarations before parsing: %s', (prefix) => {
  expect(() => parseSecOwnership(prefix + document(), provenance)).toThrow();
});
it('rejects malformed, deeply nested, excessive node/byte XML and a mismatched issuer', () => {
  expect(() => parseSecOwnership(document().slice(0, -5), provenance)).toThrow();
  expect(() => parseSecOwnership('<a>'.repeat(33) + '</a>'.repeat(33), provenance)).toThrow();
  expect(() =>
    parseSecOwnership('<root>' + '<a/>'.repeat(30001) + '</root>', provenance),
  ).toThrow();
  expect(() => parseSecOwnership('x'.repeat(SEC_OWNERSHIP_MAX_BYTES + 1), provenance)).toThrow();
  expect(() => parseSecOwnership(document(), { ...provenance, expectedCik: '0000000999' })).toThrow(
    'mismatch',
  );
});
it('normalizes the SEC ownership viewer path without contacting arbitrary or encoded paths', () => {
  const source = {
    externalId: provenance.accessionNumber,
    rawMetadataJson: { cik: provenance.expectedCik },
    url: provenance.sourceUrl.replace('ownership.xml', 'xslF345X05/ownership.xml'),
  };
  expect(ownershipXmlUrl(source).toString()).toBe(provenance.sourceUrl);
  for (const url of [
    source.url.replace('www.sec.gov', 'sec.gov.evil.example'),
    source.url.replace('https:', 'http:'),
    source.url + '?redirect=https://evil.example',
    source.url.replace('ownership.xml', '%2e%2e/ownership.xml'),
    source.url.replace('ownership.xml', 'file.html'),
  ]) {
    expect(() => ownershipXmlUrl({ ...source, url })).toThrow();
  }
});
