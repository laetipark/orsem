import assert from 'node:assert/strict';
import test from 'node:test';
import { newsBlocksToMarkdown, parseNewsMarkdown } from './news-markdown';

test('Markdown retains inline formatting as text within supported article block types', () => {
  assert.deepEqual(
    parseNewsMarkdown(
      '## 새 제목\n\n문단 **강조** *기울임* [링크](https://example.com) `값`\n\n- 하나\n- 둘\n\n1. 셋\n2. 넷\n\n> 인용\n> 두 줄',
    ),
    [
      { type: 'HEADING', level: 2, text: '새 제목' },
      { type: 'PARAGRAPH', text: '문단 **강조** *기울임* [링크](https://example.com) `값`' },
      { type: 'LIST', ordered: false, items: ['하나', '둘'] },
      { type: 'LIST', ordered: true, items: ['셋', '넷'] },
      { type: 'QUOTE', text: '인용\n두 줄' },
    ],
  );
});

test('Markdown rejects unsupported executable, embedded, and oversized content', () => {
  for (const markdown of [
    '',
    ' ',
    '<script>alert(1)</script>',
    '<img src=x onerror=x>',
    '![image](https://example.com/a.png)',
    '```js\nalert(1)\n```',
    '[bad](javascript:alert)',
    '[bad](data:text/plain,test)',
    '[bad](//example.com)',
    '[bad](https://user:password@example.com)',
    '# Heading',
    '- Parent\n  - Nested',
    'x'.repeat(100_001),
  ]) {
    assert.throws(() => parseNewsMarkdown(markdown), Error, markdown.slice(0, 50));
  }
});

test('original plain text gets escaped rather than acquiring new inline meaning', () => {
  const markdown = newsBlocksToMarkdown([
    { type: 'PARAGRAPH', text: '**literal** [not a link] `code`\n## not a heading' },
    { type: 'HEADING', level: 3, text: 'Heading' },
    { type: 'LIST', ordered: true, items: ['First', 'Second\nContinuation'] },
  ]);
  assert.match(markdown, /\\\*\\\*literal/u);
  assert.match(markdown, /\\## not a heading/u);
  const blocks = parseNewsMarkdown(markdown);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]?.type, 'PARAGRAPH');
  assert.deepEqual(blocks[2], {
    type: 'LIST',
    ordered: true,
    items: ['First', 'Second\nContinuation'],
  });
});
