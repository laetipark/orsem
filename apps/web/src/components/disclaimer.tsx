import { Info } from 'lucide-react';

export function ObservationDisclaimer({ compact = false }: { compact?: boolean }) {
  return (
    <aside className={compact ? 'disclaimer disclaimer--compact' : 'disclaimer'}>
      <Info size={16} aria-hidden="true" />
      <p>
        이 화면은 공시·뉴스의 사실과 출처를 정리하는 관측 도구입니다. 수량 증가는 장내매수를 뜻하지
        않으며, 어떤 항목도 자동 매수·매도 추천으로 사용하지 않습니다.
      </p>
    </aside>
  );
}
