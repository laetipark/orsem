"""Lossless multilingual fact checks for locally generated Korean metadata."""

from fractions import Fraction

import regex as re

MAGNITUDES = {
    "trillion": 12,
    "billion": 9,
    "bn": 9,
    "million": 6,
    "mn": 6,
    "thousand": 3,
    "조": 12,
    "억": 8,
    "천만": 7,
    "백만": 6,
    "만": 4,
    "천": 3,
}


def mixed_fractions(text):
    def sub(match):
        whole, top, bottom = match.groups()
        top, bottom = int(top), int(bottom)
        if not 2 <= bottom <= 100 or not 0 < top < bottom:
            return match[0]
        remainder = bottom
        while remainder % 2 == 0:
            remainder //= 2
        while remainder % 5 == 0:
            remainder //= 5
        if remainder != 1:
            return match[0]
        scale = 1
        places = 0
        while scale % bottom:
            scale *= 10
            places += 1
        return f"{whole}.{str(top * scale // bottom).zfill(places).rstrip('0')}"

    return re.sub(r"(?<![\w./])([-+]?\d+)[ -](\d+)/(\d+)(?![\w/])", sub, text, flags=re.ASCII)


def calendar_facts(text):
    months = []
    weekdays = []
    text = re.sub(r"([-+])\s*([$€£₩])\s*(?=\d)", r"\2\1", text.replace("−", "-"))
    text = re.sub(r"\b(\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b", r"\1년 \2월 \3일", text)
    names = [
        "Jan(?:uary)?",
        "Feb(?:ruary)?",
        "Mar(?:ch)?",
        "Apr(?:il)?",
        "May",
        "Jun(?:e)?",
        "Jul(?:y)?",
        "Aug(?:ust)?",
        "Sep(?:t(?:ember)?)?",
        "Oct(?:ober)?",
        "Nov(?:ember)?",
        "Dec(?:ember)?",
    ]
    for index, name in enumerate(names):

        def sub(match, text=text, index=index):
            before, after = text[: match.start()], text[match.end() :]
            explicit = bool(
                re.match(r"\s+\d{1,4}(?:st|nd|rd|th)?\b", after, re.I)
                or re.search(r"\b\d{1,2}\s+$", before)
            )
            followed = not match[0].endswith(".") and bool(
                re.match(r"\s+[A-Z](?:\.|[A-Za-z'’-]+\b)", after)
            )
            subject = re.match(r"\s+(?:results?|earnings|reports?|meetings?)\b", after, re.I)
            heading = subject and (
                not re.fullmatch(r"may\.?", match[0], re.I)
                or re.fullmatch(r"May\.?", match[0])
                and re.match(r"\s*(?:$|[:.,;!?—–-])", after[subject.end() :])
            )
            context = (
                explicit
                or heading
                or not followed
                and (
                    re.search(
                        r"\b(?:in|since|until|through|during|from|by|of|for)\s+$", before, re.I
                    )
                    or re.search(r"\b(?:early|late|mid)[ -]+$", before, re.I)
                    or re.search(r"\bmonth\s+$", before, re.I)
                    or text.strip() == match[0]
                )
            )
            return f"{index + 1}월" if context else match[0]

        text = re.sub(rf"\b(?:{name})\b\.?", sub, text, flags=re.I)

    def month_sub(match):
        number = int(match[1])
        if not 1 <= number <= 12:
            return match[0]
        months.append(str(number))
        return " "

    text = re.sub(r"(?<![\d.])(\d{1,2})\s*월", month_sub, text)
    for index, (english, korean) in enumerate(
        zip(
            (
                "Mon(?:day)?",
                "Tue(?:s(?:day)?)?",
                "Wed(?:nesday|s)?",
                "Thu(?:r(?:s(?:day)?)?)?",
                "Fri(?:day)?",
                "Sat(?:urday)?",
                "Sun(?:day)?",
            ),
            ("월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"),
        )
    ):

        def weekday_sub(match, text=text, index=index):
            if re.fullmatch(r"(?:sun|sat|mon)\.?", match[0], re.I):
                before, after = text[: match.start()], text[match.end() :]
                if (
                    text.strip() != match[0]
                    and not re.search(r"\b(?:on|by|for|until|through|from|due)\s+$", before, re.I)
                    and not re.match(r"\s*,?\s*\d", after)
                ):
                    return match[0]
            weekdays.append(str(index))
            return " "

        text = re.sub(rf"\b{english}\b\.?|{korean}", weekday_sub, text, flags=re.I)
    return text, sorted(months), sorted(weekdays)


