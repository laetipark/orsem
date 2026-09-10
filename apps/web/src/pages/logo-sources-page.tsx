import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BrandLogo } from '../components/brand-logo';
import { LogoAttribution } from '../components/logo-attribution';
import { Card, CardContent, CardHeader } from '../components/ui';
import { api } from '../lib/api';
import './sources-page.css';

export function LogoSourcesPage() {
  const credits = useQuery({
    queryKey: ['company-logo-credits'],
    queryFn: ({ signal }) => api.companyLogoCredits(signal),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return (
    <div className="logo-sources-public">
      <header className="logo-sources-public__header">
        <Link to="/" aria-label="오르셈 홈">
          <BrandLogo />
        </Link>
        <Link to="/login">오르셈 로그인</Link>
      </header>
      <main className="page-stack sources-page" id="main-content">
        <div className="page-lead">
          <h1>로고 출처·이용 안내</h1>
          <p>종목 로고는 기업과 상품을 구별하기 위한 보조 정보입니다.</p>
        </div>
        <Card className="sources-attribution" aria-labelledby="logo-providers-title">
          <CardHeader>
            <h2 id="logo-providers-title">외부 로고 제공자</h2>
          </CardHeader>
          <CardContent className="page-stack">
            <div>
              <h3>Logo.dev</h3>
              <p>
                기본 외부 제공자입니다. 무료 상업용 이용의 출처 표시로 이 공개 안내 페이지에 제공자
                링크를 제공합니다.
              </p>
              <LogoAttribution />
            </div>
            <div>
              <h3>Brandfetch Logo API</h3>
              <p>운영자가 무료 이용 조건을 확인해 연결했을 때 보조 제공자로 사용합니다.</p>
              <a
                href="https://brandfetch.com"
                target="_blank"
                rel="noopener"
                referrerPolicy="origin"
              >
                Brandfetch
              </a>
            </div>
            <p>
              외부 로고는 브라우저에서 직접 불러옵니다. 요청한 종목과 오르셈의 사이트 주소가
              제공자에게 전달될 수 있습니다. 연결이 없거나 이용 한도에 도달하거나 요청이 실패하면
              로컬 로고 또는 자체 아이콘을 표시합니다.
            </p>
          </CardContent>
        </Card>
        <Card className="sources-attribution" aria-labelledby="logo-local-title">
          <CardHeader>
            <h2 id="logo-local-title">로컬 파일과 출처</h2>
          </CardHeader>
          <CardContent className="page-stack">
            <p>
              로컬 파일은 해당 기업·상품과의 연결, 파일별 이용 조건, 원본 출처, 저작자와 필요한 표시
              내용을 함께 검수합니다. 등록된 파일의 출처와 표시 내용은 아래에서 확인할 수 있습니다.
            </p>
            {credits.isPending ? (
              <p role="status">로컬 파일 출처를 확인하고 있습니다.</p>
            ) : credits.isError ? (
              <p role="status">
                로컬 파일 출처 목록을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.
              </p>
            ) : credits.data.items.length === 0 ? (
              <p>현재 공개 출처 목록에 등록된 로컬 종목 로고가 없습니다.</p>
            ) : (
              <ul className="logo-local-credits" aria-label="로컬 로고 출처 목록">
                {credits.data.items.map((credit) => (
                  <li key={`${credit.path}:${credit.sourceUrl}:${credit.attribution}`}>
                    <strong>{credit.path}</strong>
                    <p>{credit.attribution}</p>
                    <p>이용 조건: {credit.license}</p>
                    <a
                      href={credit.sourceUrl}
                      target="_blank"
                      rel="noopener"
                      referrerPolicy="origin"
                    >
                      원본 출처 (
                      {credit.source === 'simple-icons'
                        ? 'Simple Icons'
                        : credit.source === 'wikimedia'
                          ? 'Wikimedia Commons'
                          : '직접 등록'}
                      )
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <div className="sources-attribution__provider">
              <a
                href="https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md"
                target="_blank"
                rel="noopener"
                referrerPolicy="origin"
              >
                Simple Icons 이용 안내
              </a>
              <a
                href="https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia"
                target="_blank"
                rel="noopener"
                referrerPolicy="origin"
              >
                Wikimedia Commons 재사용 안내
              </a>
            </div>
          </CardContent>
        </Card>
        <Card className="sources-attribution" aria-labelledby="logo-identity-title">
          <CardHeader>
            <h2 id="logo-identity-title">종목 구별과 대체 표시</h2>
          </CardHeader>
          <CardContent className="page-stack">
            <p>
              같은 기업의 보통주·우선주와 서로 다른 주식 클래스는 별도 종목입니다. 같은 로고가
              보여도 종목명과 거래소·코드로 확인해 주세요.
            </p>
            <p>
              ETF의 상품 로고가 없으면 검수한 운용사 또는 ETF 브랜드 로고를 사용할 수 있습니다.
              이때도 상품명과 티커를 함께 표시합니다. 운용사 로고는 개별 ETF의 상품 로고와 구분하며,
              편입기업이나 기초지수의 로고로 대체하지 않습니다.
            </p>
            <p>
              로고가 없으면 종목명·티커의 문자와 도형으로 만든 자체 아이콘을 표시합니다. 이미지 연결
              상태와 관계없이 종목명, 가격, 수익률과 차트를 이용할 수 있습니다. 이미지가 열렸다는
              사실만으로 기업·상품의 로고 검수가 완료된 것은 아닙니다.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
