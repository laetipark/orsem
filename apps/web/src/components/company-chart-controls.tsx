import { Maximize, Expand, Shrink } from 'lucide-react';
import { useId, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  defaultChartSettings,
  smaColors,
  smaPeriods,
  rsiPeriods,
  type ChartSettings,
} from '../lib/chart-settings';
import type { CompanyChartType } from '../lib/use-company-chart';
import { HelpPopover } from './help-popover';

export function CompanyChartControls({
  toolbar,
  chartType,
  onChartTypeChange,
  settings,
  setSettings,
  compact,
  minute,
  expanded,
  onExpand,
  latestDisabled,
  onShowLatest,
  onFitContent,
}: {
  toolbar?: ReactNode;
  chartType: CompanyChartType;
  onChartTypeChange: (type: CompanyChartType) => void;
  settings: ChartSettings;
  setSettings: Dispatch<SetStateAction<ChartSettings>>;
  compact: boolean;
  minute: boolean;
  expanded: boolean;
  onExpand?: () => void;
  latestDisabled: boolean;
  onShowLatest: () => void;
  onFitContent: () => void;
}) {
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const settingsPanelId = useId();

  return (
    <div className="indicator-toolbar">
      {toolbar ? <div className="chart-primary-controls">{toolbar}</div> : null}
      <div className="chart-type-control" role="group" aria-label="차트 형태">
        {(['candle', 'line'] as const).map((type) => (
          <button
            type="button"
            key={type}
            aria-pressed={chartType === type}
            onClick={() => onChartTypeChange(type)}
          >
            {type === 'candle' ? '캔들' : '라인'}
          </button>
        ))}
      </div>
      <div className="chart-ma-control" role="group" aria-label="이동평균 빠른 선택">
        <span>MA</span>
        {smaPeriods.map((period) => (
          <button
            type="button"
            key={period}
            aria-label={`이동평균 ${period}`}
            aria-pressed={settings.sma.includes(period)}
            style={{ color: settings.sma.includes(period) ? smaColors[period] : undefined }}
            onClick={() =>
              setSettings((current) => ({
                ...current,
                sma: current.sma.includes(period)
                  ? current.sma.filter((value) => value !== period)
                  : [...current.sma, period].sort((a, b) => a - b),
              }))
            }
          >
            {period}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="chart-expand-button"
        aria-label={expanded ? '확대 보기 닫기' : '차트 확대 보기'}
        onClick={onExpand}
      >
        {expanded ? <Shrink size={16} /> : <Expand size={16} />}
        <span>{expanded ? '닫기' : '확대'}</span>
      </button>
      <button
        type="button"
        className="chart-latest-button"
        aria-label="최신 봉 보기"
        disabled={latestDisabled}
        onClick={onShowLatest}
      >
        최신 봉
      </button>
      <button
        type="button"
        className="indicator-settings-toggle"
        aria-expanded={settingsExpanded}
        aria-controls={settingsPanelId}
        onClick={() => setSettingsExpanded(!settingsExpanded)}
      >
        보조지표{' '}
        <span>{settings.sma.length + Number(settings.volume) + Number(settings.rsi)}개 사용</span>
      </button>
      <button
        type="button"
        className="chart-fit-button"
        aria-label="화면 맞춤"
        title="화면 맞춤"
        onClick={onFitContent}
      >
        <Maximize size={16} aria-hidden="true" />
        <span>화면 맞춤</span>
      </button>
      <HelpPopover label="차트 조작·지표 안내">
        <p>
          {compact
            ? '터치로 봉 선택 · 두 손가락으로 확대'
            : '드래그로 이동 · 마우스 휠로 확대 · 범례에서 ← → 키로 봉 선택'}
        </p>
        <p className="indicator-note">
          {settings.volume ? '아래 막대: 거래량. ' : ''}
          {settings.rsi
            ? `RSI(${settings.rsiPeriod})는 0–100 범위이며 점선은 30·70 기준입니다. `
            : ''}
          표시 기간 이전의 저장된 봉도 지표 계산에 사용합니다. 이동평균은 기간만큼, RSI는 기간보다
          1개 많은 연속 유효 봉이 필요합니다. 부족한 구간은 —로 표시합니다.
        </p>
        <p>
          {minute
            ? '1분봉은 한국 시간(KST)으로 표시합니다. '
            : 'T 거래·변동일 · F 공시일 · N 뉴스·IR. 거래·변동일과 공시 발표일은 구분합니다. '}
          현재가와 차트는 2초마다 갱신하며 장중 가격은 바뀔 수 있습니다.
        </p>
      </HelpPopover>
      {settingsExpanded ? (
        <div className="indicator-settings__body" id={settingsPanelId}>
          <fieldset>
            <legend>이동평균선</legend>
            <div className="indicator-options">
              {smaPeriods.map((period) => (
                <label key={period}>
                  <input
                    type="checkbox"
                    checked={settings.sma.includes(period)}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        sma: event.target.checked
                          ? [...current.sma, period].sort((a, b) => a - b)
                          : current.sma.filter((value) => value !== period),
                      }))
                    }
                  />
                  <i style={{ background: smaColors[period] }} />
                  {period}
                  {minute ? '분선' : '일선'}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>거래량·기술적 지표</legend>
            <div className="indicator-options">
              <label>
                <input
                  type="checkbox"
                  checked={settings.volume}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, volume: event.target.checked }))
                  }
                />
                거래량
              </label>
              <label>
                <input
                  type="checkbox"
                  aria-label="RSI"
                  checked={settings.rsi}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, rsi: event.target.checked }))
                  }
                />
                RSI (상대강도지수)
              </label>
              <label className="rsi-period">
                기간
                <select
                  aria-label="RSI 계산 기간"
                  value={settings.rsiPeriod}
                  disabled={!settings.rsi}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      rsiPeriod: Number(event.target.value),
                    }))
                  }
                >
                  {rsiPeriods.map((period) => (
                    <option key={period} value={period}>
                      {period}봉
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
          <div className="indicator-settings__footer">
            <small>설정은 이 브라우저에 저장됩니다.</small>
            <button type="button" onClick={() => setSettings(defaultChartSettings())}>
              기본값 복원
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
