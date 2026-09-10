"""Durable account-scoped Web Push, including final authorization and lease checks."""

from __future__ import annotations

import math
import re
from datetime import timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import quote, urlsplit

from .alert_gate import alert_filing_context, filing_alert_is_eligible
from .core import as_instant, db_time, json_text, utcnow
from .storage import insert, one, select, update

MAX_AGE = timedelta(hours=24)
MAX_ATTEMPTS = 6
LEASE = timedelta(minutes=10)


def recent(at, now):
    try:
        return as_instant(now) - MAX_AGE <= as_instant(at) <= as_instant(now)
    except (ValueError, TypeError, AttributeError):
        return False


def preference_allows(
    *,
    owner_key,
    subscription_owner_key,
    authorized,
    enabled,
    topics,
    topic,
    watchlist_only,
    watchlisted,
    company_enabled=None,
    filing_type=None,
    filing_types=None,
):
    if not authorized or not enabled or owner_key != subscription_owner_key:
        return False
    if topic == "TEST":
        return True
    if topic not in topics:
        return False
    if topic == "OPERATIONS":
        return owner_key.startswith("ADMIN:")
    if filing_type and filing_type not in (
        filing_types if filing_types is not None else ["D001", "D002", "D005"]
    ):
        return False
    return company_enabled if company_enabled is not None else (not watchlist_only or watchlisted)


def alert_topic(alert, event, submission_kind):
    if alert["status"] == "CANCELLED":
        return None
    phase = (alert.get("payloadJson") or {}).get("phase")
    if alert.get("eventClusterId") is None:
        return "OPERATIONS" if phase == "OPERATIONAL" else None
    if (
        not event
        or event["state"] in ("CANCELLED", "SUPERSEDED")
        or phase not in ("DETECTED", "PARSED")
    ):
        return None
    if event["canonicalEventType"] == "CORRECTION" or submission_kind in (
        "CORRECTION",
        "ATTACHMENT_CORRECTION",
        "WITHDRAWAL",
    ):
        return "CORRECTIONS"
    return "ANALYSIS" if phase == "PARSED" else "FILINGS"


def short_text(value, maximum):
    return re.sub(r"[\r\n\t]+", " ", value).strip()[:maximum] if isinstance(value, str) else ""


def alert_message(alert, topic):
    labels = {
        "FILINGS": "새 공시",
        "ANALYSIS": "공시 분석 완료",
        "CORRECTIONS": "정정·철회 공시",
        "NEWS": "새 뉴스",
        "OPERATIONS": "운영 상태 알림",
        "TEST": "테스트 알림",
    }
    payload = alert.get("payloadJson") or {}
    company = short_text(payload.get("companyName"), 30)
    summary = short_text(payload.get("summary"), 160) or short_text(payload.get("reportName"), 160)
    return {
        "title": f"오름셈 · {labels[topic]}" + (f" · {company}" if company else ""),
        "body": "연결 상태가 변경되었습니다. 운영 화면에서 확인해 주세요."
        if topic == "OPERATIONS"
        else summary or "새 관찰 결과를 확인해 주세요.",
        "url": "/operations" if topic == "OPERATIONS" else f"/events/{alert['eventClusterId']}",
        "tag": f"alert-{alert['id']}",
    }


def news_message(news):
    return {
        "title": "오름셈 · 새 뉴스",
        "body": short_text(news["title"], 160),
        "url": "/search?type=news&q=" + quote(short_text(news["title"], 100), safe="~()*!.'-"),
        "tag": f"news-{news['id']}",
    }


