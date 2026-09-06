import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NewsContentBlocks } from './news-content-blocks';

it('renders manual inline Markdown as safe React nodes and honors escaped source punctuation', () => {
  const { container } = render(
    <NewsContentBlocks
      language="ko"
      markdown
      blocks={[
        {
          type: 'PARAGRAPH',
          text: '**굵게** *기울임* `코드` [출처](https://example.com/report) \\*원문\\* <img src=x onerror=alert(1)> [위험](javascript:alert(1))',
        },
      ]}
    />,
  );
  expect(container.querySelector('strong')).toHaveTextContent('굵게');
  expect(container.querySelector('em')).toHaveTextContent('기울임');
  expect(container.querySelector('code')).toHaveTextContent('코드');
  expect(screen.getByRole('link', { name: '출처' })).toHaveAttribute(
    'href',
    'https://example.com/report',
  );
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(container).toHaveTextContent('*원문*');
  expect(container.querySelector('img, script')).toBeNull();
});
it('does not interpret inline markup in original or automatic translation blocks', () => {
  const { container } = render(
    <NewsContentBlocks
      language="en"
      blocks={[{ type: 'PARAGRAPH', text: '**literal** [link](https://example.com)' }]}
    />,
  );
  expect(container.querySelector('strong, a')).toBeNull();
  expect(container).toHaveTextContent('**literal**');
});
