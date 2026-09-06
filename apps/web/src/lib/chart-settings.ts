export const smaPeriods = [5, 20, 60, 120] as const;
export const rsiPeriods = [7, 14, 21] as const;
export const indicatorStorageKey = 'orsem-chart-indicators-v1';
export interface ChartSettings {
  volume: boolean;
  sma: number[];
  rsi: boolean;
  rsiPeriod: number;
}
export function defaultChartSettings(): ChartSettings {
  return { volume: true, sma: [5, 20, 60], rsi: true, rsiPeriod: 14 };
}
export function loadChartSettings(): ChartSettings {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(indicatorStorageKey) ?? 'null');
    if (!value || typeof value !== 'object') return defaultChartSettings();
    const input = value as Partial<ChartSettings>;
    if (
      typeof input.volume !== 'boolean' ||
      typeof input.rsi !== 'boolean' ||
      !Array.isArray(input.sma) ||
      !input.sma.every((period) => smaPeriods.some((option) => option === period)) ||
      !rsiPeriods.some((period) => period === input.rsiPeriod)
    )
      return defaultChartSettings();
    return {
      volume: input.volume,
      sma: [...new Set(input.sma)].sort((a, b) => a - b),
      rsi: input.rsi,
      rsiPeriod: input.rsiPeriod!,
    };
  } catch {
    return defaultChartSettings();
  }
}
