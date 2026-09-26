"""Authentication refusals must stop every Toss caller without exposing response data."""

import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from orsem_worker.market.live import LiveQuotes
from orsem_worker.market.toss import TossAccessBlocked, TossAuthCoolingDown, TossClient


class Redis:
    def __init__(self):
        self.values = {}
        self.options = {}

    async def get(self, key):
        return self.values.get(key)

    async def set(self, key, value, **options):
        if options.get("nx") and key in self.values:
            return None
        self.values[key] = value
        self.options[key] = options
        return True

    async def eval(self, script, count, key, *args):
        if "next-now" in script:
            return 0
        old = self.values.get(key)
        if ".token==ARGV[1]" in script:
            if old and json.loads(old)["token"] == args[0]:
                self.values.pop(key, None)
                return 1
        elif old == args[0]:
            self.values.pop(key, None)
            return 1
        return 0


def context(http, redis=None, **config):
    return SimpleNamespace(
        http=http,
        redis=redis or Redis(),
        config=SimpleNamespace(
            **{
                "redisPrefix": "test:",
                "tossClientId": "synthetic-client",
                "tossClientSecret": "synthetic-secret",
                "marketDataProvider": "toss",
                "httpTimeoutMs": 1000,
                "tossMaxSubscriptions": 100,
                **config,
            }
        ),
    )


def seed_token(client, token="synthetic-token"):
    client.ctx.redis.values[client.token_key] = json.dumps(
        {"token": token, "expiresAt": time.time() * 1000 + 3600_000}
    )


