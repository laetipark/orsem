import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CompanySummary } from '../types';
import { useCompanyLogo, logoResourceKey } from '../lib/use-company-logo';
import { api } from '../lib/api';
import type { LogoCandidate } from '../lib/company-branding';
import { logoRecentlyFailed, recordLogoFailure, subscribeLogoFailures } from '../lib/logo-failures';
import { cn } from './ui';
import './company-avatar.css';

type Props = {
  company: Pick<CompanySummary, 'nameKo' | 'stockCode' | 'ticker' | 'market'> & { id?: string };
  className?: string;
};

export const CompanyAvatar = memo(
  function CompanyAvatar(props: Props) {
    // Changing security resets load attempts. Ordinary price/name updates do not.
    return <CompanyLogoImage key={logoResourceKey(props.company)} {...props} />;
  },
  (previous, next) =>
    previous.className === next.className &&
    previous.company.id === next.company.id &&
    previous.company.market === next.company.market &&
    previous.company.stockCode === next.company.stockCode &&
    previous.company.ticker === next.company.ticker &&
    previous.company.nameKo === next.company.nameKo,
);

function CompanyLogoImage({ company, className }: Props) {
  const { ref, candidates, companyId, visible } = useCompanyLogo(company);
  const attempts = useRef(0);
  const permits = useRef(new Map<string, Promise<{ allowed: boolean }>>());
  const issued = useRef(new Set<string>());
  const skipped = useRef(new Set<string>());
  const selectedCandidates = useRef<LogoCandidate[] | null>(null);
  const [active, setActive] = useState<LogoCandidate | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const activeFailed = useSyncExternalStore(subscribeLogoFailures, () =>
    Boolean(active && loadedUrl !== active.url && logoRecentlyFailed(active.url)),
  );
  const activeCurrent = active && candidates.find((candidate) => candidate.url === active.url);
  const activePreferred =
    activeCurrent &&
    ((loadedUrl === active.url && selectedCandidates.current === candidates) ||
      !candidates
        .slice(
          0,
          candidates.findIndex((candidate) => candidate.url === active?.url),
        )
        .some(
          (candidate) =>
            !skipped.current.has(candidate.url) &&
            !logoRecentlyFailed(candidate.url) &&
            (!candidate.provider ||
              (!issued.current.has(candidate.url) &&
                (permits.current.has(candidate.url) || attempts.current < 2))),
        ));
  useEffect(() => {
    if (!visible || (active && activePreferred && !activeFailed)) return;
    let cancelled = false;
    void (async () => {
      for (const candidate of candidates) {
        if (cancelled) return;
        if (skipped.current.has(candidate.url) || logoRecentlyFailed(candidate.url)) continue;
        if (candidate.provider) {
          if (issued.current.has(candidate.url) && candidate.url !== active?.url) continue;
          if (!companyId) continue;
          let permit = permits.current.get(candidate.url);
          if (!permit) {
            if (attempts.current >= 2) continue;
            attempts.current += 1;
            permit = api
              .companyLogoPermit(companyId, candidate.provider, AbortSignal.timeout(8_000))
              .catch(() => ({ allowed: false }));
            permits.current.set(candidate.url, permit);
          }
          const permission = await permit;
          if (cancelled) return;
          if (!permission.allowed) {
            skipped.current.add(candidate.url);
            continue;
          }
          if (logoRecentlyFailed(candidate.url)) continue;
        }
        if (!cancelled) {
          if (candidate.provider) issued.current.add(candidate.url);
          selectedCandidates.current = candidates;
          setActive(candidate);
        }
        return;
      }
      if (!cancelled) setActive(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [candidates, companyId, visible, active, activePreferred, activeFailed]);
  const showImage = active && activeCurrent && !activeFailed;
  useEffect(() => {
    if (!visible || !showImage || loadedUrl === active.url) return;
    // A stalled image also falls back; the HTTP cause remains unknown.
    const timer = setTimeout(() => {
      skipped.current.add(active.url);
      recordLogoFailure(active.url);
      setActive(null);
    }, 20_000);
    return () => clearTimeout(timer);
  }, [visible, showImage, active, loadedUrl]);
  const letters =
    Array.from((company.ticker || company.nameKo).replace(/[^\p{L}\p{N}]/gu, ''))
      .slice(0, 2)
      .join('') || '?';
  return (
    <span
      ref={ref}
      className={cn('company-avatar', showImage && 'company-avatar--image', className)}
      aria-hidden="true"
      data-logo-role={showImage ? activeCurrent.logoRole : 'fallback'}
      data-review-status={showImage ? activeCurrent.reviewStatus : undefined}
      data-load-state={showImage ? (loadedUrl === active.url ? 'loaded' : 'loading') : 'fallback'}
      title={
        showImage && activeCurrent.logoRole === 'issuer'
          ? '운용사 로고 · 상품명과 종목코드를 함께 확인하세요'
          : undefined
      }
    >
      {showImage ? (
        <>
          <img
            key={active.url}
            src={active.url}
            alt=""
            width="128"
            height="128"
            loading="lazy"
            decoding="async"
            referrerPolicy="origin"
            onLoad={() => setLoadedUrl(active.url)}
            onError={() => {
              skipped.current.add(active.url);
              recordLogoFailure(active.url);
              setLoadedUrl(null);
              setActive(null);
            }}
          />
          {activeCurrent.logoRole === 'issuer' ? (
            <span className="company-avatar__issuer">운용</span>
          ) : null}
        </>
      ) : (
        <span>{letters}</span>
      )}
    </span>
  );
}
