import { Shield } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandLogo } from './brand-logo';
import { ThemeButton } from './app-shell';

export function LoginLayout({
  title,
  description,
  eyebrow = 'PRIVATE OBSERVATORY',
  children,
}: {
  title: string;
  description: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <main className="login-page">
      <div className="login-topbar">
        <div className="brand brand--login">
          <BrandLogo size="large" />
        </div>
        <ThemeButton />
      </div>
      <section className="login-panel">
        <div className="login-panel__intro">
          <span className="login-icon">
            <Shield size={22} aria-hidden="true" />
          </span>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {children}
      </section>
    </main>
  );
}