def half_facts(text):
    periods = []

    def record(half, year):
        first = bool(re.fullmatch(r"H1|first[ -]half|상", half, re.I))
        periods.append(f"{year}:H{1 if first else 2}")
        return f" {year} "

    def sub(match):
        if re.match(
            r"\s*(?:(?:chips?|processors?|sensors?|models?|devices?)\b|칩|프로세서|센서|모델|기기)",
            text[match.end() :],
            re.I,
        ):
            return match[0]
        return record(match[1] or match[4], match[2] or match[3])

    remaining = re.sub(
        r"(?<![\p{L}\p{N}_.])(?:(H[12]|(?:first|second)[ -]half)\s+(?:of\s+)?([12]\d{3})(?![\p{L}\p{N}_]|\.\d)|([12]\d{3})\s+(H[12]|(?:first|second)[ -]half)(?![\p{L}\p{N}_-]))",
        sub,
        text,
        flags=re.I,
    )
    remaining = re.sub(
        r"(?<![\p{L}\p{N}_.])([12]\d{3})\s*년\s*(상|하)반기",
        lambda m: record(m[2], m[1]),
        remaining,
    )
    return remaining, sorted(periods)


def clock_facts(text):
    times = []

    def english(m):
        times.append(f"{int(m[1]) % 12 + (12 if m[3].lower() == 'p' else 0)}:{int(m[2] or 0)}")
        return " "

    remaining = re.sub(
        r"(?<![\w.])(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*([ap])\.?\s*m\.?(?![A-Za-z])",
        english,
        text,
        flags=re.I | re.ASCII,
    )

    def korean(m):
        times.append(f"{int(m[2]) % 12 + (12 if m[1] == '후' else 0)}:{int(m[3] or m[4] or 0)}")
        return " "

    remaining = re.sub(
        r"오(전|후)\s*(0?[1-9]|1[0-2])(?::([0-5]\d)|\s*시(?:\s*([0-5]?\d)\s*분)?)",
        korean,
        remaining,
    )
    return remaining, sorted(times)


def unmarked_clocks(text, times):
    times = list(times)

    def record(m):
        times.append(f"{int(m[1])}:{int(m[2] or 0)}")
        return " "

    text = re.sub(r"(?<![\p{L}\d:./])([01]?\d|2[0-3]):([0-5]\d)(?![\d:/]|\.\d)", record, text)
    text = re.sub(
        r"(?<![\p{L}\d.])([01]?\d|2[0-3])\s*시(?:\s*([0-5]?\d)\s*분)?(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에로와과]|부터|까지|쯤|정각)",
        record,
        text,
    )
    return text, sorted(times)