def safe_message(payload):
    def length(value):
        return len(value.encode("utf-16-le", errors="surrogatepass")) // 2

    return bool(
        isinstance(payload, dict)
        and set(payload).issubset({"title", "body", "tag", "url"})
        and all(isinstance(payload.get(field), str) for field in ("title", "body", "tag", "url"))
        and 0 < length(payload["title"]) <= 300
        and length(payload["body"]) <= 600
        and re.fullmatch(r"[a-zA-Z0-9:_-]{1,180}", payload["tag"])
        and length(payload["url"]) <= 1600
        and re.fullmatch(
            r"/(?:events/[a-f0-9-]{36}|operations|notifications|settings/notifications|search\?type=news&q=[^\s#]*)",
            payload["url"],
        )
        and "\\" not in payload["url"]
        and not any(ord(c) < 32 for c in payload["url"])
    )


def allowed_endpoint(endpoint):
    try:
        value = urlsplit(endpoint)
        if (
            len(endpoint) > 2048
            or value.scheme != "https"
            or value.username
            or value.password
            or value.port not in (None, 443)
            or value.fragment
            or any(ord(c) < 33 for c in endpoint)
        ):
            return False
        host = value.hostname or ""
        return bool(
            host
            in (
                "fcm.googleapis.com",
                "android.googleapis.com",
                "updates.push.services.mozilla.com",
                "web.push.apple.com",
            )
            or re.fullmatch(
                r"[a-z0-9-]+\.(?:push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)",
                host,
            )
        )
    except (ValueError, TypeError):
        return False


def news_eligible(news, source, now):
    policy = source.get("sourcePolicyJson") or {}
    return (
        source["id"] == news["sourceItemId"]
        and source["source"]
        not in ("NAVER", "NEWS_RSS", "IR", "GDELT", "MARKETAUX", "ALPHAVANTAGE", "FINNHUB")
        and policy.get("policyVersion") != 2
        and policy.get("notifyAllowed") is not False
        and source["rightsMode"] not in ("NO_REDISTRIBUTION", "PRIVATE_DISPLAY_ONLY")
        and recent(source["firstObservedAt"], now)
        and news.get("publishedAt") is not None
        and recent(news["publishedAt"], now)
    )