@pytest.mark.parametrize(
    "status,body,reason",
    [
        (403, {"error": "access_denied"}, "ip-not-allowed"),
        (401, {"error": "invalid_client"}, "invalid-client"),
        (400, {"error": "unauthorized_client"}, "invalid-client"),
        (400, {"error": "invalid_grant"}, "invalid-client"),
        (400, {"error": "access_denied"}, "access-forbidden"),
    ],
)
@pytest.mark.asyncio
async def test_oauth_refusal_blocks_repeated_and_restarted_clients(status, body, reason, caplog):
    calls = []

    def respond(request):
        calls.append(request.url.path)
        return httpx.Response(status, json={**body, "error_description": "secret-response-marker"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        ctx = context(http)
        client = TossClient(ctx)
        for caller in (client, client, TossClient(ctx)):
            with pytest.raises(TossAccessBlocked) as error:
                await caller.access_token()
            assert error.value.reason == reason
        assert calls == ["/oauth2/token"]
        assert ctx.redis.values[client.access_block_key] == reason
        assert "secret-response-marker" not in caplog.text
        assert "synthetic-secret" not in caplog.text
        assert "synthetic-client" not in caplog.text
        assert "WTS Open API allowed IPs" in caplog.text


@pytest.mark.asyncio
async def test_rest_403_stops_cached_token_calls_and_recovers_only_after_marker_clear_and_restart():
    calls = []
    status = 403

    def respond(request):
        calls.append(request.url.path)
        return httpx.Response(status, json={"error": {"code": "forbidden"}, "result": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        ctx = context(http)
        client = TossClient(ctx)
        seed_token(client)
        for caller in (client, TossClient(ctx)):
            with pytest.raises(TossAccessBlocked, match="access-forbidden"):
                await caller.get("/api/v1/stocks", {"symbols": "A"})
        assert calls == ["/api/v1/stocks"]
        assert client.token_key in ctx.redis.values  # Do not revoke a valid token for IP refusal.
        ctx.redis.values.pop(client.access_block_key)
        with pytest.raises(TossAccessBlocked):
            await client.access_token()
        status = 200
        await TossClient(ctx).get("/api/v1/stocks", {"symbols": "A"})
        assert calls == ["/api/v1/stocks", "/api/v1/stocks"]


@pytest.mark.asyncio
async def test_persistent_401_refreshes_once_then_cools_all_rest_calls():
    calls = []

    def respond(request):
        calls.append(request.url.path)
        if request.url.path == "/oauth2/token":
            return httpx.Response(
                200,
                json={"access_token": "new-token", "token_type": "Bearer", "expires_in": 3600},
            )
        return httpx.Response(401)

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        ctx = context(http)
        client = TossClient(ctx)
        seed_token(client)
        for caller in (client, TossClient(ctx)):
            with pytest.raises(TossAuthCoolingDown):
                await caller.get("/api/v1/stocks", {"symbols": "A"})
        assert calls == ["/api/v1/stocks", "/oauth2/token", "/api/v1/stocks"]
        assert client.access_block_key not in ctx.redis.values
        assert ctx.redis.options[client.auth_cooldown_key]["ex"] == 300
        # The actual Redis key expires after five minutes; a new process can retry then.
        ctx.redis.values.pop(client.auth_cooldown_key)
        await TossClient(ctx).ensure_access()


def socket_failure(monkeypatch, status):
    attempts = []

    class RejectedConnection:
        async def __aenter__(self):
            error = RuntimeError("secret-handshake-response")
            error.response = SimpleNamespace(status_code=status)
            raise error

        async def __aexit__(self, *args):
            return False

    def connect(*args, **kwargs):
        attempts.append(True)
        return RejectedConnection()

    monkeypatch.setattr("websockets.asyncio.client.connect", connect)
    return attempts


def live_quotes(ctx, client):
    scope = {"companyId": "synthetic-company", "symbol": "A", "region": "us", "currency": "USD"}
    live = LiveQuotes(ctx, client, SimpleNamespace(scope=AsyncMock(return_value=[scope])))
    live.lease = True
    return live


@pytest.mark.asyncio
async def test_websocket_403_stops_reconnect_and_other_rest_clients(monkeypatch, caplog):
    attempts = socket_failure(monkeypatch, 403)
    ctx = context(None)
    client = TossClient(ctx)
    seed_token(client)
    live = live_quotes(ctx, client)
    await live.connect()
    await live.connect()
    with pytest.raises(TossAccessBlocked, match="ip-not-allowed"):
        await TossClient(ctx).get("/api/v1/prices", {"symbols": "A"})
    await live.maintain_lease()
    assert live.lease is False and live.connection_task is None
    assert attempts == [True]
    assert "secret-handshake-response" not in caplog.text


@pytest.mark.asyncio
async def test_websocket_401_refresh_is_bounded_before_shared_refusal(monkeypatch):
    attempts = socket_failure(monkeypatch, 401)
    ctx = context(None)
    client = TossClient(ctx)
    seed_token(client)
    live = live_quotes(ctx, client)
    await live.connect()
    assert client.token_key not in ctx.redis.values
    assert client.access_block_key not in ctx.redis.values
    seed_token(client, "refreshed-token")
    await live.connect()
    await live.connect()
    assert attempts == [True, True]
    assert ctx.redis.values[client.auth_cooldown_key] == "authentication-cooldown"
    assert client.access_block_key not in ctx.redis.values
    assert live.auth_refreshed is False


@pytest.mark.asyncio
async def test_refused_rest_snapshot_immediately_closes_existing_websocket():
    ctx = context(None)
    client = TossClient(ctx)
    client.prices = AsyncMock(side_effect=TossAccessBlocked("access-forbidden"))
    live = live_quotes(ctx, client)
    socket = SimpleNamespace(close=AsyncMock())
    live.socket = socket
    with pytest.raises(TossAccessBlocked):
        await live.initial_snapshot([])
    assert live.socket is None
    socket.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_access_blocks_are_scoped_to_credentials_and_installation():
    redis = Redis()
    client = TossClient(context(None, redis))
    with pytest.raises(TossAccessBlocked):
        await client.block_access("ip-not-allowed")
    for config in ({"tossClientSecret": "rotated-secret"}, {"redisPrefix": "other:"}):
        await TossClient(context(None, redis, **config)).ensure_access()
    # Redis may return bytes; corrupted marker values must remain safely blocked.
    redis.values[client.access_block_key] = b"untrusted-provider-message"
    with pytest.raises(TossAccessBlocked, match="access-check-required"):
        await TossClient(client.ctx).ensure_access()


@pytest.mark.asyncio
async def test_request_waiting_for_pacing_observes_another_callers_refusal():
    # The cached token was acquired before another REST/WS caller set the shared marker.
    ctx = context(None)
    client = TossClient(ctx)
    seed_token(client)

    async def pace(_):
        ctx.redis.values[client.access_block_key] = "ip-not-allowed"

    client.pace = pace
    with pytest.raises(TossAccessBlocked, match="ip-not-allowed"):
        await client.get("/api/v1/prices", {"symbols": "A"})


@pytest.mark.asyncio
async def test_failed_marker_persistence_still_blocks_this_process(caplog):
    ctx = context(None)
    ctx.redis.set = AsyncMock(side_effect=RuntimeError("secret-storage-error"))
    client = TossClient(ctx)
    with pytest.raises(TossAccessBlocked):
        await client.block_access("ip-not-allowed")
    with pytest.raises(TossAccessBlocked):
        await client.access_token()
    assert "secret-storage-error" not in caplog.text


@pytest.mark.asyncio
async def test_transient_http_failure_does_not_latch_access(monkeypatch):
    async def sleep(_):
        pass

    monkeypatch.setattr("orsem_worker.market.toss.asyncio.sleep", sleep)
    calls = []

    def respond(request):
        calls.append(request.url.path)
        return httpx.Response(503 if len(calls) == 1 else 200, json={"result": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        ctx = context(http)
        client = TossClient(ctx)
        seed_token(client)
        assert await client.get("/api/v1/stocks", {"symbols": "A"}) == {"result": []}
        assert client.access_block_key not in ctx.redis.values
        assert len(calls) == 2
