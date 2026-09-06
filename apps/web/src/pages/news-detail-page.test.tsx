import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { parseNewsMarkdown } from '@orsem/contracts';
import type { NewsDetail, NewsTranslationEdit } from '../types';
import { NewsDetailPage } from './news-detail-page';

const detail: NewsDetail = {
  id: 'source-1',
  articleId: 'article-1',
  sourceCount: 1,
  contentState: 'AVAILABLE',
  contentSourceId: 'source-1',
  contentLanguage: 'en',
  translated: true,
  sourceKind: 'COMPANY_IR',
  publisherId: 'samsung-global-newsroom',
  marketRegion: 'global',
  source: 'IR',
  externalId: 'release-1',
  url: 'https://news.samsung.com/global/example',
  title: 'Samsung shares a business update',
  description: 'Original summary',
  translation: {
    language: 'ko',
    title: '삼성전자, 사업 현황 발표',
    description: '번역 요약',
    translatedAt: '2026-09-05T00:04:00.000Z',
    provider: 'LOCAL',
    model: 'fixture-model',
  },
  sourceName: 'Samsung Global Newsroom',
  author: 'Samsung Newsroom',
  publishedAt: '2026-09-05T00:00:00.000Z',
  firstObservedAt: '2026-09-05T00:02:00.000Z',
  processedAt: '2026-09-05T00:03:00.000Z',
  rightsMode: 'PRIVATE_DISPLAY_ONLY',
  provenanceUrl: 'https://news.samsung.com/global/example',
  tickers: ['005930'],
  tags: ['IR'],
  content: {
    sourceItemId: 'source-1',
    original: {
      language: 'en',
      blocks: [
        { type: 'HEADING', level: 2, text: 'Original section' },
        { type: 'PARAGRAPH', text: 'Original English body.' },
      ],
      fetchedAt: '2026-09-05T00:03:00.000Z',
    },
    translation: {
      language: 'ko',
      blocks: [
        { type: 'HEADING', level: 2, text: '번역 문단' },
        { type: 'PARAGRAPH', text: '한국어로 번역한 본문입니다.' },
      ],
      translatedAt: '2026-09-05T00:04:00.000Z',
      provider: 'LOCAL',
      model: 'fixture-model',
    },
  },
};