class PushFanout:
    async def context(self, db, alert):
        if not await filing_alert_is_eligible(db, alert):
            return None, None, None
        event, _, filing = await alert_filing_context(db, alert)
        return (
            alert_topic(alert, event, filing.get("submissionKind") if filing else None),
            event.get("companyId") if event else None,
            (filing.get("canonicalType") or filing.get("detailType")) if filing else None,
        )

    async def can_receive(
        self, db, subscription, preference, topic, company_id, event_at, now, filing_type=None
    ):
        if subscription.get("expirationTime") and as_instant(
            subscription["expirationTime"]
        ) <= as_instant(now):
            return False
        if (
            not recent(event_at, now)
            or as_instant(event_at) < as_instant(subscription["createdAt"])
            or as_instant(event_at) < as_instant(preference["updatedAt"])
        ):
            return False
        match = re.fullmatch(r"(ADMIN|MEMBER):([a-f0-9-]{36})", preference["ownerKey"])
        if not match:
            return False
        owner = await one(
            db,
            "admins" if match[1] == "ADMIN" else "members",
            "id=:id AND is_active=1"
            if match[1] == "ADMIN"
            else "id=:id AND status='APPROVED' AND role='VIEWER' AND provider='KAKAO'",
            {"id": match[2]},
        )
        watch = (
            await one(db, "market_leader_company_links", "company_id=:id", {"id": company_id})
            if company_id
            else None
        )
        company = (
            await one(
                db,
                "notification_company_preferences",
                "owner_key=:owner AND company_id=:company",
                {"owner": preference["ownerKey"], "company": company_id},
            )
            if company_id
            else None
        )
        if company and as_instant(event_at) < as_instant(company["updatedAt"]):
            return False
        return preference_allows(
            owner_key=preference["ownerKey"],
            subscription_owner_key=subscription["ownerKey"],
            authorized=bool(owner),
            enabled=preference["enabled"],
            topics=preference["topicsJson"],
            topic=topic,
            watchlist_only=preference["watchlistOnly"],
            watchlisted=bool(watch),
            company_enabled=company["enabled"] if company else None,
            filing_type=filing_type,
            filing_types=preference.get("filingTypesJson"),
        )

    async def enqueue(
        self,
        db,
        topic,
        company_id,
        event_at,
        key,
        payload,
        now,
        alert_id=None,
        event_id=None,
        filing_type=None,
    ):
        created = 0
        for preference in await select(db, "notification_preferences", "enabled=1"):
            if topic not in preference["topicsJson"]:
                continue
            for subscription in await select(
                db, "push_subscriptions", "owner_key=:owner", {"owner": preference["ownerKey"]}
            ):
                if not await self.can_receive(
                    db, subscription, preference, topic, company_id, event_at, now, filing_type
                ):
                    continue
                dedupe = f"{subscription['id']}:{key}"
                if await one(db, "push_deliveries", "dedupe_key=:key", {"key": dedupe}):
                    continue
                await insert(
                    db,
                    "push_deliveries",
                    {
                        "subscriptionId": subscription["id"],
                        "ownerKey": preference["ownerKey"],
                        "dedupeKey": dedupe,
                        "alertId": alert_id,
                        "eventClusterId": event_id,
                        "topic": topic,
                        "payloadJson": payload,
                        "status": "PENDING",
                        "availableAt": now,
                        "leaseUntil": None,
                        "attempts": 0,
                        "lastError": None,
                        "sentAt": None,
                    },
                )
                created += 1
        return created

    async def enqueue_alert(self, db, alert, now=None):
        now = now or utcnow()
        topic, company_id, filing_type = await self.context(db, alert)
        if not topic or not recent(alert["createdAt"], now):
            return 0
        return await self.enqueue(
            db,
            topic,
            company_id,
            alert["createdAt"],
            f"alert:{alert['id']}",
            alert_message(alert, topic),
            now,
            alert["id"],
            alert.get("eventClusterId"),
            filing_type,
        )

    async def enqueue_news(self, db, news, source, now=None):
        now = now or utcnow()
        if not news_eligible(news, source, now):
            return 0
        return await self.enqueue(
            db,
            "NEWS",
            news.get("companyId"),
            min(as_instant(source["firstObservedAt"]), as_instant(news["publishedAt"])),
            f"news:{news['id']}",
            news_message(news),
            now,
        )

    async def resolve_delivery(self, db, delivery, now):
        subscription = await one(
            db,
            "push_subscriptions",
            "id=:id AND owner_key=:owner",
            {"id": delivery["subscriptionId"], "owner": delivery["ownerKey"]},
        )
        preference = await one(
            db, "notification_preferences", "owner_key=:owner", {"owner": delivery["ownerKey"]}
        )
        if not subscription or not preference or not recent(delivery["createdAt"], now):
            return None
        company_id = filing_type = None
        event_at = delivery["createdAt"]
        if delivery["topic"] == "TEST":
            if delivery.get("alertId") is not None or delivery.get("eventClusterId") is not None:
                return None
        elif delivery.get("alertId"):
            alert = await one(db, "alerts", "id=:id", {"id": delivery["alertId"]})
            if not alert or alert.get("eventClusterId") != delivery.get("eventClusterId"):
                return None
            topic, company_id, filing_type = await self.context(db, alert)
            if topic != delivery["topic"]:
                return None
            event_at = alert["createdAt"]
        elif delivery["topic"] == "NEWS" and not delivery.get("eventClusterId"):
            prefix = f"{subscription['id']}:news:"
            if not delivery["dedupeKey"].startswith(prefix):
                return None
            news_id = delivery["dedupeKey"][len(prefix) :]
            if not re.fullmatch(r"[a-f0-9-]{36}", news_id):
                return None
            news = await one(db, "news_items", "id=:id", {"id": news_id})
            source = (
                await one(db, "source_items", "id=:id", {"id": news["sourceItemId"]})
                if news
                else None
            )
            if not news or not source or not news_eligible(news, source, now):
                return None
            company_id = news.get("companyId")
            event_at = min(as_instant(source["firstObservedAt"]), as_instant(news["publishedAt"]))
        else:
            return None
        return (
            subscription
            if await self.can_receive(
                db,
                subscription,
                preference,
                delivery["topic"],
                company_id,
                event_at,
                now,
                filing_type,
            )
            else None
        )


