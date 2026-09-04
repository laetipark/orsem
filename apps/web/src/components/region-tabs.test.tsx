import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { RegionTabs } from './region-tabs';

afterEach(cleanup);
function Harness() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <RegionTabs />
      <output>{location.search}</output>
      <button onClick={() => void navigate(-1)}>뒤로</button>
    </>
  );
}
it('preserves search and filters, removes the old cursor and restores selection on browser back', () => {
  render(
    <MemoryRouter initialEntries={['/events?q=삼성&priority=P1&region=kr&cursor=old']}>
      <Harness />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: '미국' }));
  expect(screen.getByRole('status').textContent).toContain('q=%EC%82%BC%EC%84%B1');
  expect(screen.getByRole('status').textContent).toContain('priority=P1');
  expect(screen.getByRole('status').textContent).toContain('region=us');
  expect(screen.getByRole('status').textContent).not.toContain('cursor');
  fireEvent.click(screen.getByRole('button', { name: '뒤로' }));
  expect(screen.getByRole('button', { name: '국내' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('status').textContent).toContain('cursor=old');
});
