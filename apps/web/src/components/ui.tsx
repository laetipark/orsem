import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';
import './loading-state.css';

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'icon';
};

export function Button({ className, variant = 'primary', size = 'md', ...props }: ButtonProps) {
  return (
    <button
      className={cn('button', `button--${variant}`, `button--${size}`, className)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('select', className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section className={cn('card', className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <header className={cn('card__header', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('card__content', className)} {...props} />;
}

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'teal' | 'orange' | 'red' | 'blue' | 'violet';
}) {
  return <span className={cn('badge', `badge--${tone}`, className)} {...props} />;
}

export function Progress({ value, label }: { value: number; label: string }) {
  const safeValue = Math.min(100, Math.max(0, value));
  return (
    <div
      className="progress"
      aria-label={label}
      aria-valuenow={safeValue}
      aria-valuemin={0}
      aria-valuemax={100}
      role="progressbar"
    >
      <span style={{ width: `${safeValue}%` }} />
    </div>
  );
}

export function LoadingState({ label = '데이터를 불러오는 중입니다.' }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite" aria-busy="true">
      <LoadingCaption label={label} />
      <div className="loading-state__rows" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div className="loading-state__row" key={row}>
            <span className="loading-block loading-state__avatar" />
            <div className="loading-state__lines">
              <span className="loading-block loading-block--title" />
              <span className="loading-block loading-block--detail" />
            </div>
            <span className="loading-block loading-state__tag" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ChartLoadingSkeleton({
  label = '차트 데이터를 불러오는 중입니다.',
}: {
  label?: string;
}) {
  return (
    <div className="loading-chart" role="status" aria-live="polite" aria-busy="true">
      <ChartLoadingFrame />
      <LoadingCaption label={label} />
    </div>
  );
}

export function CompanyPageSkeleton({
  label = '기업 관측 정보를 불러오는 중입니다.',
}: {
  label?: string;
}) {
  return (
    <div className="loading-company" role="status" aria-live="polite" aria-busy="true">
      <LoadingCaption label={label} />
      <div className="loading-company__heading" aria-hidden="true">
        <span className="loading-block loading-company__logo" />
        <div className="loading-state__lines">
          <span className="loading-block loading-block--heading" />
          <span className="loading-block loading-block--detail" />
          <div className="loading-state__chips">
            <span className="loading-block loading-state__tag" />
            <span className="loading-block loading-state__tag" />
          </div>
        </div>
        <span className="loading-block loading-company__action" />
      </div>
      <div className="loading-company__card" aria-hidden="true">
        <div className="loading-company__toolbar">
          <div className="loading-state__lines">
            <span className="loading-block loading-block--eyebrow" />
            <span className="loading-block loading-block--heading" />
          </div>
          <div className="loading-state__chips">
            <span className="loading-block loading-company__control" />
            <span className="loading-block loading-company__control" />
          </div>
        </div>
        <div className="loading-company__content">
          <div className="loading-company__quote">
            <span className="loading-block loading-company__price" />
            <span className="loading-block loading-block--detail" />
          </div>
          <div className="loading-company__legend">
            {[0, 1, 2, 3, 4].map((item) => (
              <div className="loading-state__lines" key={item}>
                <span className="loading-block loading-block--eyebrow" />
                <span className="loading-block loading-block--value" />
              </div>
            ))}
          </div>
          <ChartLoadingFrame />
        </div>
      </div>
    </div>
  );
}

function LoadingCaption({ label }: { label: string }) {
  return (
    <p className="loading-caption">
      <span className="loading-caption__dot" aria-hidden="true" />
      {label}
    </p>
  );
}

function ChartLoadingFrame() {
  return (
    <div className="loading-chart__frame" aria-hidden="true">
      <div className="loading-chart__grid" />
      <div className="loading-chart__symbol">
        <span className="loading-block" />
        <span className="loading-block" />
        <span className="loading-block" />
      </div>
      <div className="loading-chart__baseline">
        <span className="loading-block" />
        <span className="loading-block" />
        <span className="loading-block" />
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="page-state page-state--error" role="alert">
      <AlertTriangle size={22} aria-hidden="true" />
      <div>
        <strong>데이터를 불러오지 못했습니다.</strong>
        <p>{message || '잠시 후 다시 시도해 주세요.'}</p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          다시 시도
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <Inbox size={23} aria-hidden="true" />
      </span>
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}