class PushRequestError(Exception):
    def __init__(self, status=None, retry_after=None):
        self.status = status
        self.retry_after = retry_after
        super().__init__(
            "Web Push request failed." if status is None else f"Web Push HTTP {status}."
        )


def retry_at(error, attempts, now):
    retry = None
    if error.retry_after:
        try:
            retry = (
                as_instant(now) + timedelta(seconds=float(error.retry_after))
                if re.fullmatch(r"\d+(?:\.\d+)?", error.retry_after)
                else as_instant(parsedate_to_datetime(error.retry_after))
            )
        except (ValueError, TypeError, OverflowError):
            pass
    now = as_instant(now)
    return (
        min(now + MAX_AGE, max(now + timedelta(seconds=1), retry))
        if retry
        else now + timedelta(seconds=min(3600, 60 * 2 ** max(0, attempts - 1)))
    )


class WebPushClient:
    def __init__(self, ctx):
        self.ctx = ctx
        self.enabled = ctx.config.webPush.enabled

    async def send(self, subscription, payload, ttl):
        config = self.ctx.config.webPush
        if not self.enabled or not config.subject or not config.publicKey or not config.privateKey:
            raise PushRequestError()
        if not allowed_endpoint(subscription["endpoint"]) or not safe_message(payload):
            raise PushRequestError(400)
        try:
            from py_vapid import Vapid
            from pywebpush import WebPusher

            endpoint = subscription["endpoint"]
            url = urlsplit(endpoint)
            headers = Vapid.from_string(config.privateKey).sign(
                {
                    "sub": config.subject,
                    "aud": f"{url.scheme}://{url.netloc}",
                    "exp": int(utcnow().timestamp()) + 43200,
                }
            )
            encoded = WebPusher(
                {
                    "endpoint": endpoint,
                    "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
                }
            ).encode(json_text(payload).encode(), "aes128gcm")
            headers.update(
                {
                    "Content-Encoding": "aes128gcm",
                    "TTL": str(max(0, min(86400, math.floor(ttl)))),
                    "Urgency": "normal",
                }
            )
            # pywebpush supplies encryption only. This async transport never follows redirects.
            async with self.ctx.http.stream(
                "POST",
                endpoint,
                content=encoded["body"],
                headers=headers,
                timeout=min(self.ctx.config.httpTimeoutMs / 1000, 15),
                follow_redirects=False,
            ) as response:
                if not 200 <= response.status_code < 300:
                    raise PushRequestError(
                        response.status_code, response.headers.get("retry-after")
                    )
        except PushRequestError:
            raise
        except Exception:  # noqa: BLE001 - convert provider failures to redacted errors
            raise PushRequestError() from None


