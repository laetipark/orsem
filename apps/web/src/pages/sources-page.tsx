import { ExternalLink, Image } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { ConnectorFreshness } from '../components/connector-freshness';
import { Card, CardContent, CardHeader } from '../components/ui';
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
              <p>
                종목 로고는 Logo.dev와 선택적으로 연결한 Brandfetch에서 표시하며, 개별 출처와 이용
                조건을 검수한 로컬 로고를 우선할 수 있습니다. 로고를 불러오지 못하면 종목명·코드로
                만든 아이콘을 표시합니다.
              </p>
            </div>
            <Link to="/logo-sources">
              로고 출처·이용 안내 <ExternalLink size={15} aria-hidden="true" />
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