def numeric_facts(text):
    text = mixed_fractions(text)
    text = re.sub(
        r"(?<![\w./])([-+]?\d[\d,]*(?:\.\d+)?)(?:\s*(%|percent\b|퍼센트))?\s*(?:to\b|through\b|[-~–—]|에서)\s*([-+]?\d[\d,]*(?:\.\d+)?)(?:\s*(%|percent\b|퍼센트))(?![\w/]|\.\d)",
        lambda m: f"{m[1]}% to {m[3]}%",
        text,
        flags=re.I | re.ASCII,
    )
    for index, ordinal in enumerate(("first", "second", "third", "fourth")):
        text = re.sub(rf"\b{ordinal}(?=[ -]quarter\b)", str(index + 1), text, flags=re.I)
    matches = list(
        re.finditer(
            r"(?<!\d)([-+]?\d[\d,]*(?:\.\d+)?)(?:\s*((?:trillion|billion|million|thousand|bn|mn|percent)\b|천만|백만|조|억|만|천|퍼센트|%))?",
            text,
            re.I,
        )
    )
    facts = []
    index = 0
    while index < len(matches):
        match = matches[index]
        unit = (match[2] or "").lower()
        amount = Fraction(match[1].replace(",", "")) * 10 ** MAGNITUDES.get(unit, 0)
        previous = match
        exponent = MAGNITUDES.get(unit) if re.fullmatch("[가-힣]+", unit) else None
        while exponent is not None and index + 1 < len(matches):
            following = matches[index + 1]
            following_unit = following[2] or ""
            next_exp = (
                MAGNITUDES.get(following_unit) if re.fullmatch("[가-힣]+", following_unit) else None
            )
            if (
                next_exp is None
                or next_exp >= exponent
                or re.match("[-+]", following[1])
                or text[previous.end() : following.start()].strip()
            ):
                break
            part = Fraction(following[1].replace(",", "")) * 10**next_exp
            if part >= 10**exponent:
                break
            amount += -part if match[1].startswith("-") else part
            previous = following
            exponent = next_exp
            index += 1
        facts.append(
            f"{amount.numerator}/{amount.denominator}"
            + ("%" if unit in ("percent", "퍼센트", "%") else "")
        )
        index += 1
    return sorted(facts)


def currency_facts(text):
    names = [
        ("CAD", r"\bCAD\b|(?:CA|C)\$|\bCanadian\s+dollars?\b|캐나다\s*달러"),
        ("AUD", r"\bAUD\b|(?:AU|A)\$|\bAustralian\s+dollars?\b|호주\s*달러"),
        ("NZD", r"\bNZD\b|NZ\$|\bNew Zealand\s+dollars?\b|뉴질랜드\s*달러"),
        ("HKD", r"\bHKD\b|HK\$|\bHong Kong\s+dollars?\b|홍콩\s*달러"),
        ("SGD", r"\bSGD\b|SG\$|\bSingapore\s+dollars?\b|싱가포르\s*달러"),
        ("USD", r"\bUSD\b|\$|\bdollars?\b|달러"),
        (
            "KRW",
            r"\bKRW\b|₩|(?<=\d)(?:\s*(?:trillion|billion|million|thousand))?\s*won\b|(?<=[\d조억만천])\s*원(?=$|\s|[.,;:!?은는이가을를의에으짜당])",
        ),
        (
            "EUR",
            r"\bEUR\b|€|\beuros?\b|유로(?:화)?(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에와과당]|으로|로|짜리)",
        ),
        (
            "GBP",
            r"\bGBP\b|£|(?<=\d)(?:\s*(?:trillion|billion|million|thousand))?\s*pounds?\b|파운드(?:화)?(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에와과당]|으로|로|짜리)",
        ),
        (
            "JPY",
            r"\bJPY\b|(?<=\d)(?:\s*(?:trillion|billion|million|thousand))?\s*yen\b|엔화|(?<=[\d조억만천])\s*엔(?=$|\s|[.,;:!?은는이가을를의에으짜당])",
        ),
    ]
    currencies = set()
    for currency, pattern in names:

        def sub(m, currency=currency):
            currencies.add(currency)
            return " "

        text = re.sub(pattern, sub, text, flags=re.I)
    return sorted(currencies)


def eastern_zones(text):
    patterns = {
        "EDT": r"(?<![A-Za-z])EDT(?![A-Za-z])|\bEastern\s+Daylight(?:\s+Saving)?\s+Time\b|동부\s*(?:일광\s*절약(?:\s*\(서머\s*타임\))?\s*(?:시간|시)(?:제)?|서머\s*타임)(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에로와과])",
        "EST": r"(?<![A-Za-z])EST(?![A-Za-z])|\bEastern\s+Standard\s+Time\b|동부\s*표준\s*(?:시간|시)(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에로와과])",
    }
    return sorted(k for k, p in patterns.items() if re.search(p, text, re.I))


