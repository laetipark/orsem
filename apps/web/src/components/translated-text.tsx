import type { NewsTranslation } from '../types';
import './translated-text.css';

export function TranslatedText({
  title,
  description,
  translation,
  heading = 'strong',
  original = 'inline',
}: {
  title: string;
  description?: string | null;
  translation?: NewsTranslation | null;
  heading?: 'strong' | 'h2';
  original?: 'inline' | 'disclosure';
}) {
  const translated =
    translation?.language === 'ko' && translation.title.trim() ? translation : null;
  const translatedDescription = description && translated?.description?.trim();
  const descriptionText = translatedDescription || description;
  const showDescription =
    descriptionText &&
    descriptionText !== (translated?.title ?? title) &&
    !(translated && !translatedDescription && description === title);
  const Wrapper = heading === 'h2' || original === 'disclosure' ? 'div' : 'span';
  const HeadingWrapper = heading === 'h2' ? 'div' : 'span';
  const Heading = heading;
  const originalText = (
    <span className="translated-text__original-copy" lang="en">
      <span>{title}</span>
      {translatedDescription && description !== title ? <span>{description}</span> : null}
    </span>
  );

  return (
    <Wrapper className="translated-text">
      <HeadingWrapper className="translated-text__heading">
        <Heading className="translated-text__title" lang={translated ? 'ko' : undefined}>
          {translated?.title ?? title}
        </Heading>
        {translated ? (
          <span
            className="translated-text__badge"
            title="자동 번역에는 오역이 있을 수 있습니다. 원문과 함께 확인해 주세요."
          >
            자동 번역
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
      {translated ? (
        original === 'disclosure' ? (
          <div className="translated-text__original">
            <span className="translated-text__notice">
              자동 번역은 오역이 있을 수 있습니다. 원문과 함께 확인해 주세요.
            </span>
            <details>
              <summary>원문 보기</summary>
              {originalText}
            </details>
          </div>
        ) : (
          <span className="translated-text__original">
            <span className="translated-text__original-label">원문</span>
            {originalText}
          </span>
        )
      ) : null}
    </Wrapper>
  );
}
