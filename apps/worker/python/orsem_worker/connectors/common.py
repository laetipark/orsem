"""Bounded transport, durable checkpoints and source-safe diagnostics."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import socket
import ssl
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit, urlunsplit

import httpx

from orsem_worker.core import decode_json, identifier, json_text, utcnow

MAX_METADATA_BYTES = 5 * 1024 * 1024


async def save_row(db, table, values, *, new=False):
    """Only internal table/column identifiers are accepted; every value is bound."""
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", table) or any(
        not re.fullmatch(r"[a-z_][a-z0-9_]*", key) for key in values
    ):
        raise ValueError("Invalid internal database identifier.")
    values = dict(values)
    for key, value in values.items():
        if key.endswith("_json") and value is not None:
            values[key] = json_text(value)
    if new:
        values.setdefault("id", identifier())
        values.setdefault("created_at", utcnow())
        values.setdefault("updated_at", utcnow())
        columns = ",".join(f"`{key}`" for key in values)
        params = ",".join(f":{key}" for key in values)
        await db.execute(f"INSERT INTO `{table}` ({columns}) VALUES ({params})", values)
    else:
        values.setdefault("updated_at", utcnow())
        await db.execute(
            f"UPDATE `{table}` SET "
            + ",".join(f"`{key}`=:{key}" for key in values if key != "id")
            + " WHERE id=:id",
            values,
        )
    return values["id"]


def decoded_row(row):
    if row is None:
        return None
    return {
        k: decode_json(v) if k.endswith("_json") and v is not None else v for k, v in row.items()
    }


def instant(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        return instant(dt)
    except ValueError:
        try:
            return instant(parsedate_to_datetime(value))
        except (TypeError, ValueError, OverflowError):
            return None


def iso(value=None):
    dt = instant(value) if value is not None else utcnow()
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z") if dt else None


def retry_after(value, now=None):
    now = now or utcnow()
    text = str(value or "").strip()
    try:
        result = now + timedelta(seconds=int(text)) if re.fullmatch(r"\d+", text) else instant(text)
        return result if result and result >= now else None
    except (ValueError, OverflowError):
        return None


class ConnectorRequestError(Exception):
    def __init__(
        self,
        connector,
        operation,
        http_status=0,
        cause=None,
        retry_at=None,
        provider_code=None,
        request_attempted=True,
    ):
        self.connector, self.operation = connector, operation
        self.httpStatus = self.status = http_status
        self.retryAt, self.providerCode = retry_at, provider_code
        self.requestAttempted = request_attempted
        self.transportCategory = (
            (
                "timeout"
                if isinstance(cause, (TimeoutError, httpx.TimeoutException))
                else "dns"
                if isinstance(cause, socket.gaierror)
                else "tls"
                if isinstance(cause, ssl.SSLError)
                else "connect"
                if isinstance(cause, (ConnectionError, httpx.ConnectError))
                else "network"
            )
            if not http_status
            else None
        )
        super().__init__(failure_message(self))


def failure_message(error):
    if isinstance(error, ConnectorRequestError):
        return (
            f"{error.connector} {error.operation} returned HTTP {error.httpStatus}."
            if error.httpStatus
            else f"{error.connector} {error.operation} transport failed ({error.transportCategory})."
        )
    if getattr(error, "connector", None) == "SEC":
        return str(error)
    return "Connector request failed safely."


def disallowed_address(address):
    value = address.strip("[]").lower()
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv4Address):
        a, b, _, _ = map(int, str(ip).split("."))
        return (
            a in (0, 10, 127)
            or a >= 224
            or (a == 100 and 64 <= b <= 127)
            or (a == 169 and b == 254)
            or (a == 172 and 16 <= b <= 31)
            or (a == 192 and b in (0, 168, 88))
            or (a == 198 and b in (18, 19, 51))
            or (a == 203 and b == 0)
        )
    if ip.ipv4_mapped:
        return disallowed_address(str(ip.ipv4_mapped))
    return (
        not ip.is_global
        or ip in ipaddress.ip_network("2002::/16")
        or ip in ipaddress.ip_network("64:ff9b::/96")
        or ip in ipaddress.ip_network("64:ff9b:1::/48")
        or int(ip) >> 32 == 0
    )


def public_url(value, *, https=False, allowed_hosts=None):
    if not isinstance(value, str) or len(value) > 16000 or re.search(r"[\x00-\x20]", value):
        raise ValueError("Invalid discovered URL.")
    url = urlsplit(value)
    host = (url.hostname or "").lower()
    if (
        url.scheme not in (("https",) if https else ("http", "https"))
        or not host
        or url.username
        or url.password
        or host == "localhost"
        or host.endswith(".localhost")
        or disallowed_address(host)
        or "%" in host
    ):
        raise ValueError("Discovered link uses a disallowed host or scheme.")
    if https and url.port not in (None, 443):
        raise ValueError("Feed requires standard HTTPS port.")
    if allowed_hosts is not None and host not in allowed_hosts:
        raise ValueError("Feed host is not approved.")
    return url


def decoded_response(response: httpx.Response, content: bytes) -> httpx.Response:
    """Rebuild a buffered response whose content was already decoded by HTTPX."""
    headers = httpx.Headers(response.headers)
    # aiter_bytes() has removed both content compression and transport framing.
    # Reusing their wire headers would decode twice or advertise the wrong size.
    for name in ("content-encoding", "content-length", "transfer-encoding"):
        headers.pop(name, None)
    return httpx.Response(
        response.status_code, headers=headers, content=content, request=response.request
    )


async def request_bytes(
    ctx,
    url,
    *,
    method="GET",
    headers=None,
    timeout_ms=None,
    max_bytes=MAX_METADATA_BYTES,
    json_body=None,
):
    timeout = (timeout_ms or ctx.config.httpTimeoutMs) / 1000
    async with asyncio.timeout(timeout):
        async with ctx.http.stream(
            method, url, headers=headers, json=json_body, timeout=timeout, follow_redirects=False
        ) as response:
            chunks, size = [], 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise ValueError("Connector response exceeded its size limit.")
                chunks.append(chunk)
            return decoded_response(response, b"".join(chunks))


async def fetch_json(
    ctx, connector, url, *, operation="metadata", headers=None, max_bytes=MAX_METADATA_BYTES
):
    try:
        response = (
            await ctx.services["sec_http"].request(url, headers=headers)
            if (urlsplit(url).hostname or "") in ("sec.gov", "www.sec.gov", "data.sec.gov")
            else await request_bytes(ctx, url, headers=headers, max_bytes=max_bytes)
        )
    except Exception as exc:
        if getattr(exc, "connector", None) == "SEC":
            raise
        raise ConnectorRequestError(connector, operation, cause=exc) from None
    if not response.is_success:
        raise ConnectorRequestError(
            connector,
            operation,
            response.status_code,
            retry_at=retry_after(response.headers.get("retry-after")),
        )
    try:
        return json.loads(response.content.decode("utf-8", errors="strict"))
    except (ValueError, UnicodeError):
        raise ConnectorRequestError(connector, operation, 0) from None


async def pinned_https_bytes(url, timeout_ms, max_bytes, headers=None):
    """Resolve once, reject every private answer, and retain the hostname for TLS/SNI.

    Direct sockets avoid a second DNS resolution between validation and connection.
    h11 handles HTTP framing and rejects invalid transfer encodings.
    """
    import h11

    parsed = public_url(url, https=True)
    host = parsed.hostname
    writer = None
    loop = asyncio.get_running_loop()
    deadline_at = loop.time() + timeout_ms / 1000
    async with asyncio.timeout_at(deadline_at):
        answers = await loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(str(row[4][0]) for row in answers))
        if not addresses or any(disallowed_address(address) for address in addresses):
            raise ValueError("Feed DNS resolved to a disallowed address.")
        tls = ssl.create_default_context()
        for index, address in enumerate(addresses):
            # Reserve time for the other validated answers when an address is
            # unreachable. DNS, every connection and HTTP share one deadline.
            remaining = deadline_at - loop.time()
            if remaining <= 0:
                raise TimeoutError("Feed request deadline expired.")
            connect_seconds = remaining / (len(addresses) - index)
            try:
                async with asyncio.timeout(connect_seconds):
                    reader, writer = await asyncio.open_connection(
                        address, 443, ssl=tls, server_hostname=host
                    )
                break
            except ssl.SSLError:
                raise
            except (OSError, TimeoutError):
                if index == len(addresses) - 1:
                    raise
        if writer is None:
            raise ConnectionError("Feed connection unavailable.")
        try:
            connection = h11.Connection(h11.CLIENT, max_incomplete_event_size=65536)
            values = {
                "Host": host,
                "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
                "Accept-Encoding": "identity",
                "User-Agent": "Orsem/1.0 RSS reader",
                "Connection": "close",
            }
            values.update(headers or {})
            if any("\r" in str(v) or "\n" in str(v) for v in values.values()):
                raise ValueError("Invalid feed request header.")
            path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
            writer.write(
                connection.send(
                    h11.Request(
                        method="GET",
                        target=path.encode("ascii"),
                        headers=[(k.encode(), str(v).encode()) for k, v in values.items()],
                    )
                )
            )
            writer.write(connection.send(h11.EndOfMessage()))
            await writer.drain()
            size, chunks, status, response_headers = 0, [], None, {}
            while True:
                event = connection.next_event()
                if event is h11.NEED_DATA:
                    data = await reader.read(min(65536, max_bytes + 1))
                    connection.receive_data(data)
                    if not data and status is None:
                        raise ValueError("Feed returned no response.")
                    continue
                if isinstance(event, h11.Response):
                    status = event.status_code
                    response_headers = {
                        k.decode().lower(): v.decode("latin1") for k, v in event.headers
                    }
                    if response_headers.get("content-encoding", "identity") not in ("identity", ""):
                        raise ValueError("Compressed feed response rejected.")
                elif isinstance(event, h11.Data):
                    size += len(event.data)
                    if size > max_bytes:
                        raise ValueError("Feed response exceeded its size limit.")
                    chunks.append(event.data)
                elif isinstance(event, h11.EndOfMessage):
                    if status is None:
                        raise ValueError("Feed returned no response status.")
                    return httpx.Response(
                        status,
                        headers=response_headers,
                        content=b"".join(chunks),
                        request=httpx.Request("GET", url),
                    )
                elif isinstance(event, h11.ConnectionClosed):
                    raise ValueError("Incomplete feed response.")  # noqa: TRY004 - preserve the deployed provider validation exception contract
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, ssl.SSLError):
                pass


class Checkpoints:
    def __init__(self, db):
        self.db = db

    async def load(self, connector, stream):
        row = await self.db.fetch_one(
            "SELECT metadata_json FROM source_checkpoints WHERE connector=:connector AND stream=:stream",
            {"connector": connector, "stream": stream},
        )
        metadata = decode_json(row.get("metadata_json"), {}) if row else {}
        return {"revision": int(metadata.get("revision", 0)), "metadata": metadata}

    async def locked(self, tx, connector, stream):
        params = {"id": identifier(), "connector": connector, "stream": stream}
        await tx.execute(
            "INSERT INTO source_checkpoints (id,connector,stream,created_at,updated_at) VALUES (:id,:connector,:stream,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE id=id",
            params,
        )
        row = await tx.fetch_one(
            "SELECT metadata_json FROM source_checkpoints WHERE connector=:connector AND stream=:stream FOR UPDATE",
            params,
        )
        if row is None:
            raise RuntimeError("Checkpoint lock unavailable.")
        return decode_json(row.get("metadata_json"), {})

    async def write(self, tx, connector, stream, metadata):
        await tx.execute(
            "UPDATE source_checkpoints SET metadata_json=:metadata,updated_at=UTC_TIMESTAMP(6) WHERE connector=:connector AND stream=:stream",
            {"connector": connector, "stream": stream, "metadata": json_text(metadata)},
        )

    async def commit(self, connector, stream, expected, metadata):
        async with self.db.transaction() as tx:
            old = await self.locked(tx, connector, stream)
            if int(old.get("revision", 0)) != expected:
                raise RuntimeError("Discovery checkpoint conflict; replay required.")
            await self.write(tx, connector, stream, {**old, **metadata, "revision": expected + 1})
            await tx.execute(
                "UPDATE source_checkpoints SET checkpoint_cursor=:cursor,last_success_at=CASE WHEN :complete=1 THEN UTC_TIMESTAMP(6) ELSE last_success_at END WHERE connector=:connector AND stream=:stream",
                {
                    "connector": connector,
                    "stream": stream,
                    "cursor": metadata.get("cursor"),
                    "complete": int(metadata.get("incomplete") is False),
                },
            )
