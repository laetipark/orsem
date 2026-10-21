"""Load the shared environment contract without logging credentials."""

from __future__ import annotations

import base64
import json
import os
import re
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlsplit

DEFAULT_DATABASE_URL = "mysql://orsem:change-me@127.0.0.1:3306/orsem"
DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"


class Config:
    def __init__(self, values: dict[str, Any]):
        self._values = values

    def __getattr__(self, key: str) -> Any:
        try:
            return self._values[key]
        except KeyError:
            raise AttributeError(key) from None

    def get(self, key: str, default: Any = None) -> Any:
        return self._values.get(key, default)

    def __repr__(self) -> str:
        return "Config(<redacted>)"


def repository_root() -> Path:
    override = os.environ.get("ORSEM_REPO_ROOT")
    if override:
        return Path(override).resolve()
    candidate = Path(__file__).resolve()
    for directory in candidate.parents:
        if (directory / "AGENTS.md").is_file() and (directory / "package.json").is_file():
            return directory
    # Installed release runs with the ecosystem's explicit repository cwd.
    return Path.cwd().resolve()


def load_environment(path: Path | None = None) -> None:
    from dotenv import load_dotenv

    load_dotenv(path or repository_root() / ".env", override=False, interpolate=False)


def _text(value: Any) -> str | None:
    return value.strip() or None if isinstance(value, str) else None


def _csv(value: str | None) -> list[str]:
    return list(dict.fromkeys(item.strip() for item in (value or "").split(",") if item.strip()))


def _url(value: str, schemes: tuple[str, ...], name: str) -> str:
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in schemes or not parsed.hostname:
            raise ValueError()
        _ = parsed.port  # Validate malformed/out-of-range port values.
        return value
    except ValueError:
        raise ValueError(f"{name} has an invalid service URL.") from None


def _push(environment: Mapping[str, str]) -> SimpleNamespace:
    disabled = SimpleNamespace(enabled=False, publicKey=None, privateKey=None, subject=None)
    try:
        file: dict[str, Any] = {}
        path = _text(environment.get("WEB_PUSH_CREDENTIALS_FILE"))
        if path:
            declared = Path(path)
            actual = declared.resolve(strict=True)
            stat = actual.stat()
            if (
                not declared.is_absolute()
                or actual.is_relative_to(repository_root())
                or not actual.is_file()
                or stat.st_size > 8192
                or stat.st_mode & 0o077
            ):
                return disabled
            file = json.loads(actual.read_text())
            if not isinstance(file, dict):
                return disabled
        public = _text(environment.get("WEB_PUSH_PUBLIC_KEY")) or _text(file.get("publicKey"))
        private = _text(environment.get("WEB_PUSH_PRIVATE_KEY")) or _text(file.get("privateKey"))
        subject = _text(environment.get("WEB_PUSH_SUBJECT")) or _text(file.get("subject"))
        if not public or not private or not subject:
            return disabled
        if not re.fullmatch(r"[A-Za-z0-9_-]{87}", public) or not re.fullmatch(
            r"[A-Za-z0-9_-]{43}", private
        ):
            return disabled
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        secret = int.from_bytes(base64.urlsafe_b64decode(private + "="), "big")
        derived = (
            ec.derive_private_key(secret, ec.SECP256R1())
            .public_key()
            .public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        )
        if base64.urlsafe_b64encode(derived).decode().rstrip("=") != public:
            return disabled
        contact = urlsplit(subject)
        if contact.username or contact.password or len(subject) > 255:
            return disabled
        if not (
            (contact.scheme == "https" and contact.hostname)
            or (
                contact.scheme == "mailto"
                and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", contact.path)
            )
        ):
            return disabled
        return SimpleNamespace(enabled=True, publicKey=public, privateKey=private, subject=subject)
    except (OSError, ValueError, TypeError, AttributeError):
        return disabled


