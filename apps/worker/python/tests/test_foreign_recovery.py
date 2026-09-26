"""Offline recovery regressions: issuer isolation and DNS-pinned feed fallback."""

import asyncio
import socket
import sqlite3
import ssl
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import orsem_worker.connectors.discovery as discovery_module
from orsem_worker.cli import SecCollection
from orsem_worker.config import load_config
from orsem_worker.connectors.common import ConnectorRequestError, pinned_https_bytes
from orsem_worker.connectors.discovery import Discovery
from orsem_worker.connectors.providers import SecSubmissions
from orsem_worker.connectors.sec_access import SecAccessCooldownError, SecAccessPolicyError
from orsem_worker.core import utcnow


def submissions(cik, *, history=False):
    return {
        "cik": int(cik),
        "name": "Synthetic issuer",
        "filings": {
            "recent": {
                "accessionNumber": [f"{cik}-26-000001"],
                "filingDate": ["2026-09-24"],
                "form": ["8-K"],
                "primaryDocument": ["filing.htm"],
            },
            "files": [{"name": f"CIK{cik}-submissions-001.json"}] if history else [],
        },
    }


def sec_discovery(monkeypatch, fetch):
    companies = [
        {"id": str(n), "cik": str(n).zfill(10), "market": "NASDAQ", "ticker": f"TEST{n}"}
        for n in (1, 2)
    ]
    ctx = SimpleNamespace(
        db=SimpleNamespace(),
        config=load_config(
            {"SEC_USER_AGENT": "Synthetic contact@example.com", "SEC_FORM4_ENABLED": "false"}
        ),
        services={},
    )
    discovery = Discovery(ctx)
    adapter = SecSubmissions(ctx)
    adapter.submission_file = AsyncMock(side_effect=fetch)
    discovery.adapters = lambda _: [adapter]
    discovery.load_companies = AsyncMock(return_value=companies)
    discovery.sec_scopes = AsyncMock(return_value=[[c] for c in companies])
    discovery.persist = AsyncMock(return_value=True)
    discovery.record = AsyncMock()
    discovery.store = SimpleNamespace(
        load=AsyncMock(return_value={"revision": 0, "metadata": {}}), commit=AsyncMock()
    )
    monkeypatch.setattr(discovery_module, "save_row", AsyncMock())
    return discovery, adapter


SEC_JOB = {"connectors": ["SEC"], "reason": "SCHEDULED", "priorities": ["P1", "P2"]}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [ValueError("invalid source row"), ConnectorRequestError("SEC", "submissions", 503)]
)
async def test_sec_bad_issuer_does_not_starve_later_issuer(monkeypatch, failure):
    async def fetch(cik, filename=None):
        if cik == "0000000001":
            raise failure
        return submissions(cik)

    discovery, adapter = sec_discovery(monkeypatch, fetch)
    result = await discovery.discover(SEC_JOB)

    assert adapter.submission_file.await_count == 2
    assert discovery.persist.await_count == 1
    assert discovery.store.commit.await_args.args[1] == "SUBMISSIONS:CIK:0000000002"
    assert result[0]["status"] == "DEGRADED" and result[0]["created"] == 1
    recorded = discovery.record.await_args.kwargs
    assert recorded["success"] is False
    assert recorded["metadata"]["submissionsStatus"] == "DEGRADED"
    assert recorded["metadata"]["issuerFailureCount"] == 1
    assert recorded["metadata"]["failedIssuers"][0]["cik"] == "0000000001"


@pytest.mark.asyncio
async def test_sec_history_error_keeps_committed_cursor_and_other_issuer_progress(monkeypatch):
    async def fetch(cik, filename=None):
        if filename:
            raise ValueError("invalid history row")
        return submissions(cik, history=cik == "0000000001")

    discovery, _adapter = sec_discovery(monkeypatch, fetch)
    result = await discovery.discover(SEC_JOB)
    commits = discovery.store.commit.await_args_list
    assert len(commits) == 2 and discovery.persist.await_count == 2
    assert commits[0].args[3]["pendingFiles"] == ["CIK0000000001-submissions-001.json"]
    assert commits[0].args[3]["baselineComplete"] is False
    assert commits[1].args[3]["baselineComplete"] is True
    assert result[0]["status"] == "DEGRADED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        SecAccessCooldownError(utcnow(), 403),
        SecAccessPolicyError(),
        ConnectorRequestError("SEC", "submissions", 429),
        RuntimeError("checkpoint storage unavailable"),
    ],
)
async def test_sec_shared_failure_stops_remaining_issuers(monkeypatch, failure):
    discovery, adapter = sec_discovery(monkeypatch, AsyncMock(side_effect=failure))
    result = await discovery.discover(SEC_JOB)
    assert adapter.submission_file.await_count == 1
    assert discovery.persist.await_count == 0
    assert result[0]["status"] == "DEGRADED"
    assert "issuerFailureCount" not in discovery.record.await_args.kwargs["metadata"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", [ValueError("invalid storage value"), RuntimeError("DB unavailable")]
)
async def test_sec_persistence_failure_is_not_issuer_local(monkeypatch, failure):
    discovery, adapter = sec_discovery(monkeypatch, submissions)
    discovery.store.commit.side_effect = failure
    result = await discovery.discover(SEC_JOB)
    assert adapter.submission_file.await_count == 1
    assert result[0]["status"] == "DEGRADED"
    assert "issuerFailureCount" not in discovery.record.await_args.kwargs["metadata"]


