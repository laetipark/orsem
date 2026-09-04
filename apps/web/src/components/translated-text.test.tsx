import { fireEvent, render, screen } from '@testing-library/react';
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
  it('한국어 제목·요약을 우선 표시하면서 원문과 자동 번역 표시를 유지한다', () => {
    const { container } = render(
      <a href="https://example.test/news">
        <TranslatedText title={title} description={description} translation={translation} />
      </a>,
    );
    expect(screen.getByText(translation.title)).toHaveAttribute('lang', 'ko');
    expect(screen.getByText(translation.description!)).toBeVisible();
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText(description)).toBeVisible();
    expect(screen.getByText('자동 번역')).toBeVisible();
    expect(container.querySelector('a button, a summary, a details, a a')).toBeNull();
    expect(screen.queryByText(translation.model)).not.toBeInTheDocument();
  });

  it('번역 요약이 없으면 기존 요약을 보존한다', () => {
    render(
      <TranslatedText
        title={title}
        description={description}
        translation={{ ...translation, description: null }}
      />,
    );
    expect(screen.getByText(description)).toBeVisible();
    expect(screen.getAllByText(title)).toHaveLength(1);
    expect(screen.queryByText(translation.description!)).not.toBeInTheDocument();
  });

  it('제목을 재사용한 요약은 원문에 한 번만 표시한다', () => {
    render(
      <TranslatedText
        title={title}
        description={title}
        translation={{ ...translation, description: null }}
      />,
    );
    expect(screen.getAllByText(title)).toHaveLength(1);
  });

  it('번역이 없거나 실패한 응답에서는 기존 제목·요약만 표시한다', () => {
    render(<TranslatedText title={title} description={description} translation={null} />);
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText(description)).toBeVisible();
    expect(screen.queryByText('자동 번역')).not.toBeInTheDocument();
    expect(screen.queryByText('원문')).not.toBeInTheDocument();
  });

  it('원래 요약이 제공되지 않은 검색 결과에는 번역 요약을 임의로 추가하지 않는다', () => {
    render(<TranslatedText title={title} translation={translation} />);
    expect(screen.getByText(translation.title)).toBeVisible();
    expect(screen.queryByText(translation.description!)).not.toBeInTheDocument();
  });

  it('상세 화면에서는 원문 제목·요약을 접고 펼칠 수 있다', () => {
    const { container } = render(
      <TranslatedText
        title={title}
        description={description}
        translation={translation}
        heading="h2"
        original="disclosure"
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: translation.title })).toBeVisible();
    expect(screen.getByText(title)).not.toBeVisible();
    fireEvent.click(screen.getByText('원문 보기'));
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText(description)).toBeVisible();
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
