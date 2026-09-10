import { Share2, X } from 'lucide-react';
import { useState } from 'react';
import { companyPath } from '../lib/company-path';
import type { CompanySummary } from '../types';
import './company-share-button.css';

export function CompanyShareButton({ company }: { company: CompanySummary }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const share = async () => {
    const url = new URL(companyPath(company), window.location.origin).href;
    setBusy(true);
    setMessage('');
    setManualUrl('');
    try {
      if (navigator.share) {
        try {
          await navigator.share({ title: `${company.nameKo} · Orsem`, url });
          return;
        } catch (error) {
          if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
            return;
        }
      }
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(url);
        setMessage('종목 주소를 복사했습니다.');
      } catch {
        setMessage('아래 종목 주소를 선택해 복사해 주세요.');
        setManualUrl(url);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="company-share">
      <button
        type="button"
        className="company-share__button"
        aria-label="종목 주소 공유"
        title="종목 주소 공유"
        disabled={busy}
        onClick={() => void share()}
      >
        <Share2 size={18} aria-hidden="true" />
      </button>
      {message ? (
        <div className="company-share__feedback">
          <span role="status">{message}</span>
          <button
            type="button"
            className="company-share__dismiss"
            aria-label="공유 안내 닫기"
            onClick={() => {
              setMessage('');
              setManualUrl('');
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
          {manualUrl ? (
            <input
              aria-label="공유할 종목 주소"
              value={manualUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