@pytest.mark.asyncio
async def test_sec_invalid_stored_checkpoint_stops_before_provider_io(monkeypatch):
    discovery, adapter = sec_discovery(monkeypatch, submissions)
    discovery.store.load.side_effect = ValueError("invalid stored revision")
    result = await discovery.discover(SEC_JOB)
    adapter.submission_file.assert_not_awaited()
    assert discovery.store.load.await_count == 1
    assert result[0]["status"] == "DEGRADED"
    assert "issuerFailureCount" not in discovery.record.await_args.kwargs["metadata"]


class Writer:
    def __init__(self):
        self.sent = b""
        self.closed = False

    def write(self, data):
        self.sent += data

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass


def pinned_dns(monkeypatch, addresses):
    lookup = AsyncMock(
        return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses
        ]
    )
    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", lookup)
    return lookup


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [OSError("network unreachable"), TimeoutError()])
async def test_feed_falls_back_to_validated_address_with_original_sni(monkeypatch, failure):
    dns = pinned_dns(monkeypatch, ["2606:4700:4700::1111", "1.1.1.1", "1.1.1.1"])
    writer = Writer()
    reader = SimpleNamespace(
        read=AsyncMock(return_value=b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nfeed")
    )
    connect = AsyncMock(side_effect=[failure, (reader, writer)])
    monkeypatch.setattr(asyncio, "open_connection", connect)

    response = await pinned_https_bytes("https://publisher.example/rss", 1000, 100)

    assert response.content == b"feed" and dns.await_count == 1
    assert [call.args[0] for call in connect.await_args_list] == ["2606:4700:4700::1111", "1.1.1.1"]
    assert all(
        call.kwargs["server_hostname"] == "publisher.example" for call in connect.await_args_list
    )
    assert all(call.kwargs["ssl"].check_hostname for call in connect.await_args_list)
    assert writer.closed and b"Host: publisher.example" in writer.sent


@pytest.mark.asyncio
async def test_feed_rejects_private_dns_answer_before_any_connection(monkeypatch):
    pinned_dns(monkeypatch, ["1.1.1.1", "127.0.0.1"])
    connect = AsyncMock()
    monkeypatch.setattr(asyncio, "open_connection", connect)
    with pytest.raises(ValueError, match="disallowed address"):
        await pinned_https_bytes("https://publisher.example/rss", 1000, 100)
    connect.assert_not_awaited()


@pytest.mark.asyncio
async def test_feed_does_not_retry_tls_verification_failure(monkeypatch):
    pinned_dns(monkeypatch, ["1.1.1.1", "8.8.8.8"])
    connect = AsyncMock(side_effect=ssl.SSLCertVerificationError("certificate mismatch"))
    monkeypatch.setattr(asyncio, "open_connection", connect)
    with pytest.raises(ssl.SSLCertVerificationError):
        await pinned_https_bytes("https://publisher.example/rss", 1000, 100)
    assert connect.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [302, 429, 503])
async def test_feed_http_response_is_never_retried_on_another_address(monkeypatch, status):
    pinned_dns(monkeypatch, ["1.1.1.1", "8.8.8.8"])
    writer = Writer()
    reader = SimpleNamespace(
        read=AsyncMock(
            return_value=f"HTTP/1.1 {status} Failure\r\nContent-Length: 0\r\n\r\n".encode()
        )
    )
    connect = AsyncMock(return_value=(reader, writer))
    monkeypatch.setattr(asyncio, "open_connection", connect)
    assert (
        await pinned_https_bytes("https://publisher.example/rss", 1000, 100)
    ).status_code == status
    assert connect.await_count == 1 and writer.closed


