import type { SourceItem } from '@orsem/contracts';

/** Display-only metadata projection. Never substitute a headline for a missing summary. */
export function newsSummaryLine(
  item: Pick<SourceItem, 'title' | 'translation' | 'description' | 'source' | 'rightsMode'>,
  _rewriteAllowed: boolean,
): string {
  void _rewriteAllowed;
  if (item.source.startsWith('NAVER')) return item.description ?? '요약 미제공';
  if (item.rightsMode === 'STORE_METADATA_ONLY') return '요약 미제공';
  return (item.translation?.description ?? item.description)?.trim() || '요약 미제공';
}
