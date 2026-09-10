"""Lossless OpenDART scalar parsing and allow-listed transaction classification."""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from decimal import Decimal, localcontext
from typing import Any

PARSER_VERSION = "opendart-xml-v3"
NORMALIZER_VERSION = "opendart-dialect-v1"


class OpenDartPayloadError(ValueError):
    def __init__(self, message: str, code: str, **details: Any):
        super().__init__(message)
        self.code = code
        self.candidateErrors = details.get("candidateErrors", [])
        self.normalizationAudit = details.get("normalizationAudit")


class OpenDartApiError(RuntimeError):
    def __init__(self, status: str, message: str, operation: str = "DOCUMENT"):
        super().__init__(f"OpenDART API {status}: {message}")
        self.status, self.apiMessage = status, message
        self.retryPolicy = retry_policy(status, operation)


def retry_policy(status: str, operation: str) -> str:
    if status == "020":
        return "NEXT_KST_DAY"
    if status in ("800", "900"):
        return "SHORT_BACKOFF"
    return "DELAYED_DOCUMENT" if status == "014" and operation == "DOCUMENT" else "NONE"


def whitespace(value: str) -> str:
    return re.sub(r"[\t\r\n ]+", " ", value.replace("\u00a0", " ")).strip()


def header(value: str) -> str:
    return re.sub(
        r"[\s·ㆍ:：()（）\[\]{}]", "", unicodedata.normalize("NFKC", whitespace(value))
    ).lower()


def date_only(raw: str) -> str | None:
    value = re.sub(
        r"\s",
        "",
        unicodedata.normalize("NFKC", whitespace(raw))
        .replace("년", "-")
        .replace("월", "-")
        .replace("일", ""),
    ).rstrip(".")
    match = re.fullmatch(r"(\d{4})[./-]?(\d{1,2})[./-]?(\d{1,2})", value)
    try:
        return date(*(int(x) for x in match.groups())).isoformat() if match else None
    except ValueError:
        return None


def warning(code: str, message: str, field: str | None = None, **kwargs: Any) -> dict:
    return {"code": code, "message": message, **({"field": field} if field else {}), **kwargs}


def numeric_warning(code: str, original: str, field: str) -> dict:
    text = (
        f"소수점 이하 6자리를 초과했습니다: {original[:128]}"
        if code == "NUMERIC_SCALE_EXCEEDED"
        else f"DECIMAL(38,6) 범위로 안전하게 저장할 수 없습니다: {original[:128]}"
    )
    return warning(code, text, field)


def fits_decimal(value: str) -> bool:
    match = re.fullmatch(r"[+-]?(\d+)(?:\.(\d+))?", value)
    if not match:
        return False
    whole = len(match[1].lstrip("0") or "0")
    fraction = len((match[2] or "").rstrip("0"))
    return whole <= 32 and fraction <= 6 and whole + fraction <= 38


def canonical_decimal(value: Decimal) -> str:
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return "0" if not value else result


def multiply(integer_value: str, decimal_value: str) -> str | None:
    if (
        len(integer_value) > 128
        or len(decimal_value) > 128
        or not re.fullmatch(r"[+-]?\d+", integer_value)
        or not re.fullmatch(r"[+-]?\d+(?:\.\d+)?", decimal_value)
    ):
        return None
    with localcontext() as context:
        context.prec = 300
        value = canonical_decimal(Decimal(integer_value) * Decimal(decimal_value))
    return value if fits_decimal(value) else None


def scale(value: str | None, multiplier: int) -> str | None:
    return (
        multiply(str(multiplier), value)
        if value is not None and isinstance(multiplier, int) and 1 <= multiplier <= 9007199254740991
        else None
    )


