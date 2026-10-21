"""Buffered HTTP responses decode compression once, without external requests."""

import gzip
import json
import zlib

import httpx
import pytest
from test_connectors import context

from orsem_worker.connectors.common import request_bytes
from orsem_worker.connectors.sec_access import SecAccessCooldownError, SecHttp


class WireChunks(httpx.AsyncByteStream):
    def __init__(self, content):
        self.content = content

    async def __aiter__(self):
        for offset in range(0, len(self.content), 7):
            yield self.content[offset : offset + 7]


def encoded(content, encoding):
    if encoding == "gzip":
        return gzip.compress(content)
    if encoding == "deflate":
        return zlib.compress(content)
    return content


def setup_response(content, encoding, *, status=200, transfer=False):
    wire = encoded(content, encoding)
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": encoding,
        "ETag": '"synthetic-v1"',
        "Last-Modified": "Fri, 09 Oct 2026 00:00:00 GMT",
        "Retry-After": "600",
    }
    headers["Transfer-Encoding" if transfer else "Content-Length"] = (
        "chunked" if transfer else str(len(wire))
    )
    received, responses = [], []

    def handle(request):
        received.append(request)
        response = httpx.Response(status, headers=headers, stream=WireChunks(wire))
        responses.append(response)
        return response

    ctx = context(
        {"SEC_USER_AGENT": "Synthetic Collector contact@example.com"},
        httpx.MockTransport(handle),
    )
    return ctx, received, responses


async def request(ctx, provider, *, max_bytes=1024):
    if provider == "SEC":
        return await SecHttp(ctx).request("https://data.sec.gov/fixture", max_bytes=max_bytes)
    return await request_bytes(ctx, "https://publisher.example/fixture", max_bytes=max_bytes)


@pytest.mark.parametrize("provider", ["SEC", "COMMON"])
@pytest.mark.parametrize("encoding", ["gzip", "deflate", "identity"])
@pytest.mark.parametrize("transfer", [False, True])
async def test_buffered_response_is_decoded_once(provider, encoding, transfer):
    payload = {"cik": 320193, "name": "압축 응답"}
    content = json.dumps(payload, ensure_ascii=False).encode()
    ctx, received, originals = setup_response(content, encoding, transfer=transfer)
    try:
        response = await request(ctx, provider)
        assert len(received) == 1
        assert response.status_code == 200
        assert response.request is received[0]
        assert response.content == content
        assert response.json() == payload
        assert "content-encoding" not in response.headers
        assert "transfer-encoding" not in response.headers
        assert response.headers["content-length"] == str(len(content))
        for header in ("content-type", "etag", "last-modified", "retry-after"):
            assert response.headers[header] == originals[0].headers[header]
        assert originals[0].headers["content-encoding"] == encoding
        if provider == "SEC":
            assert received[0].headers["user-agent"] == ctx.config.secUserAgent
    finally:
        await ctx.http.aclose()


@pytest.mark.parametrize("provider", ["SEC", "COMMON"])
async def test_compressed_response_limit_applies_to_decoded_bytes(provider):
    content = b"x" * 2048
    assert len(gzip.compress(content)) < 128
    ctx, received, _ = setup_response(content, "gzip")
    try:
        with pytest.raises(ValueError, match="response exceeded its size limit"):
            await request(ctx, provider, max_bytes=128)
        assert len(received) == 1
    finally:
        await ctx.http.aclose()


@pytest.mark.parametrize("provider", ["SEC", "COMMON"])
async def test_invalid_compression_fails_without_retry(provider):
    ctx, received, _ = setup_response(b"invalid gzip", "identity")

    async def change_encoding(response):
        response.headers["content-encoding"] = "gzip"

    ctx.http.event_hooks["response"] = [change_encoding]
    try:
        with pytest.raises(httpx.DecodingError):
            await request(ctx, provider)
        assert len(received) == 1
    finally:
        await ctx.http.aclose()


@pytest.mark.parametrize("status", [403, 429])
async def test_compressed_sec_denial_preserves_shared_cooldown(status):
    ctx, received, _ = setup_response(b"undeclared automated tool", "gzip", status=status)
    try:
        with pytest.raises(SecAccessCooldownError) as first:
            await request(ctx, "SEC")
        assert first.value.httpStatus == status
        assert first.value.requestAttempted
        if status == 403:
            assert first.value.providerCode == "SEC_UNDECLARED_AUTOMATION"
        with pytest.raises(SecAccessCooldownError) as second:
            await request(ctx, "SEC")
        assert not second.value.requestAttempted
        assert len(received) == 1
        assert ctx.db.states[("SEC", "ACCESS_COOLDOWN")]["consecutiveFailures"] == 1
    finally:
        await ctx.http.aclose()
