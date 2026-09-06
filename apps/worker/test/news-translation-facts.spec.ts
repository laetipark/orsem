import { validateTranslationFacts } from '../src/ai/news-translation-facts';

describe('explicit translation facts', () => {
  it.each([
    ['Revenue reached $10.5 billion on September 3.', '9월 3일 매출은 105억 달러에 도달했다.'],
    ['Results on Sept. 3, 2026', '2026년 9월 3일 실적'],
    ['Results on Sep 3', '9월 3일 실적'],
    ['Results in September', '9월 실적'],
    ['September results', '9월 실적'],
    ['September Results', '9월 실적'],
    ['September earnings exceeded expectations', '9월 실적이 예상을 웃돌았다'],
    ['September meeting', '9월 회의'],
    ['September Meeting', '9월 회의'],
    ['September meetings were scheduled', '9월 회의가 예정됐다'],
    ['September report', '9월 보고서'],
    ['September Reports', '9월 보고서'],
    ['September 2026 results', '2026년 9월 실적'],
    ['May results', '5월 실적'],
    ['May Report: policy overview', '5월 보고서: 정책 개요'],
    ['September', '9월'],
    ['Sept.', '9월'],
    ['Results in June. Board approved the report.', '6월 실적. 이사회가 보고서를 승인했다.'],
    ['The release is scheduled for early June.', '발표는 6월 초에 예정되어 있다.'],
    ['The release is scheduled for late June.', '발표는 6월 말에 예정되어 있다.'],
    ['The release is scheduled for mid June.', '발표는 6월 중순에 예정되어 있다.'],
    ['The release is scheduled for mid-June.', '발표는 6월 중순에 예정되어 있다.'],
    ['The release is scheduled for the month of June.', '발표는 6월에 예정되어 있다.'],
    ['Results in May', '5월 실적'],
    ['Results on May 12', '5월 12일 실적'],
    ['Results on May 3rd', '5월 3일 실적'],
    ['Results in March', '3월 실적'],
    ['Company may grow', '회사가 성장할 수 있다'],
    ['Company may report earnings', '회사가 실적을 발표할 수 있다'],
    ['Company may report.', '회사가 발표할 수 있다.'],
    ['May results improve?', '실적이 개선될 수 있을까?'],
    ['March forward', '앞으로 나아가라'],
    ['March results', '3월 실적'],
    ['The workers march.', '노동자들이 행진한다.'],
    ['June Park discussed the results', '준 박이 실적을 논의했다'],
    ['April Kim discussed the results', '에이프릴 김이 실적을 논의했다'],
    ['Jan Lee discussed the results', '얀 리가 실적을 논의했다'],
    ['The report was prepared by April Kim', '에이프릴 김이 보고서를 준비했다'],
    ['The report was prepared for June Park', '준 박을 위해 보고서를 준비했다'],
    ['The report was prepared by June A. Park', '준 에이 박이 보고서를 준비했다'],
    ['June Park spoke on September 3', '준 박은 9월 3일 발언했다'],
    ['Results on 2026-09-05', '2026년 9월 5일 실적'],
    ['Growth expected at 3-4%', '성장률은 3~4% 예상'],
    ['September 26-30', '9월 26~30일'],
    ['Growth was −5%', '성장률은 -5%였다'],
    ['Revenue reached $1.25 billion', '매출은 12억 5천만 달러'],
    ['Revenue reached $1.25 billion', '매출은 12억5천만 달러'],
    ['Revenue reached $1.25 trillion', '매출은 1조 2500억 달러'],
    ['Loss was -$1.25 billion', '손실은 -12억 5천만 달러'],
    ['Revenue reached $10bn', '매출은 100억 달러'],
    ['Revenue reached USD 10mn', '매출은 1000만 달러'],
    ['Rate is 3-1/2 percent', '금리는 3.5%'],
    ['Rate is 3 3/4%', '금리는 3.75%'],
    ['Rate is -3-1/2%', '금리는 -3.5%'],
    ['Rate is 3-7/25%', '금리는 3.28%'],
    ['Rate is at 3-1/2 to 3-3/4 percent', '금리는 3.5%에서 3.75%로 정했다'],
    ['The rate is 3-1/2 to 3-3/4 percent.', '금리는 3.5%에서 3.75%다.'],
    ['The rate is 3.5 to 3.75%.', '금리는 3.5%~3.75%.'],
    ['Rate is at 3.5 to 3.75 percent', '금리는 3.5%에서 3.75%로 정했다'],
    ['Rate is at 3.5% to 3.75%', '금리는 3.5~3.75%다'],
    ['Rate is at 3.5 through 3.75 percent', '금리는 3.5%에서 3.75%로 정했다'],
    ['Rate is at -3.5 to -2.75 percent', '금리는 -3.5%에서 -2.75%로 정했다'],
    ['Value is 0.100000000000000001 billion', '값은 100000000.000000001'],
    ['Revenue in first-quarter increased 12 percent', '1분기 매출이 12퍼센트 증가했다'],
    ['Results were released Tuesday', '화요일 실적이 발표됐다'],
    ['Results on Tuesday and Friday', '화요일과 금요일 실적'],
    [
      'The release is due Tue., September 8, 2026.',
      '발표는 2026년 9월 8일 화요일에 예정되어 있다.',
    ],
    ['The release is due Tues.', '발표는 화요일에 예정되어 있다.'],
    ['The release is due Thu.', '발표는 목요일에 예정되어 있다.'],
    ['The release is due Thur.', '발표는 목요일에 예정되어 있다.'],
    ['The release is due Thurs.', '발표는 목요일에 예정되어 있다.'],
    ['The release is due Wed.', '발표는 수요일에 예정되어 있다.'],
    ['The release is due Fri.', '발표는 금요일에 예정되어 있다.'],
    ['The release is due Sat.', '발표는 토요일에 예정되어 있다.'],
    ['The release is due Sun.', '발표는 일요일에 예정되어 있다.'],
    ['The release is due Mon.', '발표는 월요일에 예정되어 있다.'],
    ['Tues', '화요일'],
    ['Thurs', '목요일'],
    ['Sun Microsystems released results.', '선 마이크로시스템즈가 실적을 발표했다.'],
    ['The sun is bright.', '태양이 밝다.'],
    ['The board sat down.', '이사회가 자리에 앉았다.'],
    ['TueExample was released.', '튜이그잼플이 발표됐다.'],
    ['Eurozone inflation reached 2 percent.', '유로존 물가 상승률은 2퍼센트에 도달했다.'],
    ['Foundry revenue grew 2 percent.', '파운드리 매출은 2퍼센트 성장했다.'],
    ['Revenue was $2 million and $3 million', '매출은 200만 달러와 300만 달러'],
    ['Revenue was USD 2 million', '매출은 200만 미국 달러'],
    ['Revenue was EUR 2 million', '매출은 200만 유로'],
    ['Revenue was EUR 2 million', '매출은 200만 유로화'],
    ['Revenue was GBP 2 million', '매출은 200만 파운드'],
    ['Revenue was CAD 2 million', '매출은 200만 캐나다 달러'],
    ['Revenue was 2 million Canadian dollars', '매출은 200만 캐나다 달러'],
    ['Revenue was KRW 2 million', '매출은 200만 원'],
    ['Revenue was 200 million yen', '매출은 2억 엔'],
    ['Revenue was JPY 200 million', '매출은 2억엔'],
    ['Revenue was JPY 200 million', '매출은 2억 엔화'],
    ['Price was JPY 200', '가격은 200엔짜리'],
    ['Company tested 2 engines', '회사는 2엔진을 시험했다'],
    ['Price was KRW 2 million', '가격은 200만 원짜리'],
    ['Revenue was 2 million won', '매출은 200만 원'],
    ['The company won the contract', '회사가 계약을 따냈다'],
    ['Employees worked in a different dimension', '직원이 다른 차원에서 일했다'],
  ])('accepts equivalent facts: %s', (before, after) => {
    expect(() => validateTranslationFacts(before, after)).not.toThrow();
  });

  it.each([
    ['Growth was −5%', '성장률은 5%', 'numeric'],
    ['Growth was −5%', '성장률은 +5%', 'numeric'],
    ['Loss was -$1.25 billion', '손실은 12억 5천만 달러', 'numeric'],
    ['Growth was -1.5%', '성장률은 -1.5', 'numeric'],
    ['Revenue reached $1.25 billion', '매출은 12억 6천만 달러', 'numeric'],
    ['Revenue reached $10bn', '매출은 10억 달러', 'numeric'],
    ['Rate is 3-1/2%', '금리는 3.25%', 'numeric'],
    ['Rate is 3-1/2 to 3-3/4 percent', '금리는 3.5%에서 3.8%다', 'numeric'],
    ['The rate is 3-1/2 to 3-3/4 percent.', '금리는 3.5%에서 3.8%다.', 'numeric'],
    ['The sequence is 3.5 to 3.75 percent.25', '수열은 3.5%~3.75%.25', 'numeric'],
    ['Rate is 3.5 to 3.75 percent', '금리는 3.5에서 3.75다', 'numeric'],
    ['Rate is -3.5 to -2.75 percent', '금리는 3.5%에서 2.75%다', 'numeric'],
    [
      'Revenue was 3.5. Growth was 3.75 percent.',
      '매출은 3.5%였다. 성장률은 3.75%였다.',
      'numeric',
    ],
    [
      'Revenue was 3.5 and growth was 3.75 percent.',
      '매출은 3.5%이고 성장률은 3.75%였다.',
      'numeric',
    ],
    ['Rate is 3-4%', '금리는 3.4%', 'numeric'],
    ['Date is 3/4', '날짜는 0.75', 'numeric'],
    ['Value is 0.100000000000000001 billion', '값은 100000000', 'numeric'],
    ['Revenue was USD 2 million', '매출은 200만 원', 'currency'],
    ['Revenue was $2 million', '매출은 200만 원', 'currency'],
    ['Revenue was $2 million', '매출은 200만', 'currency'],
    ['Revenue was CAD 2 million', '매출은 200만 미국 달러', 'currency'],
    ['Revenue was 200 million yen', '매출은 2억 원', 'currency'],
    ['Revenue was JPY 200 million', '매출은 2억 달러', 'currency'],
    ['Revenue was JPY 200 million', '매출은 2억', 'currency'],
    ['Results on Tuesday', '금요일 실적', 'weekday'],
    ['Results on Tuesday', '실적 발표', 'weekday'],
    ['The release is due Tue.', '발표는 금요일에 예정되어 있다.', 'weekday'],
    ['The release is due Thurs.', '발표는 화요일에 예정되어 있다.', 'weekday'],
    ['Results in September', '8월 실적', 'calendar month'],
    ['September results', '8월 실적', 'calendar month'],
    ['September meeting', '10월 회의', 'calendar month'],
    ['September Report', '8월 보고서', 'calendar month'],
    ['Results on September 3', '3월 9일 실적', 'calendar month'],
    ['Results on 2026-09-05', '2026년 5월 9일 실적', 'calendar month'],
  ])('rejects changed facts: %s', (before, after, reason) => {
    expect(() => validateTranslationFacts(before, after)).toThrow(reason);
  });

  it.each([
    ['In H1 2026, revenue increased.', '2026년 상반기에 매출이 증가했다.'],
    ['In H2 2026, revenue may increase.', '2026 년 하반기에 매출이 증가할 수 있다.'],
    ['Results for 2026 H1', '2026년상반기 실적'],
    ['Results for H2 of 2026', '2026년 하반기 실적'],
    ['Results for the first half of 2026', '2026년 상반기 실적'],
    ['Results for the second-half of 2026', '2026년 하반기 실적'],
    ['Results for 2026 first half', '2026년 상반기 실적'],
    [
      'Revenue in H1 2026 and H2 2027 rose 12 percent.',
      '2027년 하반기 및 2026년 상반기 매출은 12퍼센트 증가했다.',
    ],
    [
      'In H2 2026, HBM4 and DDR5 demand grew 12 percent.',
      '2026년 하반기 HBM4 및 DDR5 수요는 12퍼센트 증가했다.',
    ],
    ['The H1 chip was released in 2026.', 'H1 칩은 2026년에 출시됐다.'],
    ['The 2026 H1 chip was released.', '2026년 H1 칩이 출시됐다.'],
    ['The H1 2026 chip was released.', 'H1 2026 칩이 출시됐다.'],
    ['The H1N1 strain was studied in 2026.', 'H1N1 균주를 2026년에 연구했다.'],
  ])(
    'accepts equivalent explicit half-year facts without consuming product numbers: %s',
    (before, after) => {
      expect(() => validateTranslationFacts(before, after)).not.toThrow();
      expect(() => validateTranslationFacts(after, before)).not.toThrow();
    },
  );

  it.each([
    ['Results for H1 2026', '2026년 하반기 실적', 'half-year'],
    ['Results for H2 2026', '2026년 상반기 실적', 'half-year'],
    ['Results for H1 2026', '2026년 1분기 실적', 'half-year'],
    ['Results for H2 2026', '2026년 2분기 실적', 'half-year'],
    ['Results for H1 2026', '2027년 상반기 실적', 'half-year'],
    ['Results for H1 2026', '2026년 실적', 'half-year'],
    ['Results for H1 2026', '상반기 실적', 'half-year'],
    ['Results for 2026', '2026년 상반기 실적', 'half-year'],
    ['Results for H1 2026 and H2 2027', '2026년 하반기 및 2027년 상반기 실적', 'half-year'],
    ['H1 2026 and H1 2026 results', '2026년 상반기 및 2026년 실적', 'half-year'],
    [
      'In H2 2026, HBM4 demand grew 12 percent.',
      '2026년 하반기 HBM5 수요는 12퍼센트 증가했다.',
      'numeric',
    ],
    ['Revenue in H1 2026 rose 12 percent.', '2026년 상반기 매출은 13퍼센트 증가했다.', 'numeric'],
    ['The H1 chip was released in 2026.', 'H2 칩은 2026년에 출시됐다.', 'numeric'],
    ['The 2026 H1 chip was released.', '2026년 상반기 칩이 출시됐다.', 'half-year'],
    ['The H1 2026 chip was released.', '2026년 상반기 칩이 출시됐다.', 'half-year'],
    ['The H1 chip was released.', '상반기 칩이 출시됐다.', 'numeric'],
    ['The H1N1 strain was studied.', '상반기 균주를 연구했다.', 'numeric'],
  ])(
    'rejects changed half-years, their years, or other numeric facts: %s',
    (before, after, reason) => {
      expect(() => validateTranslationFacts(before, after)).toThrow(reason);
    },
  );

  it('preserves ticker boundaries and keeps error messages free of source text', () => {
    expect(() =>
      validateTranslationFacts('NVIDIA (NVDA) rose', 'NVIDIA(NVDA) 상승', ['NVDA']),
    ).not.toThrow();
    expect(() => validateTranslationFacts('NVIDIA (NVDA) rose', '엔비디아 상승', ['NVDA'])).toThrow(
      'Local translation changed a ticker symbol.',
    );
    expect(() => validateTranslationFacts('NVDAA rose', '엔비디아 상승', ['NVDA'])).not.toThrow();
  });

  it.each([
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 EDT에 발표'],
    ['For release at 4:30 p.m. EDT', '미 동부 일광절약 시간 오후 4시 30분에 발표'],
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 (미국 동부 서머타임)에 발표'],
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 동부 일광 절약 시간(EDT)에 발표'],
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 동부 일광절약(서머타임) 시간에 발표'],
    ['For release at 4:30 p.m. EST', '오후 4시 30분 (미 동부 표준시)에 발표'],
    ['For release at 4:30 p.m. EST', '오후 4시 30분 (동부 표준시간)에 발표'],
    ['For release at 4:30 p.m. Eastern Daylight Time', '오후 4시 30분 EDT에 발표'],
    ['For release at 4:30 p.m. Eastern Standard Time', '오후 4시 30분 EST에 발표'],
    ['For release at 4:30 a.m. EDT', '오전 4시 30분 EDT에 발표'],
    ['For release at 4:30 AM EDT', '오전 4:30 EDT에 발표'],
    ['For release at 4:30pm EDT', '오후 4:30 EDT에 발표'],
    ['For release at 11:00 a.m. EDT', 'EDT 시간 11:00에 발표'],
    ['For release at 11:00 a.m. EDT', '발표 시각은 EDT 11:00.'],
    ['For release at 11 AM EDT', 'EDT 시간 11시 00분에 발표'],
    ['For release at 4:30 p.m. EDT', 'EDT 시간 16:30에 발표'],
    ['For release at 4:30 p.m. EDT', '16시 30분 EDT에 발표'],
    ['For release at 9 p.m. EDT', '21시 EDT에 발표'],
    ['For release at 12 a.m. EST', '00:00 EST에 발표'],
    ['For release at 12 a.m. EST', '0시 00분 EST에 발표'],
    ['For release at 12 p.m. EST', '12:00 EST에 발표'],
    ['For release at 12 p.m. EST', '12시 00분 EST에 발표'],
    ['For release at 16:30 EDT', '오후 4시 30분 EDT에 발표'],
    ['For release at 11:00 EDT', '오전 11시 00분 EDT에 발표'],
    ['For release at 00:00 EST', '오전 12시 EST에 발표'],
    ['For release at 12:00 EST', '오후 12시 EST에 발표'],
    ['For release at 04:03 p.m. EDT', '오후 4시 3분 EDT에 발표'],
    ['For release at 4 p.m. EDT', '오후 4시 EDT에 발표'],
    ['For release at 4 p.m. EDT', '오후 4시 00분 EDT에 발표'],
    ['For release at 4:00 p.m. EDT', '오후 4시 EDT에 발표'],
    ['For release at 12:30 a.m. EST', '오전 12시 30분 EST에 발표'],
    ['For release at 12:30 p.m. EST', '오후 12시 30분 EST에 발표'],
    ['For release at 4:30 p.m. UTC', '오후 4시 30분 UTC에 발표'],
    ['For release at 4:30 p.m. KST', '오후 4시 30분 KST에 발표'],
    ['For release at 16:30 UTC', '16시 30분 UTC에 발표'],
    ['The note contains GMT and KST labels.', '메모에 GMT와 KST 표기가 있다.'],
    ['I am ready this afternoon.', '나는 오늘 오후에 준비가 되어 있다.'],
    ['I am 4 years old.', '나는 4살이다.'],
    ['There are 4 people this afternoon.', '오후에는 4명이 있다.'],
    ['News from the eastern region.', '동부 지역 소식이다.'],
    ['News from the eastern standard market.', '동부 표준시장 소식이다.'],
    ['We hired 4 PMs.', '우리는 프로젝트 매니저 4명을 채용했다.'],
    ['The ratio is 11:00.', '비율은 11 대 0이다.'],
    ['There are 3 cities and 2 counties.', '3시2군이 있다.'],
  ])('accepts equivalent explicit time facts: %s', (before, after) => {
    expect(() => validateTranslationFacts(before, after)).not.toThrow();
  });

  it.each([
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 (동부 표준시)에 발표', 'time zone'],
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 EST에 발표', 'time zone'],
    ['For release at 4:30 p.m. EST', '오후 4시 30분 EDT에 발표', 'time zone'],
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 동부 표준시(EDT)에 발표', 'time zone'],
    ['For release at 4:30 p.m. EDT', '오후 4시 30분 동부 시간에 발표', 'time zone'],
    ['For release at 4:30 p.m. EDT', '4시 30분 EDT에 발표', 'clock time'],
    ['For release at 4:30 p.m. EDT', '4:30 EDT에 발표', 'clock time'],
    ['For release at 9 p.m. EDT', '9시 EDT에 발표', 'clock time'],
    ['For release at 11 a.m. EDT', '23:00 EDT에 발표', 'clock time'],
    ['For release at 12 a.m. EST', '12:00 EST에 발표', 'clock time'],
    ['For release at 12 p.m. EST', '00:00 EST에 발표', 'clock time'],
    ['For release at 12 a.m. EST', '24:00 EST에 발표', 'clock time'],
    ['For release at 11 p.m. EST', '25시 EST에 발표', 'clock time'],
    ['For release at 4:30 p.m. EDT', '오전 4시 30분 EDT에 발표', 'clock time'],
    ['For release at 4:30 a.m. EDT', '오후 4시 30분 EDT에 발표', 'clock time'],
    ['For release at 4:30 p.m. EDT', '오후 4시 31분 EDT에 발표', 'clock time'],
    ['For release at 4:30 p.m. EDT', '오후 3시 40분 EDT에 발표', 'clock time'],
    ['Releases at 4:30 a.m. and 5:30 p.m.', '오후 4시 30분과 오전 5시 30분에 발표', 'clock time'],
    ['Growth was 5% at 4:30 p.m.', '오후 4시 30분에 성장률은 6%였다', 'numeric'],
    ['Release is in the afternoon.', '오후 4시에 발표', 'clock time'],
  ])('rejects changed explicit time facts: %s', (before, after, reason) => {
    expect(() => validateTranslationFacts(before, after)).toThrow(reason);
  });

  it('does not treat ambiguous number words as numeric quantities', () => {
    expect(() =>
      validateTranslationFacts('One of Six Flags parks', '식스 플래그스 공원 중 하나'),
    ).not.toThrow();
    expect(() => validateTranslationFacts('Hired six employees', '직원 6명 채용')).toThrow(
      'numeric',
    );
  });

  it('does not claim to validate sentence meaning or the subject of numeric values', () => {
    expect(() =>
      validateTranslationFacts('Will not acquire the company', '회사를 인수한다'),
    ).not.toThrow();
    expect(() =>
      validateTranslationFacts(
        'Revenue rose 10% and profit fell 20%',
        '매출은 20% 증가하고 이익은 10% 감소했다',
      ),
    ).not.toThrow();
    expect(() =>
      validateTranslationFacts(
        'Revenue was USD 2 million and costs were EUR 3 million',
        '매출은 200만 유로이고 비용은 300만 달러였다',
      ),
    ).not.toThrow();
  });
});
