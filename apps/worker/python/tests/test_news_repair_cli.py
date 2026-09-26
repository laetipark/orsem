"""The targeted repair command is explicit, bounded, and redacts unexpected errors."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from orsem_worker.admin_cli.common import AdminError
from orsem_worker.cli import execute, parser

ARGS = [
    "news-repair",
    "--company-ids",
    "00000000-0000-4000-8000-000000000001",
    "--output-dir",
    "/tmp/orsem-synthetic-news-repair",
]


def test_news_repair_requires_scope_output_and_explicit_apply():
    parsed = parser().parse_args(ARGS)
    assert not parsed.apply and parsed.max_sources == 1000
    assert parser().parse_args([*ARGS, "--apply"]).apply
    for arguments in (
        ["news-repair"],
        ["news-repair", "--company-ids", "synthetic"],
        ["news-repair", "--output-dir", "/tmp/synthetic"],
        [*ARGS, "--apply", "--dry-run"],
    ):
        with pytest.raises(SystemExit):
            parser().parse_args(arguments)


def test_news_repair_rollback_requires_artifacts_and_explicit_apply():
    arguments = [
        "news-repair-rollback",
        "--repair-dir",
        "/tmp/synthetic-repair",
        "--output-dir",
        "/tmp/synthetic-rollback",
    ]
    assert parser().parse_args(arguments).apply is False
    assert parser().parse_args([*arguments, "--apply"]).apply is True
    with pytest.raises(SystemExit):
        parser().parse_args(["news-repair-rollback", "--apply"])
    with pytest.raises(SystemExit):
        parser().parse_args([*arguments, "--apply", "--dry-run"])


def repair_context(monkeypatch):
    config = SimpleNamespace(databaseUrl="synthetic", redisUrl="synthetic", httpTimeoutMs=1000)
    ctx = SimpleNamespace(db=object(), close=AsyncMock())
    monkeypatch.setenv("DATABASE_URL", "synthetic")
    monkeypatch.setattr("orsem_worker.cli.load_environment", lambda: None)
    monkeypatch.setattr("orsem_worker.cli.load_config", lambda: config)
    monkeypatch.setattr("orsem_worker.cli.Database.from_url", lambda _: ctx.db)
    monkeypatch.setattr("orsem_worker.cli.Redis.from_url", lambda *a, **kw: None)
    monkeypatch.setattr("orsem_worker.cli.httpx.AsyncClient", lambda **kw: None)
    monkeypatch.setattr("orsem_worker.cli.RuntimeContext", lambda *args: ctx)
    return ctx


@pytest.mark.asyncio
@pytest.mark.parametrize("apply", [False, True])
async def test_news_repair_passes_explicit_scope_budget_and_mode(monkeypatch, capsys, apply):
    ctx = repair_context(monkeypatch)
    repair = AsyncMock(return_value={"mode": "APPLY" if apply else "DRY_RUN", "scanned": 0})
    monkeypatch.setattr("orsem_worker.connectors.news_repair.repair_news_company_links", repair)
    args = parser().parse_args([*ARGS, "--max-sources", "25", *(["--apply"] if apply else [])])
    await execute(args)
    repair.assert_awaited_once_with(
        ctx.db, args.company_ids, args.output_dir, apply=apply, max_sources=25
    )
    ctx.close.assert_awaited_once()
    assert '"scanned":0' in capsys.readouterr().out


@pytest.mark.asyncio
@pytest.mark.parametrize("apply", [False, True])
async def test_news_repair_rollback_dispatches_to_guarded_helper(monkeypatch, apply):
    ctx = repair_context(monkeypatch)
    rollback = AsyncMock(return_value={"applied": apply})
    monkeypatch.setattr("orsem_worker.connectors.news_repair.rollback_news_company_links", rollback)
    args = parser().parse_args(
        [
            "news-repair-rollback",
            "--repair-dir",
            "/tmp/synthetic-repair",
            "--output-dir",
            "/tmp/synthetic-rollback",
            *(["--apply"] if apply else []),
        ]
    )
    await execute(args)
    rollback.assert_awaited_once_with(ctx.db, args.repair_dir, args.output_dir, apply=apply)
    ctx.close.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (AdminError("NEWS_REPAIR_SOURCE_LIMIT"), "NEWS_REPAIR_SOURCE_LIMIT"),
        (RuntimeError("credential-bearing-database-error"), "OPERATION_FAILED"),
    ],
)
async def test_news_repair_exposes_only_safe_error_codes(monkeypatch, capsys, failure, code):
    ctx = repair_context(monkeypatch)
    monkeypatch.setattr(
        "orsem_worker.connectors.news_repair.repair_news_company_links",
        AsyncMock(side_effect=failure),
    )
    with pytest.raises(SystemExit) as stopped:
        await execute(parser().parse_args(ARGS))
    assert stopped.value.code == 1
    output = capsys.readouterr().out
    assert f'"error":"{code}"' in output and "credential-bearing" not in output
    ctx.close.assert_awaited_once()
