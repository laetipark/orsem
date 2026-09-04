import { openDartStatusPolicy } from '../src/opendart/status-policy';

describe('OpenDART status policy', () => {
  it('treats 013 as an empty successful result', () => {
    expect(openDartStatusPolicy('013', 'LIST')).toMatchObject({
      emptyResult: true,
      retryPolicy: 'NONE',
    });
  });

  it('does not immediately retry a daily request limit', () => {
    expect(openDartStatusPolicy('020', 'LIST')).toMatchObject({
      retryPolicy: 'NEXT_KST_DAY',
      disablesUntilNextKstDay: true,
    });
  });

  it('delays a newly observed missing document but not other 014 errors', () => {
    expect(openDartStatusPolicy('014', 'DOCUMENT').retryPolicy).toBe('DELAYED_DOCUMENT');
    expect(openDartStatusPolicy('014', 'SUMMARY').retryPolicy).toBe('NONE');
  });

  it.each(['800', '900'])('backs off transient service status %s', (status) => {
    expect(openDartStatusPolicy(status, 'LIST').retryPolicy).toBe('SHORT_BACKOFF');
  });
});
