"""SEC's shared, fail-closed request pacing and cooldown recovery policy."""

import asyncio
import logging
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

from orsem_worker.core import identifier, utcnow

from .common import Checkpoints, instant, iso, request_bytes, retry_after

SEC_HOSTS = frozenset(("sec.gov", "www.sec.gov", "data.sec.gov"))
STREAM = "ACCESS_COOLDOWN"


class SecAccessCooldownError(Exception):
    connector = "SEC"
    operation = "access-cooldown"

    def __init__(self, retry_at, provider_status, request_attempted=False, provider_code=None):
        self.retryAt, self.providerStatus = retry_at, provider_status
        self.status = self.httpStatus = provider_status
        self.requestAttempted, self.providerCode = request_attempted, provider_code
        super().__init__(
            (
                "SEC 접근이 거부되었습니다(403)."
                if provider_status == 403
                else "SEC 요청 빈도 제한입니다(429)."
            )
            + (
                " 응답을 확인했습니다."
                if request_attempted
                else " 대기 중이므로 요청을 보내지 않았습니다."
            )
        )


class SecAccessPolicyError(Exception):
    connector, httpStatus = "SEC", 0

    def __init__(self):
        super().__init__("SEC 접근 대기 상태를 확인하거나 저장하지 못했습니다.")


def cooldown(metadata):
    retry = instant(metadata.get("retryAt"))
    if not retry:
        return None
    code = metadata.get("providerCode")
    return {
        "retryAt": retry,
        "providerStatus": 429 if metadata.get("providerStatus") == 429 else 403,
        "providerCode": code
        if code in ("SEC_UNDECLARED_AUTOMATION", "SEC_RATE_LIMIT", "SEC_ACCESS_DENIED")
        else None,
    }


def failures(metadata):
    value = metadata.get("consecutiveFailures")
    return (
        value
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
        else int(cooldown(metadata) is not None)
    )


def later(left, right):
    if not left:
        return right
    if not right:
        return left
    return left if left["retryAt"] >= right["retryAt"] else right


def retry_time(header, now, consecutive=1):
    return max(
        now + timedelta(minutes=min(360, 10 * 2 ** min(max(0, consecutive - 1), 6))),
        retry_after(header, now) or now,
    )


def assert_not_cooling(value):
    if value and value["retryAt"] > utcnow():
        raise SecAccessCooldownError(
            value["retryAt"], value["providerStatus"], False, value["providerCode"]
        )


