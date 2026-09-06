import { parseNewsMarkdown } from '@orsem/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import {
  editInput,
  readNewsEditDraft,
  removeNewsEditDraft,
  saveNewsEditDraft,
} from '../lib/news-edit-drafts';
import { formatKst } from '../lib/format';
import type { NewsTranslationEdit, NewsTranslationEditInput } from '../types';
import { NewsContentBlocks } from './news-content-blocks';
import { Button, ErrorState, Input, LoadingState } from './ui';
import './news-translation-editor.css';

const refreshPrefixes = new Set([
  'news',
  'news-detail',
  'search',
  'dashboard',
  'company',
  'event',
  'events',
]);

export function NewsTranslationEditor({
  articleId,
  userId,
  reviewRequired = false,
  onClose,
  onSaved,
}: {
  articleId: string;
  userId: string;
  reviewRequired?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const edit = useQuery({
    queryKey: ['news-translation-edit', userId, articleId],
    queryFn: ({ signal }) => api.newsTranslationEdit(articleId, signal),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <section className="translation-editor" aria-label="번역 수정">
      <header className="translation-editor__heading">
        <h2>번역 수정</h2>
        <span>관리자</span>
      </header>
      {edit.isPending ? <LoadingState label="수정할 번역과 원문을 불러오는 중입니다." /> : null}
      {edit.isError ? (
        <>
          <ErrorState
            message="이 기사의 번역을 수정할 수 없습니다. 권한과 본문 상태를 확인해 주세요."
            onRetry={() => void edit.refetch()}
          />
          <Button type="button" variant="secondary" onClick={onClose}>
            닫기
          </Button>
        </>
      ) : null}
      {edit.data ? (
        <TranslationForm
          key={edit.data.sourceItemId}
          userId={userId}
          data={edit.data}
          reviewRequired={reviewRequired}
          onClose={onClose}
          onSaved={onSaved}
          reload={async () => {
            const result = await edit.refetch();
            if (!result.data || result.isError) throw new Error('최신 번역을 불러오지 못했습니다.');
            return result.data;
          }}
        />
      ) : null}
    </section>
  );
}

function TranslationForm({
  userId,
  data,
  reviewRequired,
  onClose,
  onSaved,
  reload,
}: {
  userId: string;
  data: NewsTranslationEdit;
  reviewRequired: boolean;
  onClose: () => void;
  onSaved: () => void;
  reload: () => Promise<NewsTranslationEdit>;
}) {
  const queryClient = useQueryClient();
  const [initialDraft] = useState(() => readNewsEditDraft(userId, data.sourceItemId));
  const [input, setInput] = useState<NewsTranslationEditInput>(
    () => initialDraft ?? editInput(data),
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);
  const [restored, setRestored] = useState(Boolean(initialDraft));
  const [reloading, setReloading] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dirty =
    input.revision !== data.revision ||
    input.title !== data.translation.title ||
    input.description !== data.translation.description ||
    input.markdown !== data.translation.markdown;
  const deferredMarkdown = useDeferredValue(input.markdown);
  const preview = useMemo(() => {
    try {
      return { blocks: parseNewsMarkdown(deferredMarkdown), error: null };
    } catch (error) {
      return {
        blocks: [],
        error: error instanceof Error ? error.message : 'Markdown 내용을 확인해 주세요.',
      };
    }
  }, [deferredMarkdown]);
  const original = useMemo(() => {
    try {
      return parseNewsMarkdown(data.original.markdown);
    } catch {
      return null;
    }
  }, [data.original.markdown]);
  const save = useMutation({
    gcTime: 0,
    mutationFn: (payload: NewsTranslationEditInput) =>
      api.saveNewsTranslation(data.sourceItemId, payload),
    onSuccess: () => {
      removeNewsEditDraft(userId, data.sourceItemId);
      onSaved();
      void queryClient.invalidateQueries({
        predicate: (query) => refreshPrefixes.has(String(query.queryKey[0])),
      });
    },
  });
  const conflict =
    input.revision !== data.revision ||
    (save.error && 'statusCode' in save.error && save.error.statusCode === 409);
  useEffect(() => {
    if (dirty) setStorageFailed(!saveNewsEditDraft(userId, data.sourceItemId, input));
    else removeNewsEditDraft(userId, data.sourceItemId);
  }, [dirty, input, userId, data.sourceItemId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const change = (field: 'title' | 'description' | 'markdown', value: string) => {
    setInput((current) => ({
      ...current,
      [field]: field === 'description' ? value || null : value,
    }));
    setLocalError(null);
  };
  function cancel() {
    if (dirty && !window.confirm('수정 중인 번역을 버리고 닫을까요?')) return;
    removeNewsEditDraft(userId, data.sourceItemId);
    onClose();
  }
  async function loadLatest() {
    if (dirty && !window.confirm('현재 입력을 버리고 최신 번역을 불러올까요?')) return;
    setReloading(true);
    try {
      const latest = await reload();
      setInput(editInput(latest));
      setRestored(false);
      save.reset();
      setLocalError(null);
      removeNewsEditDraft(userId, data.sourceItemId);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '최신 번역을 불러오지 못했습니다.');
    } finally {
      setReloading(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending || conflict) return;
    try {
      if (!input.title.trim()) throw new Error('번역 제목을 입력해 주세요.');
      parseNewsMarkdown(input.markdown);
      save.mutate({
        revision: input.revision,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        markdown: input.markdown,
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : '입력 내용을 확인해 주세요.');
    }
  }
  function insert(before: string, after = '', placeholder = '내용') {
    const field = bodyRef.current;
    const start = field?.selectionStart ?? input.markdown.length;
    const end = field?.selectionEnd ?? start;
    const selected = input.markdown.slice(start, end) || placeholder;
    change(
      'markdown',
      input.markdown.slice(0, start) + before + selected + after + input.markdown.slice(end),
    );
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  }
  return (
    <>
      <p className="translation-editor__note">
        원문을 참고하여 번역을 수정합니다. 저장한 내용은 뉴스 목록과 상세 화면에 반영됩니다.
      </p>
      {data.editedAt ? (
        <p className="translation-editor__note">마지막 수정 {formatKst(data.editedAt)}</p>
      ) : null}
      {restored ? (
        <p className="translation-editor__note" role="status">
          이 탭에 보관한 수정 내용을 복원했습니다.
        </p>
      ) : null}
      <div className="translation-editor__columns">
        <details className="translation-editor__original" open>
          <summary>원문 참고</summary>
          <div lang={data.original.language}>
            <h3>{data.original.title}</h3>
            {data.original.description ? <p>{data.original.description}</p> : null}
            {original ? (
              <NewsContentBlocks blocks={original} language={data.original.language} markdown />
            ) : (
              <pre>{data.original.markdown}</pre>
            )}
          </div>
        </details>
        <form className="translation-editor__form" onSubmit={submit}>
          <label>
            번역 제목
            <Input
              value={input.title}
              maxLength={2000}
              required
              onChange={(event) => change('title', event.target.value)}
              disabled={save.isPending}
            />
          </label>
          <label>
            번역 요약
            <textarea
              value={input.description ?? ''}
              maxLength={20000}
              rows={3}
              onChange={(event) => change('description', event.target.value)}
              disabled={save.isPending}
            />
          </label>
          <div className="translation-editor__tabs" role="group" aria-label="본문 편집 방식">
            <Button
              type="button"
              size="sm"
              variant={previewOpen ? 'secondary' : 'primary'}
              aria-pressed={!previewOpen}
              onClick={() => setPreviewOpen(false)}
            >
              Markdown 편집
            </Button>
            <Button
              type="button"
              size="sm"
              variant={previewOpen ? 'primary' : 'secondary'}
              aria-pressed={previewOpen}
              onClick={() => setPreviewOpen(true)}
            >
              미리보기
            </Button>
          </div>
          {previewOpen ? (
            <section className="translation-editor__preview" aria-label="번역 본문 미리보기">
              {preview.error ? (
                <p role="alert">{preview.error}</p>
              ) : (
                <NewsContentBlocks blocks={preview.blocks} language="ko" markdown />
              )}
            </section>
          ) : (
            <>
              <div className="translation-editor__toolbar" role="group" aria-label="Markdown 서식">
                <button type="button" onClick={() => insert('**', '**')} disabled={save.isPending}>
                  굵게
                </button>
                <button type="button" onClick={() => insert('*', '*')} disabled={save.isPending}>
                  기울임
                </button>
                <button
                  type="button"
                  onClick={() => insert('[', '](https://example.com)', '링크 이름')}
                  disabled={save.isPending}
                >
                  링크
                </button>
                <button type="button" onClick={() => insert('`', '`')} disabled={save.isPending}>
                  코드
                </button>
              </div>
              <label>
                번역 본문
                <textarea
                  className="translation-editor__markdown"
                  ref={bodyRef}
                  value={input.markdown}
                  maxLength={100000}
                  rows={18}
                  onChange={(event) => change('markdown', event.target.value)}
                  disabled={save.isPending}
                  aria-describedby="translation-markdown-help"
                />
              </label>
              <p id="translation-markdown-help" className="translation-editor__note">
                제목(##), 목록(- 또는 1.), 인용(&gt;), 굵게, 기울임, 링크, 인라인 코드를 사용할 수
                있습니다. HTML과 이미지는 지원하지 않습니다.
              </p>
            </>
          )}
          {conflict ? (
            <div className="translation-editor__error" role="alert">
              원문이나 번역이 다른 곳에서 변경되었습니다. 현재 입력은 보관되어 있으며, 저장하려면
              최신 번역을 다시 확인해 주세요.
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void loadLatest()}
                disabled={reloading}
              >
                {reloading ? '불러오는 중…' : '최신 번역 불러오기'}
              </Button>
            </div>
          ) : null}
          {localError || (save.isError && !conflict) ? (
            <p className="translation-editor__error" role="alert">
              {localError ??
                (save.error instanceof ApiError && save.error.statusCode === 400
                  ? save.error.message
                  : '저장하지 못했습니다. 입력 내용은 유지됩니다. 권한과 연결을 확인한 뒤 다시 시도해 주세요.')}
            </p>
          ) : null}
          {storageFailed ? (
            <p className="translation-editor__error" role="status">
              이 브라우저에서는 임시 보관이 불가능합니다. 화면을 떠나기 전에 저장해 주세요.
            </p>
          ) : (
            <p className="translation-editor__note">
              수정 중인 내용은 이 탭에 30분 동안 임시 보관됩니다.
            </p>
          )}
          <div className="translation-editor__actions">
            <Button
              type="submit"
              disabled={(!dirty && !reviewRequired) || save.isPending || conflict || reloading}
            >
              {save.isPending ? '저장 중…' : '번역 저장'}
            </Button>
            <Button type="button" variant="secondary" onClick={cancel} disabled={save.isPending}>
              취소
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