const clients: QueryClient[] = [];
beforeEach(() => {
  vi.stubEnv('VITE_NEWS_TRANSLATION_EDITOR_ENABLED', 'true');
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  sessionStorage.clear();
});
function show(role: 'ADMIN' | 'VIEWER' = 'VIEWER') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/news/article-1']}>
        <Link to="/news/article-2">다음 기사</Link>
        <Link to="/news/article-1">첫 기사</Link>
        <Routes>
          <Route element={<Outlet context={{ user: { id: 'test-admin', role } }} />}>
            <Route path="/news/:id" element={<NewsDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('news detail page', () => {
  it('keeps the pending editor unavailable until its backend is enabled', async () => {
    vi.stubEnv('VITE_NEWS_TRANSLATION_EDITOR_ENABLED', 'false');
    vi.spyOn(api, 'newsDetail').mockResolvedValue(detail);
    const editor = vi.spyOn(api, 'newsTranslationEdit');
    show('ADMIN');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: '번역 수정' })).not.toBeInTheDocument();
    expect(editor).not.toHaveBeenCalled();
  });

  it('switches title, summary and body together and only mounts the selected language', async () => {
    vi.spyOn(api, 'newsDetail').mockResolvedValue(detail);
    const { container } = show();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      '삼성전자, 사업 현황 발표',
    );
    expect(screen.getByText('한국어로 번역한 본문입니다.')).toBeVisible();
    expect(screen.getByRole('link', { name: /원문 사이트/ })).toHaveAttribute('href', detail.url);
    expect(screen.getByText(/발행.*KST/)).toBeVisible();
    expect(screen.getByText('번역 요약')).toBeVisible();
    expect(screen.queryByText(detail.title)).not.toBeInTheDocument();
    expect(screen.queryByText('Original summary')).not.toBeInTheDocument();
    expect(screen.queryByText('Original English body.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '번역' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '원문' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(detail.title);
    expect(screen.getByText('Original summary')).toBeVisible();
    expect(screen.getByText('Original English body.')).toBeVisible();
    expect(screen.queryByText('번역 요약')).not.toBeInTheDocument();
    expect(screen.queryByText('한국어로 번역한 본문입니다.')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.news-detail__body')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '번역' }));
    expect(screen.getByText('한국어로 번역한 본문입니다.')).toBeVisible();
    expect(screen.queryByText('Original English body.')).not.toBeInTheDocument();
    expect(screen.getByText('기업 IR')).toBeVisible();
    expect(screen.queryByText(/본문 출처 ID/)).not.toBeInTheDocument();
    expect(api.newsDetail).toHaveBeenCalledWith('article-1', expect.any(AbortSignal));
  });
  it('resets to translation when another article opens and when returning to the first article', async () => {
    vi.spyOn(api, 'newsDetail').mockImplementation(async (id) => ({
      ...detail,
      articleId: id,
      title: `Original ${id}`,
      translation: { ...detail.translation!, title: `번역 ${id}` },
    }));
    show();
    await screen.findByRole('heading', { level: 1, name: '번역 article-1' });
    fireEvent.click(screen.getByRole('button', { name: '원문' }));
    fireEvent.click(screen.getByRole('link', { name: '다음 기사' }));
    expect(await screen.findByRole('heading', { level: 1, name: '번역 article-2' })).toBeVisible();
    fireEvent.click(screen.getByRole('link', { name: '첫 기사' }));
    expect(await screen.findByRole('heading', { level: 1, name: '번역 article-1' })).toBeVisible();
  });

  it('omits an untranslated summary instead of mixing languages', async () => {
    vi.spyOn(api, 'newsDetail').mockResolvedValue({
      ...detail,
      translation: { ...detail.translation!, description: null },
    });
    show();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Original summary')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '원문' }));
    expect(screen.getByText('Original summary')).toBeVisible();
  });

  it('does not offer a language switch for Korean originals', async () => {
    vi.spyOn(api, 'newsDetail').mockResolvedValue({
      ...detail,
      title: '한국어 원문 제목',
      description: '한국어 원문 요약',
      contentLanguage: 'ko',
      translation: null,
      content: {
        ...detail.content!,
        original: {
          ...detail.content!.original,
          language: 'ko',
          blocks: [{ type: 'PARAGRAPH', text: '한국어 원문 본문' }],
        },
        translation: null,
      },
    });
    show();
    expect(
      await screen.findByRole('heading', { level: 1, name: '한국어 원문 제목' }),
    ).toBeVisible();
    expect(screen.getByText('한국어 원문 본문')).toBeVisible();
    expect(screen.queryByRole('group', { name: '기사 언어' })).not.toBeInTheDocument();
  });
});

const editable: NewsTranslationEdit = {
  sourceItemId: detail.id,
  revision: 'a'.repeat(64),
  original: {
    title: detail.title,
    description: detail.description!,
    language: 'en',
    markdown: '## Original section\n\nOriginal English body.',
  },
  translation: {
    title: detail.translation!.title,
    description: detail.translation!.description,
    markdown: '## 번역 문단\n\n한국어로 번역한 본문입니다.',
  },
  editedAt: null,
  editedByAdminId: null,
};

async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: '번역 수정' }));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

it('only exposes the translation editor to an administrator', async () => {
  vi.spyOn(api, 'newsDetail').mockResolvedValue(detail);
  const editor = vi.spyOn(api, 'newsTranslationEdit').mockResolvedValue(editable);
  show('VIEWER');
  await screen.findByRole('heading', { level: 1 });
  expect(screen.queryByRole('button', { name: '번역 수정' })).not.toBeInTheDocument();
  expect(editor).not.toHaveBeenCalled();
});

