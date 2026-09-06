import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NewsTranslation } from '../types';
import { TranslatedText } from './translated-text';

const translation: NewsTranslation = {
  language: 'ko',
  title: '기업이 사업 현황을 발표했습니다',
  description: '기존 사업에 관한 정기 안내입니다.',
  translatedAt: '2026-09-04T00:00:00.000Z',
  provider: 'LOCAL',
  model: 'test-local-model',
};
const title = 'Company publishes a business update';
const description = 'A regular update on existing business.';

describe('뉴스 자동 번역 표시', () => {
  it('카드는 한국어 제목·요약만 생성하고 원문이나 언어 전환을 생성하지 않는다', () => {
    const { container } = render(
      <a href="https://example.test/news">
        <TranslatedText title={title} description={description} translation={translation} />
      </a>,
    );
    expect(screen.getByText(translation.title)).toHaveAttribute('lang', 'ko');
    expect(screen.getByText(translation.description!)).toBeVisible();
    expect(screen.queryByText(title)).not.toBeInTheDocument();
    expect(screen.queryByText(description)).not.toBeInTheDocument();
    expect(screen.getByText('자동 번역')).toBeVisible();
    expect(container.querySelector('a button, a summary, a details, a a')).toBeNull();
    expect(screen.queryByText(translation.model)).not.toBeInTheDocument();
  });

  it.each([null, '', '  '])(
    '번역 요약이 %s이면 영문 요약으로 대체하지 않는다',
    (translatedDescription) => {
      const { container } = render(
        <TranslatedText
          title={title}
          description={description}
          translation={{ ...translation, description: translatedDescription }}
        />,
      );
      expect(screen.queryByText(description)).not.toBeInTheDocument();
      expect(screen.queryByText(title)).not.toBeInTheDocument();
      expect(container.querySelector('.translated-text__description')).toBeNull();
    },
  );

  it('번역 대상이 아닌 원래 제목·요약은 유지한다', () => {
    render(<TranslatedText title="국내 기업 안내" description="한국어 요약" translation={null} />);
    expect(screen.getByText('국내 기업 안내')).toBeVisible();
    expect(screen.getByText('한국어 요약')).toBeVisible();
    expect(screen.queryByText('자동 번역')).not.toBeInTheDocument();
  });

  it('원래 요약이 제공되지 않은 검색 결과에는 번역 요약을 임의로 추가하지 않는다', () => {
    render(<TranslatedText title={title} translation={translation} />);
    expect(screen.getByText(translation.title)).toBeVisible();
    expect(screen.queryByText(translation.description!)).not.toBeInTheDocument();
  });

  it('번역 결과의 HTML 모양 문자열을 마크업으로 실행하지 않는다', () => {
    const { container } = render(
      <TranslatedText
        title={title}
        translation={{ ...translation, title: '<img src=x onerror=alert(1)>' }}
      />,
    );
    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  });
});
