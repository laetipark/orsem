import { useEffect, useMemo, useRef, useState } from 'react';
import { companyLogoResponseSchema, type CompanyLogoResponse } from '@orsem/contracts';
import { buildLogoCandidates } from './company-branding';
import { api } from './api';
import type { CompanySummary } from '../types';

export type LogoIdentity = Pick<CompanySummary, 'stockCode' | 'ticker' | 'market'> & {
  id?: string;
};
type Entry = {
  response?: CompanyLogoResponse;
  candidateSignature?: string;
  expires: number;
  listeners: Set<() => void>;
  flight?: Promise<void>;
};
const entries = new Map<string, Entry>();
export const LOGO_VISIBLE_DELAY_MS = 150;

export function logoResourceKey(company: LogoIdentity) {
  if (
    !['KRX', 'KOSPI', 'KOSDAQ', 'KONEX', 'NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'BATS'].includes(
      company.market,
    )
  )
    return '';
  const symbol = company.stockCode || company.ticker;
  if (!symbol || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/u.test(symbol)) return '';
  const target =
    company.id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(company.id)
      ? company.id
      : `${company.market}:${symbol}`;
  return `${target}|${company.market}|${symbol}`;
}

async function refresh(key: string, entry: Entry) {
  const previousResponse = entry.response;
  try {
    const data = companyLogoResponseSchema.safeParse(
      await api.companyLogo(key.split('|')[0]!, AbortSignal.timeout(8_000)),
    );
    const [, exchange, symbol] = key.split('|');
    const country = ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(exchange!) ? 'KR' : 'US';
    const metadata = data.success ? data.data.metadata : null;
    const id = key.split('|')[0]!;
    if (
      !data.success ||
      !metadata ||
      metadata.market !== country ||
      metadata.symbol !== symbol ||
      (id.includes(':') ? false : metadata.companyId !== id) ||
      (metadata.exchange !== null &&
        metadata.exchange !== exchange &&
        !(exchange === 'KRX' && ['KOSPI', 'KOSDAQ'].includes(metadata.exchange)))
    )
      throw new Error('Invalid logo identity');
    // Review timestamps can become valid even when the metadata payload is unchanged.
    const candidateSignature = JSON.stringify(buildLogoCandidates(data.data));
    entry.response =
      JSON.stringify(data.data) === JSON.stringify(previousResponse) &&
      candidateSignature === entry.candidateSignature
        ? previousResponse
        : data.data;
    entry.candidateSignature = candidateSignature;
    entry.expires = Date.now() + 300_000;
  } catch {
    entry.response = undefined;
    entry.candidateSignature = undefined;
    entry.expires = Date.now() + 60_000;
  } finally {
    entry.flight = undefined;
    if (entry.response !== previousResponse) entry.listeners.forEach((listener) => listener());
  }
}

/** Metadata cache only: no bytes, prefetch, external fetch, or enrichment polling. */
export function useCompanyLogo(company: LogoIdentity) {
  const key = logoResourceKey(company);
  const ref = useRef<HTMLSpanElement>(null);
  const [, changed] = useState(0);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [foreground, setForeground] = useState(document.visibilityState !== 'hidden');
  useEffect(() => {
    let visibilityTimer: ReturnType<typeof setTimeout> | undefined;
    let intersecting = typeof IntersectionObserver === 'undefined';
    const updateVisibility = () => {
      clearTimeout(visibilityTimer);
      visibilityTimer = undefined;
      if (!intersecting || document.visibilityState === 'hidden') {
        setVisible(false);
      } else if (typeof IntersectionObserver === 'undefined') {
        setVisible(true);
      } else {
        // Skip logos that only flash through the viewport during fast scrolling.
        visibilityTimer = setTimeout(() => setVisible(true), LOGO_VISIBLE_DELAY_MS);
      }
    };
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((rows) => {
            intersecting = rows.some((row) => row.isIntersecting);
            updateVisibility();
          });
    if (ref.current) observer?.observe(ref.current);
    const update = () => {
      setForeground(document.visibilityState !== 'hidden');
      updateVisibility();
    };
    document.addEventListener('visibilitychange', update);
    return () => {
      observer?.disconnect();
      clearTimeout(visibilityTimer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    if (
      !key ||
      !visible ||
      !foreground ||
      (import.meta.env.DEV && import.meta.env.VITE_FIXTURE_MODE === 'true')
    )
      return;
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= 512) {
        const disposable = [...entries].find(([, value]) => !value.listeners.size && !value.flight);
        if (!disposable) return;
        entries.delete(disposable[0]);
      }
      entry = { expires: 0, listeners: new Set() };
      entries.set(key, entry);
    }
    const notify = () => changed((value) => value + 1);
    entry.listeners.add(notify);
    if (entry.expires <= Date.now() && !entry.flight)
      entry.flight = Promise.resolve().then(() => refresh(key, entry));
    return () => {
      entry.listeners.delete(notify);
    };
  }, [key, visible, foreground]);
  const response = entries.get(key)?.response;
  const candidates = useMemo(() => (response ? buildLogoCandidates(response) : []), [response]);
  return {
    ref,
    candidates,
    companyId: response?.metadata.companyId,
    visible: visible && foreground,
    key,
  };
}

export function clearCompanyLogoMetadataCache() {
  entries.clear();
}
