# Orsem README 배너 제작 기록

- 결과 이미지: [orsem-banner.png](orsem-banner.png)
- 최종 제작 방식: Figma의 편집 가능한 텍스트·벡터·그라데이션으로 구성한 뒤 PNG 출력
- [Figma 배너 편집 원본](https://www.figma.com/design/3ywykwXQtzJxqu7zn2YwlO/orsem-ui?node-id=99-2)
- 구성: 2172×724px, 60개 편집 가능한 레이어, 텍스트 2개, 이미지 채우기 없음
- 초기 시안: 내장 이미지 생성 도구로 제작한 아래 프롬프트의 결과를 디자인 참고로 사용
- 요청: 캐릭터를 제거하고 합장한 두 손 아이콘과 상승 막대로 사이트 로고 및 배너 통일
- 참조: 교체 전 README 배너와 [새 Orsem 로고](../../apps/web/public/icons/icon-512.png)
- 편집 가능한 로고 원본: [orsem-mark.svg](../../apps/web/src/assets/orsem-mark.svg)
- 출력 문구: `ORSEM`, `공시·시장 관측 도구`
- 갱신일: 2026-10-28

## 생성 프롬프트

아래 프롬프트는 초기 시안 제작 기록입니다. 최종 README 이미지는 Figma 편집 원본에서 출력했습니다.

```text
Use case: compositing
Asset type: Orsem GitHub README project banner.
Primary request: replace the character in Image 1 with the standalone praying-hands emblem from Image 2. The user wants an icon of two praying hands themselves, not any character or mascot.
Input images: Image 1 is the existing banner to edit. Image 2 is the authoritative new site logo: two palms pressed vertically together, warm ivory-gold hands, mint cuffs, five separate coral bars rising left to right behind the hands.
Composition: keep the approximately 3:1 wide landscape layout, very large ORSEM wordmark on the left, subtitle below, and prominent emblem on the right. The new praying hands should occupy the hero space confidently. Follow Image 2's hand silhouette, mint cuffs and five ascending rounded coral bars with shared baseline.
Preserve: the deep charcoal and forest-green background, elegant mint and off-white typography, subtle flowing mint lines, restrained document sheets and soft lighting.
Text (verbatim): "ORSEM" and "공시·시장 관측 도구". Keep these two text elements sharply legible and correctly spelled, no other text.
Remove completely: the yellow circular head, face, cheeks, eyes, mouth, sprout leaf, torso, white shirt and any mascot/character body. There must be ONLY the standalone praying hands with mint cuffs in front of the bars. No face hidden in or above the hands. No arrows.
Style: polished dimensional vector-like brand illustration, restrained soft shading, spacious and refined.
Constraints: no numerical prices, trading recommendations, return promises, dashboard cards or watermark. Opaque background.
```

## 막대 수 보정 프롬프트

첫 결과에서 막대 수를 원본 SVG와 같은 5개로 맞췄습니다.

```text
Use case: precise-object-edit
Edit Image 1, preserving the entire banner including exact text, praying hands, mint cuffs, lighting, dark background and composition.
Make one precise correction: the coral rising bar chart behind the praying hands must contain EXACTLY FIVE bars, matching the five-bar spacing in Image 2. The current banner has six. Remove the extra middle bar and redistribute into exactly five equal-width separate rounded coral bars that rise evenly from left to right with one shared baseline. The bars are behind the hands, never over them.
Keep the standalone praying hands emblem. No head, face, leaf, sprout, body, mascot or arrow.
Preserve exact text: "ORSEM" and "공시·시장 관측 도구". No new text. Opaque background, same 3:1 format.
```
