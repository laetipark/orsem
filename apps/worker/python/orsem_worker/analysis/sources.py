"""Shared-source request gates and immutable, credential-free response envelopes."""

from __future__ import annotations

import asyncio
import json
from datetime import timedelta
from decimal import Decimal

from ..core import utcnow
from ..disclosures.client import next_midnight
from ..disclosures.primitives import OpenDartApiError


class AnalysisWaiting(Exception):
    def __init__(self, message, retry_at=None):
        super().__init__(message)
        self.retryAt = retry_at or utcnow() + timedelta(minutes=5)


class DartGate:
    """All OpenDartClient calls share one Redis permit while analysis is enabled."""

    def __init__(self, ctx):
        self.ctx = ctx

    async def before_request(self):
        pause = await self.ctx.services["opendart"].paused_until()
        if pause:
            raise AnalysisWaiting("OpenDART 공통 요청 대기 중입니다.", pause)
        for _ in range(80):
            if self.ctx.stopping.is_set():
                raise AnalysisWaiting("수집기 종료 후 다시 시도합니다.")
            if await self.ctx.redis.set(
                self.ctx.config.redisPrefix + "analysis:opendart:permit", "1", nx=True, px=1000
            ):
                return
            await asyncio.sleep(0.25)
        raise AnalysisWaiting("OpenDART 공통 요청 순서를 기다립니다.")


class Sources:
    def __init__(self, ctx, maximum=80):
        self.ctx, self.maximum, self.count = ctx, maximum, 0

    def reserve(self):
        if self.count >= self.maximum:
            raise AnalysisWaiting("요청 한도 내에서 나머지 기간을 이어서 수집합니다.")
        self.count += 1

    async def dart(self, endpoint, params, *, archive=False):
        client = self.ctx.services["opendart"]
        if not client.enabled:
            raise AnalysisWaiting("OpenDART 연결 설정이 필요합니다.", utcnow() + timedelta(hours=6))
        self.reserve()
        try:
            if archive:
                return await client.request_archive(endpoint, params, "DOCUMENT"), None
            content = await client.fetch(endpoint, params, 10 * 1024**2)
            value = json.loads(content.decode("utf-8"))
            if not isinstance(value, dict) or not isinstance(value.get("status"), str):
                raise TypeError("Invalid OpenDART response envelope")
            empty = client.handle_envelope(value, "SUMMARY")
            return content, None if empty else value
        except OpenDartApiError as error:
            if error.status == "020":
                until = next_midnight()
                await self.ctx.services["opendart_health"].pause_open_dart_until(until)
                raise AnalysisWaiting(
                    "OpenDART 공통 일일 요청 제한으로 대기합니다.", until
                ) from None
            if error.status in ("010", "011", "012", "100", "101", "800", "900"):
                raise AnalysisWaiting(
                    "OpenDART 연결 상태를 확인한 뒤 다시 수집합니다.", utcnow() + timedelta(hours=1)
                ) from None
            raise

    async def sec(self, url, *, xml=False):
        if not self.ctx.config.secUserAgent:
            raise AnalysisWaiting("SEC 연결 설정이 필요합니다.", utcnow() + timedelta(hours=6))
        self.reserve()
        response = await self.ctx.services["sec_http"].request(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml,application/xml,text/xml"
                if xml
                else "application/json"
            },
            timeout_ms=self.ctx.config.httpTimeoutMs,
            max_bytes=20 * 1024**2,
        )
        if not response.is_success:
            raise ValueError("SEC analysis source unavailable")
        content = response.content
        return content, None if xml else json.loads(content, parse_float=Decimal)
