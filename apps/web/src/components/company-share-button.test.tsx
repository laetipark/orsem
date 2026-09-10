import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanySummary } from '../types';
import { CompanyShareButton } from './company-share-button';

const company: CompanySummary = {
  id: 'company-id',
  canonicalPath: '/companies/005930',
  nameKo: '삼성전자',
  nameEn: null,
  market: 'KOSPI',
  stockCode: '005930',
  ticker: null,
  sector: '',
  priority: null,
  isListed: true,
  isWatchlisted: false,
  lastEventAt: null,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function start(share?: ReturnType<typeof vi.fn>, writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal('navigator', { share, clipboard: { writeText } });
  render(<CompanyShareButton company={company} />);
  fireEvent.click(screen.getByRole('button', { name: '종목 주소 공유' }));
  return writeText;
}
it('shares only the canonical public company URL using the device share sheet', async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  const copy = start(share);
  expect(share).toHaveBeenCalledWith({
    title: '삼성전자 · Orsem',
    url: `${window.location.origin}/companies/005930`,
  });
  await waitFor(() => expect(screen.getByRole('button', { name: '종목 주소 공유' })).toBeEnabled());
  expect(copy).not.toHaveBeenCalled();
});
it('copies the URL when native sharing is unavailable', async () => {
  const copy = start();
  expect(await screen.findByRole('status')).toHaveTextContent('종목 주소를 복사했습니다.');
  expect(copy).toHaveBeenCalledWith(`${window.location.origin}/companies/005930`);
});
it('does not copy or show an error after the user cancels sharing', async () => {
  const copy = start(vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')));
  await waitFor(() => expect(screen.getByRole('button', { name: '종목 주소 공유' })).toBeEnabled());
  expect(copy).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
});
it('offers a selectable URL if both native sharing and clipboard access fail', async () => {
  start(
    vi.fn().mockRejectedValue(new Error('Unavailable')),
    vi.fn().mockRejectedValue(new Error('Denied')),
  );
  const input = await screen.findByRole('textbox', { name: '공유할 종목 주소' });
  expect(input).toHaveValue(`${window.location.origin}/companies/005930`);
  fireEvent.click(screen.getByRole('button', { name: '공유 안내 닫기' }));
  expect(screen.queryByRole('status')).toBeNull();
});
