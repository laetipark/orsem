import orsemMark from '../assets/orsem-mark.svg';
import './brand-logo.css';

export function BrandLogo({ size = 'default' }: { size?: 'default' | 'large' | 'compact' }) {
  return (
    <span className={`brand-logo brand-logo--${size}`} role="img" aria-label="ORSEM">
      <img
        className="brand-logo__mark"
        src={orsemMark}
        width="52"
        height="48"
        alt=""
        aria-hidden="true"
      />
      <strong className="brand-logo__wordmark" aria-hidden="true">
        ORSEM
      </strong>
    </span>
  );
}