class SecHttp:
    def __init__(self, ctx):
        self.ctx, self.store = ctx, Checkpoints(ctx.db)
        self.lock = asyncio.Lock()
        self.local_cooldown = None
        self.next_at = utcnow()

    async def request(
        self, url, headers=None, timeout_ms=None, max_bytes=5 * 1024 * 1024, method="GET"
    ):
        if urlsplit(url).hostname not in SEC_HOSTS or method.upper() != "GET":
            return await request_bytes(
                self.ctx,
                url,
                method=method,
                headers=headers,
                timeout_ms=timeout_ms,
                max_bytes=max_bytes,
            )
        async with self.lock:
            lease: dict[str, Any] | None = None
            try:
                try:
                    state = (await self.store.load("SEC", STREAM))["metadata"]
                    assert_not_cooling(later(self.local_cooldown, cooldown(state)))
                    async with self.ctx.db.transaction() as tx:
                        metadata = await self.store.locked(tx, "SEC", STREAM)
                        assert_not_cooling(cooldown(metadata))
                        now = utcnow()
                        slot = max(now, instant(metadata.get("nextRequestAt")) or now, self.next_at)
                        if (slot - now).total_seconds() > 5:
                            raise SecAccessPolicyError()
                        await self.store.write(
                            tx,
                            "SEC",
                            STREAM,
                            {**metadata, "nextRequestAt": iso(slot + timedelta(seconds=1))},
                        )
                except SecAccessCooldownError:
                    raise
                except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                    assert_not_cooling(self.local_cooldown)
                    raise SecAccessPolicyError() from None
                await asyncio.sleep(max(0, (slot - utcnow()).total_seconds()))
                try:
                    async with self.ctx.db.transaction() as tx:
                        metadata = await self.store.locked(tx, "SEC", STREAM)
                        current = cooldown(metadata)
                        assert_not_cooling(current)
                        held_until = instant(metadata.get("recoveryExpiresAt"))
                        if metadata.get("recoveryOwner") and held_until and held_until > utcnow():
                            raise SecAccessCooldownError(
                                held_until,
                                (current or {}).get("providerStatus", 403),
                                False,
                                (current or {}).get("providerCode"),
                            )
                        started_failures, failure_id = (
                            failures(metadata),
                            metadata.get("lastFailureId"),
                        )
                        if started_failures:
                            lease = {
                                "owner": identifier(),
                                "expiresAt": utcnow() + timedelta(seconds=30),
                            }
                            await self.store.write(
                                tx,
                                "SEC",
                                STREAM,
                                {
                                    **metadata,
                                    "recoveryOwner": lease["owner"],
                                    "recoveryExpiresAt": iso(lease["expiresAt"]),
                                },
                            )
                except SecAccessCooldownError:
                    raise
                except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                    raise SecAccessPolicyError() from None
                self.next_at = utcnow() + timedelta(seconds=1)
                timeout = (timeout_ms or self.ctx.config.httpTimeoutMs) / 1000
                if lease:
                    timeout = min(timeout, max(0, (lease["expiresAt"] - utcnow()).total_seconds()))
                async with asyncio.timeout(timeout):
                    async with self.ctx.http.stream(
                        "GET", url, headers=headers, timeout=timeout, follow_redirects=False
                    ) as response:
                        if response.status_code in (403, 429):
                            await self._denied(url, response)
                        chunks, size = [], 0
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > max_bytes:
                                raise ValueError("SEC response exceeded its size limit.")
                            chunks.append(chunk)
                        if response.is_success and started_failures:
                            try:
                                async with self.ctx.db.transaction() as tx:
                                    metadata = await self.store.locked(tx, "SEC", STREAM)
                                    if (
                                        failures(metadata) == started_failures
                                        and metadata.get("lastFailureId") == failure_id
                                        and (
                                            not lease
                                            or (
                                                metadata.get("recoveryOwner") == lease["owner"]
                                                and lease["expiresAt"] > utcnow()
                                            )
                                        )
                                    ):
                                        await self.store.write(
                                            tx,
                                            "SEC",
                                            STREAM,
                                            {
                                                **metadata,
                                                "consecutiveFailures": 0,
                                                "lastSuccessAt": iso(),
                                            },
                                        )
                            except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                                raise SecAccessPolicyError() from None
                        return httpx.Response(
                            response.status_code,
                            headers=response.headers,
                            content=b"".join(chunks),
                            request=response.request,
                        )
            finally:
                if lease:
                    try:
                        async with self.ctx.db.transaction() as tx:
                            metadata = await self.store.locked(tx, "SEC", STREAM)
                            if metadata.get("recoveryOwner") == lease["owner"]:
                                await self.store.write(
                                    tx,
                                    "SEC",
                                    STREAM,
                                    {**metadata, "recoveryOwner": None, "recoveryExpiresAt": None},
                                )
                    except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                        # The persisted lease remains closed until its bounded expiry.
                        logging.getLogger(__name__).warning(
                            "SEC recovery lease release failed; expiry remains enforced."
                        )

    async def _denied(self, url, response):
        now = utcnow()
        retry_header = response.headers.get("retry-after")
        observed = {
            "retryAt": retry_time(retry_header, now),
            "providerStatus": response.status_code,
            "providerCode": "SEC_RATE_LIMIT" if response.status_code == 429 else None,
        }
        self.local_cooldown = later(self.local_cooldown, observed)
        parsed = urlsplit(url)
        provenance = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
        try:
            async with self.ctx.db.transaction() as tx:
                metadata = await self.store.locked(tx, "SEC", STREAM)
                count = min(9007199254740991, failures(metadata) + 1)
                observed["retryAt"] = retry_time(retry_header, now, count)
                next_value = later(cooldown(metadata), observed)
                update = {
                    **metadata,
                    "consecutiveFailures": count,
                    "lastFailureId": identifier(),
                    "lastFailureAt": iso(now),
                    "retryAt": iso(next_value["retryAt"]),
                    "providerStatus": next_value["providerStatus"],
                    "providerCode": next_value["providerCode"],
                    "source": "SEC",
                }
                if next_value is observed:
                    update.update(
                        provenanceUrl=provenance,
                        observedAt=iso(now),
                        retryAfter=retry_header[:128] if retry_header else None,
                    )
                await self.store.write(tx, "SEC", STREAM, update)
            self.local_cooldown = later(self.local_cooldown, next_value)
        except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
            raise SecAccessPolicyError() from None
        code = observed["providerCode"]
        if response.status_code == 403:
            text = b""
            try:
                async with asyncio.timeout(1):
                    async for chunk in response.aiter_bytes():
                        text += chunk[: 8192 - len(text)]
                        folded = text.decode("utf-8", errors="replace").lower()
                        if "undeclared automated tool" in folded:
                            code = "SEC_UNDECLARED_AUTOMATION"
                        elif (
                            "request rate threshold exceeded" in folded
                            or "your request rate has exceeded" in folded
                        ):
                            code = "SEC_RATE_LIMIT"
                        elif "access denied" in folded:
                            code = "SEC_ACCESS_DENIED"
                        if code or len(text) >= 8192:
                            break
            except (TimeoutError, httpx.HTTPError):
                pass
        if code and code != observed["providerCode"]:
            observed["providerCode"] = code
            try:
                async with self.ctx.db.transaction() as tx:
                    metadata = await self.store.locked(tx, "SEC", STREAM)
                    if (
                        metadata.get("observedAt") == iso(now)
                        and metadata.get("retryAt") == iso(observed["retryAt"])
                        and metadata.get("providerStatus") == observed["providerStatus"]
                        and metadata.get("provenanceUrl") == provenance
                    ):
                        await self.store.write(
                            tx, "SEC", STREAM, {**metadata, "providerCode": code}
                        )
            except Exception:  # noqa: BLE001 - safe per-provider/document boundary; preserve diagnostics without source or credentials
                logging.getLogger(__name__).warning(
                    "SEC cooldown diagnostic enrichment failed; committed cooldown remains enforced."
                )
        raise SecAccessCooldownError(
            next_value["retryAt"],
            next_value["providerStatus"],
            True,
            code if next_value is observed else next_value["providerCode"],
        )