it('lets an administrator review a stale article by route ID and save against its resolved source', async () => {
  vi.spyOn(api, 'newsDetail')
    .mockRejectedValueOnce(
      new ApiError(404, 'NOT_FOUND', '표시할 수 있는 뉴스 본문을 찾을 수 없습니다.'),
    )
    .mockResolvedValue(detail);
  const getEditor = vi.spyOn(api, 'newsTranslationEdit').mockResolvedValue(editable);
  const save = vi.spyOn(api, 'saveNewsTranslation').mockResolvedValue({
    ...editable,
    revision: 'b'.repeat(64),
  });
  show('ADMIN');
  fireEvent.click(await screen.findByRole('button', { name: '원문 확인·번역 수정' }));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(await screen.findByRole('textbox', { name: '번역 제목' })).toHaveValue(
    editable.translation.title,
  );
  expect(screen.getByText('Original English body.')).toBeVisible();
  expect(getEditor).toHaveBeenCalledWith('article-1', expect.any(AbortSignal));
  // Reviewing an updated original can confirm that the existing translation is still correct.
  expect(screen.getByRole('button', { name: '번역 저장' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '번역 저장' }));
  await screen.findByRole('heading', { level: 1, name: detail.translation!.title });
  expect(save).toHaveBeenCalledWith('source-1', {
    revision: editable.revision,
    ...editable.translation,
  });
  expect(screen.getByText('번역을 저장했습니다.')).toBeVisible();
});

it('keeps stale original content and recovery actions unavailable to viewers', async () => {
  vi.spyOn(api, 'newsDetail').mockRejectedValue(
    new ApiError(404, 'NOT_FOUND', '본문을 찾을 수 없습니다.'),
  );
  const getEditor = vi.spyOn(api, 'newsTranslationEdit');
  show('VIEWER');
  await screen.findByText('본문을 찾을 수 없습니다.');
  expect(screen.queryByRole('button', { name: '원문 확인·번역 수정' })).not.toBeInTheDocument();
  expect(screen.queryByText('Original English body.')).not.toBeInTheDocument();
  expect(getEditor).not.toHaveBeenCalled();
});

it.each([403, 500])('does not offer recovery for an administrator on HTTP %s', async (status) => {
  vi.spyOn(api, 'newsDetail').mockRejectedValue(
    new ApiError(status, 'ERROR', '조회에 실패했습니다.'),
  );
  const getEditor = vi.spyOn(api, 'newsTranslationEdit');
  show('ADMIN');
  await screen.findByText('조회에 실패했습니다.');
  expect(screen.queryByRole('button', { name: '원문 확인·번역 수정' })).not.toBeInTheDocument();
  expect(getEditor).not.toHaveBeenCalled();
});

it('shows no source content when the protected recovery endpoint rejects the article', async () => {
  vi.spyOn(api, 'newsDetail').mockRejectedValue(
    new ApiError(404, 'NOT_FOUND', '본문을 찾을 수 없습니다.'),
  );
  vi.spyOn(api, 'newsTranslationEdit').mockRejectedValue(
    new ApiError(404, 'NOT_FOUND', '권리 확인 실패'),
  );
  show('ADMIN');
  fireEvent.click(await screen.findByRole('button', { name: '원문 확인·번역 수정' }));
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(
    await screen.findByText(
      '이 기사의 번역을 수정할 수 없습니다. 권한과 본문 상태를 확인해 주세요.',
    ),
  ).toBeVisible();
  expect(screen.queryByRole('textbox', { name: '번역 제목' })).not.toBeInTheDocument();
  expect(screen.queryByText('Original English body.')).not.toBeInTheDocument();
});

