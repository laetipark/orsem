import { ExternalLink, Image } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import { ConnectorFreshness } from '../components/connector-freshness';
import { Card, CardContent, CardHeader } from '../components/ui';
import { logoAttributionUrl } from '../lib/company-branding';
import type { Session } from '../types';
import './sources-page.css';

export function SourcesPage() {
  const session = useOutletContext<Session>();
  return (
    <div className="page-stack sources-page">
      <div className="page-lead">
        <p>데이터 수집 상태와 이용 범위, 기업 로고의 출처를 한곳에서 확인합니다.</p>
      </div>
      <ConnectorFreshness isAdmin={session.user?.role === 'ADMIN'} />
      <Card className="sources-attribution" aria-labelledby="sources-attribution-title">
        <CardHeader>
          <div>
            <span className="section-kicker">ATTRIBUTION</span>
            <h2 id="sources-attribution-title">
              <Image size={19} aria-hidden="true" /> 로고 출처
            </h2>
          </div>
        </CardHeader>
        <CardContent>
          <div className="sources-attribution__provider">
            <div>
              <h3>기업 로고</h3>
              <p>기업 식별을 확인한 로고를 표시하며, 로고가 없는 기업은 이름으로 표시합니다.</p>
            </div>
            <a
              href={logoAttributionUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              기업 로고 제공자 <ExternalLink size={15} aria-hidden="true" />
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
