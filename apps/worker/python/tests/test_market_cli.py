"""Administrative commands remain explicit and side-effect free by default."""

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker.cli import CliError, SecCollection, backfill_news_relevance, execute, parser


def test_cli_apply_requires_explicit_flag():
    for command in ("backfill-news-relevance", "sync-korean-etfs"):
        assert parser().parse_args([command]).apply is False
        assert parser().parse_args([command, "--dry-run"]).apply is False
        assert parser().parse_args([command, "--apply"]).apply is True
        with pytest.raises(SystemExit):
            parser().parse_args([command, "--apply", "--dry-run"])
    with pytest.raises(SystemExit):
        parser().parse_args(["preview-market-leaders", "--apply"])


class BackfillDatabase:
    def __init__(self):
        self.row = {
            "id": "source-1",
            "title": "Synthetic filing",
            "company_id": "00000000-0000-4000-8000-000000000001",
            "source": "SEC",
            "raw_metadata_json": {},
        }
        self.writes = []

    async def fetch_all(self, sql, params=None):
        if "FROM source_items" in sql:
            return [self.row] if params["after"] == "" else []
        return []

    async def fetch_one(self, sql, params=None):
        return self.row

    async def execute(self, sql, params=None):
        self.writes.append((sql, params))

    @asynccontextmanager
    async def transaction(self):
        yield self


@pytest.mark.asyncio
async def test_backfill_defaults_to_read_only_with_explicit_sec_identity():
    db = BackfillDatabase()
    result = await backfill_news_relevance(db)
    assert result == {"scanned": 1, "relatedSources": 1, "relations": 1, "applied": False}
    assert db.writes == []


@pytest.mark.asyncio
async def test_backfill_apply_uses_locked_authoritative_row(monkeypatch):
    db = BackfillDatabase()
    replace = AsyncMock()
    monkeypatch.setattr("orsem_worker.cli.replace_relevance", replace)
    result = await backfill_news_relevance(db, True)
    assert result["applied"] is True
    replace.assert_awaited_once_with(
        db, "source-1", "Synthetic filing", [("00000000-0000-4000-8000-000000000001", "SEC_CIK")]
    )


@pytest.mark.asyncio
async def test_sec_job_requires_initialized_queue():
    with pytest.raises(CliError, match="QUEUE_NOT_INITIALIZED"):
        await SecCollection(None).run_job("discover-news-links", {}, "collect")


@pytest.mark.asyncio
async def test_delegated_admin_preserves_arguments_without_database_init(monkeypatch, capsys):
    run = AsyncMock(return_value={"verified": True})
    monkeypatch.setattr("orsem_worker.admin_cli.run", run)
    monkeypatch.setattr(
        "orsem_worker.cli.load_environment", lambda: pytest.fail("Environment init")
    )
    await execute(
        SimpleNamespace(command="parser-corpus-audit", arguments=["--snapshot", "/tmp/x"])
    )
    run.assert_awaited_once_with("parser-corpus-audit", ["--snapshot", "/tmp/x"])
    assert '"verified":true' in capsys.readouterr().out


@pytest.mark.asyncio
async def test_delegated_admin_redacts_unexpected_exception(monkeypatch, capsys):
    monkeypatch.setattr(
        "orsem_worker.admin_cli.run", AsyncMock(side_effect=RuntimeError("secret-provider-key"))
    )
    with pytest.raises(SystemExit) as error:
        await execute(SimpleNamespace(command="parser-corpus-audit", arguments=[]))
    assert error.value.code == 1
    assert '"error":"OPERATION_FAILED"' in capsys.readouterr().out