class PushDelivery:
    def __init__(self, ctx, fanout, client):
        self.ctx, self.fanout, self.client = ctx, fanout, client

    async def dispatch(self):
        if not self.client.enabled:
            return {"configured": False, "claimed": 0, "sent": 0}
        db, now = self.ctx.db, utcnow()
        for maximum, status, message in (
            (True, "FAILED", "Web Push retry limit reached after an expired lease."),
            (False, "PENDING", "Recovered expired Web Push lease."),
        ):
            await update(
                db,
                "push_deliveries",
                {"status": status, "leaseUntil": None, "lastError": message},
                "status='SENDING' AND lease_until<=:now AND attempts "
                + (">=" if maximum else "<")
                + " 6",
                {"now": now},
            )
        async with db.transaction() as tx:
            rows = await select(
                tx,
                "push_deliveries",
                "status='PENDING' AND available_at<=:now AND attempts<6",
                {"now": now},
                "ORDER BY available_at,id LIMIT 20 FOR UPDATE SKIP LOCKED",
            )
            for row in rows:
                row.update(
                    status="SENDING", leaseUntil=db_time(now + LEASE), attempts=row["attempts"] + 1
                )
                await update(
                    tx,
                    "push_deliveries",
                    {
                        "status": row["status"],
                        "leaseUntil": row["leaseUntil"],
                        "attempts": row["attempts"],
                    },
                    "id=:id",
                    {"id": row["id"]},
                )
        sent = 0
        for row in rows:
            if await self.send_claimed(row):
                sent += 1
        return {"configured": True, "claimed": len(rows), "sent": sent}

    async def send_claimed(self, row):
        db = self.ctx.db
        if row["status"] != "SENDING" or not row.get("leaseUntil"):
            return False
        claim = "id=:id AND status='SENDING' AND attempts=:attempts AND lease_until=:lease"
        params = {"id": row["id"], "attempts": row["attempts"], "lease": row["leaseUntil"]}
        subscription = None
        try:
            now = utcnow()
            if as_instant(row["leaseUntil"]) <= now:
                return False
            subscription = await self.fanout.resolve_delivery(db, row, now)
            if not subscription or not safe_message(row["payloadJson"]):
                await update(
                    db,
                    "push_deliveries",
                    {
                        "status": "CANCELLED",
                        "leaseUntil": None,
                        "lastError": "Web Push recipient, preference, or event is no longer eligible.",
                    },
                    claim,
                    params,
                )
                return False
            if not await one(db, "push_deliveries", claim, params):
                return False
            ttl = (
                300
                if row["topic"] == "TEST"
                else max(0, (as_instant(row["createdAt"]) + MAX_AGE - now).total_seconds())
            )
            await self.client.send(subscription, row["payloadJson"], ttl)
            return bool(
                await update(
                    db,
                    "push_deliveries",
                    {"status": "SENT", "sentAt": utcnow(), "leaseUntil": None, "lastError": None},
                    claim,
                    params,
                )
            )
        except Exception as error:  # noqa: BLE001 - isolate jobs and redact provider credentials
            failure = error if isinstance(error, PushRequestError) else PushRequestError()
            expired = failure.status in (404, 410)
            terminal = (
                expired
                or row["attempts"] >= MAX_ATTEMPTS
                or (
                    failure.status is not None
                    and failure.status < 500
                    and failure.status not in (408, 429)
                )
            )
            async with db.transaction() as tx:
                changed = await update(
                    tx,
                    "push_deliveries",
                    {
                        "status": "FAILED" if terminal else "PENDING",
                        "leaseUntil": None,
                        "availableAt": utcnow()
                        if terminal
                        else retry_at(failure, row["attempts"], utcnow()),
                        "lastError": str(failure),
                    },
                    claim,
                    params,
                )
                if expired and subscription and changed:
                    removed = await tx.execute(
                        "DELETE FROM push_subscriptions WHERE id=:id AND owner_key=:owner AND updated_at=:at",
                        {
                            "id": subscription["id"],
                            "owner": subscription["ownerKey"],
                            "at": subscription["updatedAt"],
                        },
                    )
                    if removed:
                        await update(
                            tx,
                            "push_deliveries",
                            {
                                "status": "CANCELLED",
                                "leaseUntil": None,
                                "lastError": "Web Push subscription expired.",
                            },
                            "subscription_id=:id AND status IN ('PENDING','SENDING')",
                            {"id": subscription["id"]},
                        )
            return False


async def register(ctx):
    fanout = PushFanout()
    ctx.services["push_fanout"] = fanout
    ctx.services["push_delivery"] = PushDelivery(ctx, fanout, WebPushClient(ctx))
    return {}
