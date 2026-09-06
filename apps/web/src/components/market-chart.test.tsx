import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarketChart } from './market-chart';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  setData: vi.fn(),
  remove: vi.fn(),
  fit: vi.fn(),
  apply: vi.fn(),
  restore: vi.fn(),
  theme: 'dark',
}));
vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  LineSeries: {},
  createChart: mocks.create,
}));
vi.mock('../theme', () => ({ useTheme: () => ({ theme: mocks.theme }) }));

const points = [
  { date: '2026-09-01', value: '100' },
  { date: '2026-09-02', value: '102' },
];
const props = { name: '시험 지표', unit: 'USD', currency: 'USD', points };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.theme = 'dark';
  mocks.create.mockReturnValue({
    addSeries: () => ({ setData: mocks.setData }),
    applyOptions: mocks.apply,
    remove: mocks.remove,
    timeScale: () => ({
      fitContent: mocks.fit,
      getVisibleLogicalRange: () => ({ from: 1, to: 3 }),
      setVisibleLogicalRange: mocks.restore,
    }),
  });
});
afterEach(cleanup);

it('reuses its chart and preserves the viewport during data and theme refreshes', () => {
  const view = render(<MarketChart {...props} />);
  view.rerender(
    <MarketChart {...props} points={[...points, { date: '2026-09-03', value: '103' }]} />,
  );
  mocks.theme = 'light';
  view.rerender(<MarketChart {...props} />);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.fit).toHaveBeenCalledTimes(1);
  expect(mocks.restore).toHaveBeenCalledWith({ from: 1, to: 3 });
  expect(mocks.setData).toHaveBeenLastCalledWith([
    { time: '2026-09-01', value: 100 },
    { time: '2026-09-02', value: 102 },
  ]);
  view.unmount();
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});

it('releases the chart when data disappears and fits a newly selected instrument', () => {
  const view = render(<MarketChart {...props} points={[]} />);
  expect(mocks.create).not.toHaveBeenCalled();
  view.rerender(<MarketChart {...props} />);
  view.rerender(<MarketChart {...props} name="다른 지표" />);
  expect(mocks.fit).toHaveBeenCalledTimes(2);
  view.rerender(<MarketChart {...props} points={[]} />);
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});

it('only mounts the data table while expanded and uses the same normalized points as the chart', () => {
  render(
    <MarketChart
      {...props}
      points={[
        ...points,
        { date: '2026-09-02', value: '104' },
        { date: '2026-09-03', value: 'invalid' },
      ]}
    />,
  );
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  const details = screen.getByText('차트 데이터 보기').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  expect(screen.getAllByRole('row')).toHaveLength(3);
  expect(mocks.setData).toHaveBeenLastCalledWith([
    { time: '2026-09-01', value: 100 },
    { time: '2026-09-02', value: 104 },
  ]);
  details.open = false;
  fireEvent(details, new Event('toggle'));
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