@pytest.mark.asyncio
async def test_feed_read_failure_is_not_retried(monkeypatch):
    pinned_dns(monkeypatch, ["1.1.1.1", "8.8.8.8"])
    writer = Writer()
    reader = SimpleNamespace(read=AsyncMock(side_effect=ConnectionResetError()))
    connect = AsyncMock(return_value=(reader, writer))
    monkeypatch.setattr(asyncio, "open_connection", connect)
    with pytest.raises(ConnectionResetError):
        await pinned_https_bytes("https://publisher.example/rss", 1000, 100)
    assert connect.await_count == 1 and writer.closed


@pytest.mark.asyncio
async def test_feed_address_attempts_share_total_deadline(monkeypatch):
    dns = pinned_dns(monkeypatch, ["1.1.1.1", "8.8.8.8"])
    calls = []

    async def connect(address, *args, **kwargs):
        calls.append(address)
        await asyncio.sleep(1)

    monkeypatch.setattr(asyncio, "open_connection", connect)
    started = asyncio.get_running_loop().time()
    with pytest.raises(TimeoutError):
        await pinned_https_bytes("https://publisher.example/rss", 100, 100)
    assert calls == ["1.1.1.1", "8.8.8.8"] and dns.await_count == 1
    assert asyncio.get_running_loop().time() - started < 0.3


@pytest.mark.asyncio
async def test_sec_cli_scope_includes_authorized_groups_and_preserves_existing_sources():
    # Execute the scope query, changing only MySQL date/binary syntax for this
    # isolated SQLite fixture; no application database or credentials are used.
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.create_function("CONCAT", -1, lambda *values: "".join(str(v) for v in values))
    db.create_function(
        "SUBSTRING_INDEX", 3, lambda value, separator, count: value.split(separator)[-1]
    )
    db.executescript("""
        CREATE TABLE companies (id TEXT, ticker TEXT, name_ko TEXT, cik TEXT, is_listed INTEGER, market TEXT);
        CREATE TABLE watchlist_groups (id TEXT, owner_key TEXT, room_id TEXT);
        CREATE TABLE watchlist_group_items (group_id TEXT, company_id TEXT);
        CREATE TABLE watchlist_rooms (id TEXT, owner_key TEXT);
        CREATE TABLE admins (id TEXT, is_active INTEGER);
        CREATE TABLE members (id TEXT, role TEXT, status TEXT);
        CREATE TABLE market_leader_company_links (company_id TEXT, priority TEXT);
        CREATE TABLE ir_sources (company_id TEXT, is_active INTEGER);
        CREATE TABLE source_checkpoints (connector TEXT, stream TEXT, last_success_at TEXT);
        INSERT INTO admins VALUES ('active',1),('inactive',0);
        INSERT INTO members VALUES ('approved','VIEWER','APPROVED'),('pending','VIEWER','PENDING');
        INSERT INTO watchlist_rooms VALUES ('room','MEMBER:approved');
        INSERT INTO watchlist_groups VALUES
          ('admin','ADMIN:active',NULL),('member','MEMBER:approved',NULL),
          ('inactive','ADMIN:inactive',NULL),('pending','MEMBER:pending',NULL),
          ('orphan','ADMIN:active','missing'),('shared','ADMIN:inactive','room');
        INSERT INTO market_leader_company_links VALUES ('leader','P1');
        INSERT INTO ir_sources VALUES ('ir',1);
        INSERT INTO source_checkpoints VALUES ('TOSS','PRICE_BARS:1d:toss',datetime('now'));
    """)
    ids = [
        "admin",
        "member",
        "inactive",
        "pending",
        "orphan",
        "shared",
        "leader",
        "ir",
        "toss",
        "delisted",
        "kr",
    ]
    db.executemany(
        "INSERT INTO companies VALUES (?,?,?,?,?,?)",
        [
            (key, key, key, "0000000001", key != "delisted", "KOSPI" if key == "kr" else "NASDAQ")
            for key in ids
        ],
    )
    db.executemany(
        "INSERT INTO watchlist_group_items VALUES (?,?)",
        [(key, key) for key in ids[:6]] + [("admin", "delisted"), ("admin", "kr")],
    )

    async def fetch_all(query):
        query = query.replace("UTC_TIMESTAMP()-INTERVAL 1 DAY", "datetime('now','-1 day')")
        query = query.replace(" AS BINARY", " AS TEXT")
        return [dict(row) for row in db.execute(query)]

    try:
        collector = SecCollection(SimpleNamespace(db=SimpleNamespace(fetch_all=fetch_all)))
        assert {row["id"] for row in await collector.load_scope()} == {
            "admin",
            "member",
            "shared",
            "leader",
            "ir",
            "toss",
        }
    finally:
        db.close()