def validate_facts(before, after, tickers=()):
    original, om, ow = calendar_facts(before)
    translated, tm, tw = calendar_facts(after)
    original, oh = half_facts(original)
    translated, th = half_facts(translated)
    original, oc = clock_facts(original)
    translated, tc = clock_facts(translated)
    if oc or tc:
        original, oc = unmarked_clocks(original, oc)
        translated, tc = unmarked_clocks(translated, tc)
    checks = (
        (om, tm, "calendar month"),
        (ow, tw, "weekday"),
        (oh, th, "half-year"),
        (oc, tc, "clock time"),
        (eastern_zones(before), eastern_zones(after), "time zone"),
        (numeric_facts(original), numeric_facts(translated), "numeric"),
        (currency_facts(before), currency_facts(after), "currency"),
    )
    for left, right, label in checks:
        if left != right:
            raise ValueError(f"Local translation changed {label} facts.")
    for ticker in tickers:
        pattern = rf"(?<![A-Za-z0-9]){re.escape(ticker)}(?![A-Za-z0-9])"
        if re.search(pattern, before) and not re.search(pattern, after):
            raise ValueError("Local translation changed a ticker symbol.")


def validate_language(original, translated):
    before, after = original.strip(), translated.strip()

    def without_addresses(text):
        return re.sub(
            r"https?://[^\s<>]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", "", text, flags=re.I
        )

    op, tp = without_addresses(before), without_addresses(after)
    if before == after and (
        re.fullmatch(r"PDF|HTML|XML|JSON|CSV|XLSX?|DOCX?|PPTX?|JPEG|JPG|PNG|GIF", before)
        or not re.search(r"\p{L}", op)
    ):
        return
    hangul = len(re.findall(r"\p{Script=Hangul}", tp))
    han = len(re.findall(r"\p{Script=Han}", tp))
    original_han = len(re.findall(r"\p{Script=Han}", op))
    other = r"[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Arabic}\p{Script=Cyrillic}]"
    if (
        not hangul
        or han > original_han
        and han >= max(3, hangul / 3)
        or re.search(other, tp)
        and not re.search(other, op)
    ):
        raise ValueError("Local content translation is not Korean.")
    prose = tp
    for name in re.findall(
        r"\b[A-Z][A-Za-z0-9.'’-]*(?:\s+(?:(?:of|the|de|and)\s+)?[A-Z][A-Za-z0-9.'’-]*)+\b", op
    ):
        prose = prose.replace(name, " ")
    if (
        len(re.findall(r"[A-Za-z]+", prose)) >= 10
        and len(re.findall(r"[A-Za-z]", prose)) > hangul * 2
    ):
        raise ValueError("Local translation changed language coverage.")
    source_letters = len(re.findall(r"\p{L}", op))
    target_letters = len(re.findall(r"\p{L}", tp))
    if source_letters >= 80 and target_letters < max(12, source_letters * 0.12):
        raise ValueError("Local translation changed content coverage.")


def validate_translation(input, value):
    if not isinstance(value, dict) or set(value) != {"title", "description"}:
        raise ValueError("Invalid translation fields.")
    title = value.get("title")
    description = value.get("description")
    if (
        not isinstance(title, str)
        or not 1 <= len(title.strip()) <= 1600
        or description is not None
        and (not isinstance(description, str) or not 1 <= len(description.strip()) <= 3000)
    ):
        raise ValueError("Invalid translation size.")
    output = {
        "title": title.strip(),
        "description": description.strip() if description is not None else None,
    }
    if not re.search("[가-힣]", output["title"]) or (input["description"] is None) != (
        output["description"] is None
    ):
        raise ValueError("Local translation did not match the requested Korean fields.")
    for field in ("title", "description"):
        before, after = input.get(field) or "", output.get(field) or ""
        if input.get(field) is not None:
            validate_language(before, after)
        validate_facts(before, after, input.get("tickers", []))
    return output
