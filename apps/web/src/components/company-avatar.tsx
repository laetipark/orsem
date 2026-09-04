import { useState } from 'react';
import type { CompanySummary } from '../types';
import { companyBrand } from '../lib/company-branding';
import { cn } from './ui';
import './company-avatar.css';

export function CompanyAvatar({
  company,
  className,
}: {
  company: Pick<CompanySummary, 'nameKo' | 'stockCode' | 'ticker' | 'market'>;
  className?: string;
}) {
  const brand = companyBrand(company);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = brand && brand.iconUrl !== failedUrl;
  const letters =
    (company.ticker || company.nameKo).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?';
  return (
    <span
      className={cn('company-avatar', showImage && 'company-avatar--image', className)}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={brand.iconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(brand.iconUrl)}
        />
      ) : (
        <span>{letters}</span>
      )}
    </span>
  );
}