it('lets an administrator preview and save Markdown with revision protection and refreshes the article and lists', async () => {
  const markdown = '## 수정된 본문\n\n**주요 내용**과 *설명* [출처](https://example.com)';
  const saved = {
    ...editable,
    revision: 'b'.repeat(64),
    translation: { title: '관리자 수정 제목', description: '수정 요약', markdown },
    editedAt: '2026-09-05T01:00:00Z',
    editedByAdminId: 'test-admin',
  };
  vi.spyOn(api, 'newsDetail')
    .mockResolvedValueOnce(detail)
    .mockResolvedValue({
      ...detail,
      translation: { ...detail.translation!, ...saved.translation, editedAt: saved.editedAt },
      content: {
        ...detail.content!,
        translation: {
          ...detail.content!.translation!,
          blocks: parseNewsMarkdown(markdown),
          format: 'MARKDOWN',
          editedAt: saved.editedAt,
        },
      },
    });
  vi.spyOn(api, 'newsTranslationEdit').mockResolvedValue(editable);
  vi.spyOn(api, 'saveNewsTranslation').mockResolvedValue(saved);
  show('ADMIN');
  clients[0]!.setQueryData(['news', 'list'], { items: [] });
  await openEditor();
  const title = await screen.findByRole('textbox', { name: '번역 제목' });
  expect(screen.getByText('Original English body.')).toBeVisible();
  fireEvent.change(title, { target: { value: saved.translation.title } });
  fireEvent.change(screen.getByRole('textbox', { name: '번역 요약' }), {
    target: { value: saved.translation.description },
  });
  fireEvent.change(screen.getByRole('textbox', { name: '번역 본문' }), {
    target: { value: markdown },
  });
  fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
  const preview = within(screen.getByRole('region', { name: '번역 본문 미리보기' }));
  expect(await preview.findByRole('heading', { name: '수정된 본문' })).toBeVisible();
  expect(preview.getByText('주요 내용').tagName).toBe('STRONG');
  fireEvent.click(screen.getByRole('button', { name: '번역 저장' }));
  expect(
    await screen.findByRole('heading', { level: 1, name: saved.translation.title }),
  ).toBeVisible();
  expect(screen.getByText('번역을 저장했습니다.')).toBeVisible();
  expect(api.saveNewsTranslation).toHaveBeenCalledWith('source-1', {
    revision: editable.revision,
    ...saved.translation,
  });
  expect(clients[0]!.getQueryState(['news', 'list'])?.isInvalidated).toBe(true);
  expect(
    Object.keys(sessionStorage).filter((key) => key.startsWith('orsem-news-edit')),
  ).toHaveLength(0);
});

it('rejects unsafe preview content without issuing a save', async () => {
  vi.spyOn(api, 'newsDetail').mockResolvedValue(detail);
  vi.spyOn(api, 'newsTranslationEdit').mockResolvedValue(editable);
  const save = vi.spyOn(api, 'saveNewsTranslation');
  const { container } = show('ADMIN');
  await openEditor();
  fireEvent.change(await screen.findByRole('textbox', { name: '번역 본문' }), {
    target: { value: '<img src=x onerror=alert(1)>' },
  });
  fireEvent.click(screen.getByRole('button', { name: '번역 저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('HTML');
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('img, script')).toBeNull();
});

it('preserves a conflicting draft across article navigation and requires a fresh revision', async () => {
  vi.spyOn(api, 'newsDetail').mockResolvedValue(detail);
  const fetchEdit = vi.spyOn(api, 'newsTranslationEdit').mockResolvedValue(editable);
  vi.spyOn(api, 'saveNewsTranslation').mockRejectedValue(new ApiError(409, 'CONFLICT', '충돌'));
  show('ADMIN');
  await openEditor();
  fireEvent.change(await screen.findByRole('textbox', { name: '번역 제목' }), {
    target: { value: '보관할 초안' },
  });
  fireEvent.click(screen.getByRole('button', { name: '번역 저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('다른 곳에서 변경');
  expect(screen.getByRole('textbox', { name: '번역 제목' })).toHaveValue('보관할 초안');
  expect(screen.getByRole('button', { name: '번역 저장' })).toBeDisabled();
  fetchEdit.mockResolvedValue({
    ...editable,
    revision: 'b'.repeat(64),
    translation: { ...editable.translation, title: '최신 번역' },
  });
  fireEvent.click(screen.getByRole('link', { name: '다음 기사' }));
  await screen.findByRole('heading', { level: 1 });
  fireEvent.click(screen.getByRole('link', { name: '첫 기사' }));
  expect(await screen.findByRole('textbox', { name: '번역 제목' })).toHaveValue('보관할 초안');
  expect(screen.getByText('이 탭에 보관한 수정 내용을 복원했습니다.')).toBeVisible();
  expect(screen.getByRole('button', { name: '번역 저장' })).toBeDisabled();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  fireEvent.click(screen.getByRole('button', { name: '최신 번역 불러오기' }));
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: '번역 제목' })).toHaveValue('최신 번역'),
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(screen.queryByRole('textbox', { name: '번역 제목' })).not.toBeInTheDocument();
});
