import type { NewsTranslation } from '../types';
import './translated-text.css';

export function TranslatedText({
  title,
  description,
  translation,
  heading = 'strong',
}: {
  title: string;
  description?: string | null;
  translation?: NewsTranslation | null;
  heading?: 'strong' | 'h2';
}) {
  const translated =
    translation?.language === 'ko' && translation.title.trim() ? translation : null;
  const translatedDescription = description && translated?.description?.trim();
  const descriptionText = translated ? translatedDescription : description;
  const showDescription = descriptionText && descriptionText !== (translated?.title ?? title);
  const Wrapper = heading === 'h2' ? 'div' : 'span';
  const HeadingWrapper = heading === 'h2' ? 'div' : 'span';
  const Heading = heading;

  return (
    <Wrapper className="translated-text">
      <HeadingWrapper className="translated-text__heading">
        <Heading className="translated-text__title" lang={translated ? 'ko' : undefined}>
          {translated?.title ?? title}
        </Heading>
        {translated ? (
          <span className="translated-text__badge" title="번역은 원문과 함께 확인해 주세요.">
            {translated.editedAt ? '번역 수정본' : '자동 번역'}
          </span>
        ) : null}
      </HeadingWrapper>
      {showDescription ? (
        <span
          className="translated-text__description"
          lang={translatedDescription ? 'ko' : undefined}
        >
          {descriptionText}
        </span>
      ) : null}
    </Wrapper>
  );
}
