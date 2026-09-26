from datetime import UTC, date, datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest

from orsem_worker.config import load_config
from orsem_worker.core import db_time, decode_json, json_text
from orsem_worker.jobs import validate_job
from orsem_worker.raw_documents import RawDocumentStore


def test_dates_and_decimal_serialization_preserve_source_meaning():
    assert (
        json_text(
            {
                "instant": datetime(2026, 9, 10, tzinfo=UTC),
                "day": date(2026, 9, 10),
                "amount": Decimal("12345678901234567890.500000"),
            }
        )
        == '{"instant":"2026-09-10T00:00:00.000Z","day":"2026-09-10","amount":"12345678901234567890.500000"}'
    )
    assert db_time(datetime(2026, 9, 10, tzinfo=UTC)).tzinfo is None
    assert decode_json('{"ok":true}') == {"ok": True}


def test_production_requires_explicit_infra_and_never_fixture_seeds():
    with pytest.raises(ValueError):
        load_config({"NODE_ENV": "production"})
    with pytest.raises(ValueError):
        load_config(
            {
                "NODE_ENV": "production",
                "DATABASE_URL": "mysql://user@localhost/app",
                "REDIS_URL": "redis://localhost",
                "FIXTURE_MODE": "true",
            }
        )
    settings = load_config({"NODE_ENV": "test", "AI_ENABLED": "false"})
    assert settings.openDartApiKey is None and settings.aiEnabled is False
    assert settings.openDartGlobalAlertTypes == ["D001", "D002", "D005"]
    assert "secret" not in repr(load_config({"AI_API_KEY": "secret"}))


@pytest.mark.parametrize(
    "value",
    [
        "Orsem 홍길동 contact@example.com",
        "Orsem contact@예시.com",
        "Orsem\x00identity contact@example.com",
        "Orsem\tidentity contact@example.com",
        "Orsem\ridentity contact@example.com",
        "Orsem\nidentity contact@example.com",
        "Orsem\x7fidentity contact@example.com",
        "Orsem\u00a0identity contact@example.com",
    ],
)
def test_sec_user_agent_rejects_non_ascii_and_embedded_controls(value):
    with pytest.raises(ValueError, match="SEC_USER_AGENT.*printable ASCII"):
        load_config({"SEC_USER_AGENT": value})


def test_sec_user_agent_validates_the_trimmed_header_value():
    expected = "Orsem Research/1.0 contact+sec@example.com"
    settings = load_config({"SEC_USER_AGENT": f"\r\n\t {expected} \t\r\n"})
    assert settings.secUserAgent == expected
    assert load_config({"SEC_USER_AGENT": " \t\r\n"}).secUserAgent is None
    with pytest.raises(ValueError, match="SEC_USER_AGENT"):
        load_config({"SEC_USER_AGENT": "contact@example.com"})


def test_job_scope_and_types_are_validated_before_actions():
    assert validate_job("poll-opendart", {"detailType": "D005"})["suppressAlerts"] is False
    with pytest.raises(ValueError):
        validate_job("poll-opendart", {"detailType": "D002", "suppressAlerts": "true"})
    with pytest.raises(ValueError):
        validate_job(
            "discover-news-links",
            {
                "connectors": ["SEC"],
                "reason": "BACKFILL",
                "companyIds": ["00000000-0000-4000-8000-000000000001"],
            },
        )
    with pytest.raises(ValueError):
        validate_job("ingest-toss-candles", {"interval": "1d", "lookbackDays": 367})


@pytest.mark.asyncio
async def test_raw_document_store_is_immutable_and_verifies_repeated_writes(tmp_path):
    store = RawDocumentStore(SimpleNamespace(rawDocumentDir=str(tmp_path)))
    first = await store.put(b"official disclosure")
    second = await store.put(b"official disclosure")
    assert first["created"] is True and second["created"] is False
    assert first["sha256"] == second["sha256"]
    target = tmp_path / first["sha256"][:2] / (first["sha256"] + ".zip")
    target.write_bytes(b"corrupted")
    with pytest.raises(ValueError):
        await store.put(b"official disclosure")
