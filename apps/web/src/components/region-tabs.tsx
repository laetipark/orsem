import { useSearchParams } from 'react-router-dom';
import type { Region } from '../types';
import './region-tabs.css';

export function parseRegion(value: string | null): Region {
  return value === 'kr' || value === 'us' ? value : 'all';
}

export function useRegion() {
  const [params, setParams] = useSearchParams();
  const region = parseRegion(params.get('region'));
  const changeRegion = (value: Region) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === 'all') next.delete('region');
      else next.set('region', value);
      next.delete('cursor');
      return next;
    });
  return { region, changeRegion };
}

export function RegionTabs({ onChange }: { onChange?: () => void }) {
  const { region, changeRegion } = useRegion();
  return (
    <div className="region-tabs" role="group" aria-label="지역 선택">
      {(['all', 'kr', 'us'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={region === value}
          onClick={() => {
            changeRegion(value);
            onChange?.();
          }}
        >
          {{ all: '전체', kr: '국내', us: '미국' }[value]}
        </button>
      ))}
    </div>
  );
}