def numeric(raw: str, field: str, integer: bool = False) -> dict:
    original = whitespace(raw)
    result: dict[str, Any] = {"value": None, "unitRaw": None, "warning": None}
    if not original or re.fullmatch(r"[-―—–]+", original):
        return result
    if len(original) > 128:
        return {**result, "warning": numeric_warning("NUMERIC_OUT_OF_RANGE", original, field)}
    if integer:
        invalid = re.search(r"(억원|백만원|천원|원)$", original)
        if invalid:
            return {
                **result,
                "unitRaw": invalid[1],
                "warning": warning(
                    "INVALID_SHARE_UNIT",
                    f"주식 수량 필드에 금액 단위를 적용할 수 없습니다: {original}",
                    field,
                ),
            }
    pattern = r"(백만주|천주|주|개|좌)$" if integer else r"(억원|백만원|천원|원|%|달러|USD|KRW)$"
    unit_match = re.search(pattern, original, re.IGNORECASE)
    unit = unit_match[1] if unit_match else None
    result["unitRaw"] = unit
    normalized = re.sub(r"[−–—]", "-", unicodedata.normalize("NFKC", original))
    normalized = re.sub(pattern, "", re.sub(r"[,\s]", "", normalized), flags=re.IGNORECASE)
    negative = normalized.startswith("(") and normalized.endswith(")")
    if negative:
        normalized = normalized[1:-1]
    if not re.fullmatch(r"[+-]?\d+" if integer else r"[+-]?\d+(?:\.\d+)?", normalized):
        code = "INVALID_INTEGER" if integer else "INVALID_DECIMAL"
        message = (
            f"숫자로 안전하게 해석할 수 없습니다: {original}"
            if integer
            else f"소수로 안전하게 해석할 수 없습니다: {original}"
        )
        return {**result, "warning": warning(code, message, field)}
    fraction = normalized.partition(".")[2].rstrip("0")
    if len(fraction) > 6:
        return {**result, "warning": numeric_warning("NUMERIC_SCALE_EXCEEDED", original, field)}
    multipliers = (
        {"백만주": 1000000, "천주": 1000}
        if integer
        else {"억원": 100000000, "백만원": 1000000, "천원": 1000}
    )
    with localcontext() as context:
        context.prec = 300
        value = Decimal(normalized)
        if negative:
            value = -abs(value)
        value *= multipliers.get(unit or "", 1)
        canonical = canonical_decimal(value)
    if not fits_decimal(canonical):
        return {**result, "warning": numeric_warning("NUMERIC_OUT_OF_RANGE", original, field)}
    return {**result, "value": canonical}


def parse_integer(raw: str, field: str = "quantity") -> dict:
    return numeric(raw, field, True)


def parse_decimal(raw: str, field: str = "unitPrice") -> dict:
    return numeric(raw, field)