def load_config(environment: Mapping[str, str] | None = None) -> Config:
    default: Any
    value: Any
    env = os.environ if environment is None else environment
    values: dict[str, Any] = {}
    string_fields = {
        "nodeEnv": ("NODE_ENV", "development"),
        "databaseUrl": ("DATABASE_URL", DEFAULT_DATABASE_URL),
        "redisUrl": ("REDIS_URL", DEFAULT_REDIS_URL),
        "redisPrefix": ("REDIS_PREFIX", "orsem:"),
        "rawDocumentDir": ("RAW_DOCUMENT_DIR", "/home/laeti/orsem-data/raw"),
        "marketDataProvider": ("MARKET_DATA_PROVIDER", "toss"),
        "naverApiProvider": ("NAVER_API_PROVIDER", "developers"),
        "alpacaTradingBaseUrl": ("ALPACA_TRADING_BASE_URL", "https://paper-api.alpaca.markets"),
        "aiBaseUrl": ("AI_BASE_URL", "http://127.0.0.1:11434/v1"),
        "ollamaUrl": ("OLLAMA_URL", "http://127.0.0.1:11434"),
        "newsTranslationModel": (
            "NEWS_TRANSLATION_MODEL",
            _text(env.get("AI_MODEL")) or "qwen3.5:4b-q4_K_M",
        ),
    }
    for key, (variable, default) in string_fields.items():
        values[key] = env.get(variable, default)
    optional_fields = {
        "openDartApiKey": "OPENDART_API_KEY",
        "fscApiKey": "FSC_API_KEY",
        "tossClientId": "TOSS_CLIENT_ID",
        "tossClientSecret": "TOSS_CLIENT_SECRET",
        "tossCredentialsFile": "TOSS_CREDENTIALS_FILE",
        "goldApiKey": "GOLD_API_KEY",
        "eiaApiKey": "EIA_API_KEY",
        "naverClientId": "NAVER_CLIENT_ID",
        "naverClientSecret": "NAVER_CLIENT_SECRET",
        "secUserAgent": "SEC_USER_AGENT",
        "marketauxApiToken": "MARKETAUX_API_TOKEN",
        "alphaVantageApiKey": "ALPHAVANTAGE_API_KEY",
        "finnhubApiKey": "FINNHUB_API_KEY",
        "alpacaApiKey": "ALPACA_API_KEY",
        "alpacaApiSecret": "ALPACA_API_SECRET",
        "aiApiKey": "AI_API_KEY",
        "aiModel": "AI_MODEL",
    }
    for key, variable in optional_fields.items():
        values[key] = _text(env.get(variable))
    for key, variable, default in [
        ("analysisEnabled", "ANALYSIS_ENABLED", False),
        ("analysisDocumentsEnabled", "ANALYSIS_DOCUMENTS_ENABLED", False),
        ("analysisNotesEnabled", "ANALYSIS_NOTES_ENABLED", False),
        ("secForm4Enabled", "SEC_FORM4_ENABLED", True),
        ("gdeltEnabled", "GDELT_ENABLED", False),
        ("alpacaNewsEnabled", "ALPACA_NEWS_ENABLED", False),
        ("marketauxNewsEnabled", "MARKETAUX_NEWS_ENABLED", False),
        ("alphaVantageNewsEnabled", "ALPHAVANTAGE_NEWS_ENABLED", False),
        ("finnhubNewsEnabled", "FINNHUB_NEWS_ENABLED", False),
        ("aiEnabled", "AI_ENABLED", False),
        ("newsTranslationEnabled", "NEWS_TRANSLATION_ENABLED", False),
    ]:
        value = env.get(variable, str(default).lower())
        if variable == "SEC_FORM4_ENABLED" and value == "":
            value = str(default).lower()
        if value not in ("true", "false"):
            raise ValueError(f"{variable} must be true or false.")
        values[key] = value == "true"
    numeric_fields = [
        ("tossMaxSubscriptions", "TOSS_MAX_SUBSCRIPTIONS", 100, 1, 100),
        ("secBackfillMaxRequests", "SEC_BACKFILL_MAX_REQUESTS", 4, 2, 10),
        ("gdeltOverlapMinutes", "GDELT_OVERLAP_MINUTES", 10, 5, 15),
        ("gdeltMaxSplitDepth", "GDELT_MAX_SPLIT_DEPTH", 4, 0, 8),
        ("marketauxNewsDailyBudget", "MARKETAUX_NEWS_DAILY_BUDGET", 50, 1, 50),
        ("marketauxNewsRequestsPerRun", "MARKETAUX_NEWS_REQUESTS_PER_RUN", 2, 1, 2),
        ("alphaVantageNewsDailyBudget", "ALPHAVANTAGE_NEWS_DAILY_BUDGET", 20, 1, 20),
        ("alphaVantageNewsRequestsPerRun", "ALPHAVANTAGE_NEWS_REQUESTS_PER_RUN", 10, 1, 10),
        ("finnhubNewsDailyBudget", "FINNHUB_NEWS_DAILY_BUDGET", 120, 1, 120),
        ("finnhubNewsRequestsPerRun", "FINNHUB_NEWS_REQUESTS_PER_RUN", 5, 1, 5),
        ("aiTimeoutMs", "AI_TIMEOUT_MS", 120000, 1000, 600000),
        ("newsTranslationBatchSize", "NEWS_TRANSLATION_BATCH_SIZE", 3, 1, 10),
        ("newsTranslationTimeoutMs", "NEWS_TRANSLATION_TIMEOUT_MS", 120000, 1000, 180000),
        ("pollOverlapDays", "OPENDART_POLL_OVERLAP_DAYS", 3, 1, 31),
        ("httpTimeoutMs", "HTTP_TIMEOUT_MS", 15000, 1000, 120000),
    ]
    for key, variable, default, minimum, maximum in numeric_fields:
        try:
            raw = env.get(variable) or str(default)
            value = float(raw)
            if not value.is_integer() or not minimum <= value <= maximum:
                raise ValueError()
        except (ValueError, OverflowError):
            raise ValueError(
                f"{variable} must be an integer from {minimum} to {maximum}."
            ) from None
        values[key] = int(value)
    values["openDartGlobalAlertTypes"] = _csv(
        env.get("OPENDART_GLOBAL_ALERT_TYPES", "D001,D002,D005")
    )
    if any(
        item not in ("D001", "D002", "D003", "D004", "D005")
        for item in values["openDartGlobalAlertTypes"]
    ):
        raise ValueError("OPENDART_GLOBAL_ALERT_TYPES contains an unsupported type.")
    values["irFeedUrls"] = _csv(env.get("IR_FEED_URLS"))
    values["newsRssFeeds"] = _csv(env.get("NEWS_RSS_FEEDS"))
    values["gdeltApprovedDomains"] = _csv((env.get("GDELT_NEWS_DOMAINS") or "").lower())
    if len(values["irFeedUrls"]) > 100:
        raise ValueError("IR_FEED_URLS supports at most 100 registered feeds.")
    if any(
        not re.fullmatch(
            r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain
        )
        for domain in values["gdeltApprovedDomains"]
    ):
        raise ValueError("Invalid GDELT domain filter.")
    if values["marketDataProvider"] != "toss" or values["naverApiProvider"] not in (
        "developers",
        "ncloud",
    ):
        raise ValueError("Unsupported market data or NAVER provider.")
    if values["secUserAgent"] and (
        not re.fullmatch(r"[\x20-\x7e]+", values["secUserAgent"])
        or not re.fullmatch(
            r"[A-Za-z0-9][^\r\n]{0,127}\s+[^\s@]+@[^\s@]+\.[^\s@]+", values["secUserAgent"]
        )
    ):
        raise ValueError(
            "SEC_USER_AGENT must use printable ASCII and identify the application and a contact email."
        )
    if values["secUserAgent"] and len(values["secUserAgent"]) > 255:
        raise ValueError("SEC_USER_AGENT is too long.")
    if values["nodeEnv"] == "production":
        if (
            not env.get("DATABASE_URL")
            or values["databaseUrl"] == DEFAULT_DATABASE_URL
            or not env.get("REDIS_URL")
        ):
            raise ValueError(
                "DATABASE_URL and REDIS_URL must be explicitly configured in production."
            )
        if env.get("FIXTURE_MODE", "false") != "false":
            raise ValueError("Production cannot enable fixture data.")
    _url(values["databaseUrl"], ("mysql",), "DATABASE_URL")
    _url(values["redisUrl"], ("redis", "rediss"), "REDIS_URL")
    _url(values["aiBaseUrl"], ("http", "https"), "AI_BASE_URL")
    _url(values["ollamaUrl"], ("http", "https"), "OLLAMA_URL")
    alpaca = urlsplit(_url(values["alpacaTradingBaseUrl"], ("https",), "ALPACA_TRADING_BASE_URL"))
    if (
        alpaca.hostname not in ("api.alpaca.markets", "paper-api.alpaca.markets")
        or alpaca.username
        or alpaca.password
        or alpaca.port not in (None, 443)
        or alpaca.path not in ("", "/")
        or alpaca.query
        or alpaca.fragment
    ):
        raise ValueError("ALPACA_TRADING_BASE_URL must be an approved HTTPS origin.")
    values["alpacaTradingBaseUrl"] = values["alpacaTradingBaseUrl"].rstrip("/")
    if values["tossCredentialsFile"]:
        try:
            credentials = json.loads(Path(values["tossCredentialsFile"]).read_text())
            if isinstance(credentials, dict):
                for key, field in (
                    ("tossClientId", "clientId"),
                    ("tossClientSecret", "clientSecret"),
                ):
                    values[key] = values[key] or _text(credentials.get(field))
        except (OSError, ValueError):
            pass
    values["webPush"] = _push(env)
    return Config(values)