def unit_price(raw: str) -> dict:
    text = unicodedata.normalize("NFKC", whitespace(raw))
    if re.fullmatch(r"(?:-\s*)?(?:\(\s*-?\s*\))?", text):
        return parse_decimal("")
    labeled = re.fullmatch(r"(?:취득|처분|장내취득|장내처분)\s*\(\s*([^()]+)\s*\)", text)
    if labeled:
        text = labeled[1].strip()
    wrapped = re.fullmatch(
        r"\(\s*([\d,]+(?:\.\d+)?\s*(?:원|KRW|달러|USD)?)\s*\)", text, re.IGNORECASE
    )
    if wrapped:
        text = wrapped[1]
    text = re.sub(r"\s*\(\s*(원|KRW|달러|USD)\s*\)$", r"\1", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*\(\s*-?\s*\)$", "", text)
    result = parse_decimal(text)
    if result["value"] and result["value"].startswith("-"):
        return {
            **result,
            "value": None,
            "warning": warning("INVALID_UNIT_PRICE", "단가는 음수일 수 없습니다.", "unitPrice"),
        }
    return result


_METHOD_GROUPS = {
    ("MARKET_BUY", "INCREASE"): ["장내매수", "장내매수(+)"],
    ("MARKET_SELL", "DECREASE"): ["장내매도", "장내매도(-)"],
    ("BLOCK_BUY", "INCREASE"): ["시간외대량매매(매수)", "신고대량매매(+)"],
    ("BLOCK_SELL", "DECREASE"): ["시간외대량매매(매도)", "신고대량매매(-)"],
    ("AFTER_HOURS_BUY", "INCREASE"): ["시간외매수", "시간외매매(+)"],
    ("AFTER_HOURS_SELL", "DECREASE"): ["시간외매도", "시간외매매(-)"],
    ("OFF_MARKET_BUY", "INCREASE"): ["장외매수"],
    ("OFF_MARKET_SELL", "DECREASE"): ["장외매도"],
    ("STOCK_COMPENSATION", "INCREASE"): ["자사주상여금"],
    ("NEW_SHARE_SUBSCRIPTION", "INCREASE"): ["제3자배정유상증자", "유상신주취득"],
    ("SECURITIES_SUBSCRIPTION", "INCREASE"): ["cb인수"],
    ("STOCK_LENDING", "DECREASE"): ["대여"],
    ("STOCK_LENDING", "INCREASE"): ["대여회수"],
    ("REPORTING_STATUS_CHANGE", "UNKNOWN"): ["신규선임", "신규보고", "신규주요주주", "임원퇴임"],
    ("RIGHTS_CHANGE", "UNKNOWN"): ["행사가액조정"],
    ("RIGHTS_CHANGE", "DECREASE"): ["전환권등소멸", "전환등"],
    ("RIGHTS_CHANGE", "INCREASE"): ["주식매수선택권"],
    ("CONVERSION", "INCREASE"): [
        "전환사채의권리행사",
        "신주인수권증권의권리행사",
        "전환권행사",
        "신주인수권행사",
    ],
    ("STOCK_DIVIDEND", "INCREASE"): ["주식배당"],
    ("CAPITAL_REDUCTION", "DECREASE"): ["자본감소"],
    ("GIFT_CANCELLATION", "INCREASE"): ["증여취소"],
    ("TENDER_OFFER_APPLICATION", "DECREASE"): ["공개매수청약"],
    ("GIFT_IN", "INCREASE"): ["수증"],
    ("GIFT_OUT", "DECREASE"): ["증여"],
    ("OPTION_EXERCISE", "INCREASE"): ["주식매수선택권행사", "스톡옵션행사"],
    ("RSU_RSA", "INCREASE"): ["rsu", "rsa", "양도제한조건부주식"],
    ("STOCK_SPLIT_MERGER", None): ["주식분할", "주식병합", "합병"],
    ("TRUST_TRANSFER", None): ["신탁이체", "신탁계약"],
    ("INHERITANCE", "INCREASE"): ["상속"],
}
METHOD_RULES = {method: pair for pair, methods in _METHOD_GROUPS.items() for method in methods}
AMOUNT_NATURES = {
    x
    for x, _ in _METHOD_GROUPS
    if x
    in (
        "MARKET_BUY",
        "MARKET_SELL",
        "BLOCK_BUY",
        "BLOCK_SELL",
        "OFF_MARKET_BUY",
        "OFF_MARKET_SELL",
        "AFTER_HOURS_BUY",
        "AFTER_HOURS_SELL",
    )
}


def direction(quantity: str | None) -> str:
    if quantity is None or not re.fullmatch(r"[+-]?\d+", quantity):
        return "UNKNOWN"
    return "INCREASE" if int(quantity) > 0 else "DECREASE" if int(quantity) < 0 else "NEUTRAL"


def classify_method(
    method_raw: str, quantity: str | None, quantity_is_absolute: bool = False
) -> dict:
    quantity_direction = direction(quantity)
    key = (
        re.sub(r"[\sㆍ·ᆞ]", "", unicodedata.normalize("NFKC", whitespace(method_raw)))
        .replace("−", "-")
        .replace("–", "-")
        .lower()
    )
    suffix = re.search(r"\(([+-])\)$", key)
    rule = METHOD_RULES.get(key) or (
        METHOD_RULES.get(re.sub(r"\([+-]\)$", "", key)) if suffix else None
    )
    if not rule:
        return {
            "nature": "UNKNOWN",
            "direction": "UNKNOWN" if quantity_is_absolute else quantity_direction,
            "confidence": 0.25 if method_raw.strip() else 0,
            "warnings": [
                warning(
                    "UNKNOWN_METHOD",
                    f"허용 목록에 없는 변동 방법입니다: {whitespace(method_raw)}",
                    "methodRaw",
                )
                if method_raw.strip()
                else warning("MISSING_METHOD", "변동 방법이 비어 있습니다.", "methodRaw")
            ],
        }
    nature, rule_direction = rule
    suffix_direction = ("INCREASE" if suffix[1] == "+" else "DECREASE") if suffix else None
    specified_direction = rule_direction if rule_direction != "UNKNOWN" else None
    if suffix_direction and (
        (specified_direction and specified_direction != suffix_direction)
        or (
            not quantity_is_absolute
            and quantity_direction not in ("UNKNOWN", "NEUTRAL")
            and quantity_direction != suffix_direction
        )
    ):
        return {
            "nature": "UNKNOWN",
            "direction": quantity_direction,
            "confidence": 0.2,
            "warnings": [
                warning(
                    "METHOD_QUANTITY_CONFLICT",
                    "변동 방법의 부호 표기와 방향 또는 수량이 일치하지 않습니다.",
                    "methodRaw",
                )
            ],
        }
    if (
        specified_direction
        and not quantity_is_absolute
        and quantity_direction not in ("UNKNOWN", "NEUTRAL")
        and specified_direction != quantity_direction
    ):
        return {
            "nature": "UNKNOWN",
            "direction": quantity_direction,
            "confidence": 0.2,
            "warnings": [
                warning(
                    "METHOD_QUANTITY_CONFLICT",
                    "변동 방법의 방향과 수량 부호가 일치하지 않습니다.",
                    "quantity",
                )
            ],
        }
    return {
        "nature": nature,
        "direction": rule_direction or ("UNKNOWN" if quantity_is_absolute else quantity_direction),
        "confidence": 1,
        "warnings": [],
    }
