import base64
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from orsem_worker.core import utcnow
from orsem_worker.push import (
    PushRequestError,
    WebPushClient,
    allowed_endpoint,
    news_eligible,
    preference_allows,
    retry_at,
    safe_message,
)


def preference(**changes):
    return preference_allows(
        **(
            {
                "owner_key": "MEMBER:x",
                "subscription_owner_key": "MEMBER:x",
                "authorized": True,
                "enabled": True,
                "topics": ["FILINGS"],
                "topic": "FILINGS",
                "watchlist_only": True,
                "watchlisted": False,
            }
            | changes
        )
    )


def test_company_override_is_independent_but_never_bypasses_global_gates():
    assert not preference()
    assert preference(company_enabled=True)
    assert not preference(company_enabled=False, watchlisted=True)
    assert preference(company_enabled=None, watchlisted=True)
    for change in (
        {"enabled": False},
        {"authorized": False},
        {"topics": []},
        {"subscription_owner_key": "MEMBER:y"},
        {"filing_type": "D003", "filing_types": ["D001", "D002", "D005"]},
    ):
        assert not preference(company_enabled=True, **change)
    assert not preference(topic="OPERATIONS", topics=["OPERATIONS"], company_enabled=True)
    assert preference(topic="TEST", company_enabled=False)


def test_push_payload_endpoint_and_rights_are_fail_closed():
    payload = {"title": "알림", "body": "공시", "url": "/operations", "tag": "alert-test"}
    assert safe_message(payload)
    for url in ("https://example.com", "//example.com", "/operations#secret", "/operations\\x"):
        assert not safe_message(payload | {"url": url})
    for endpoint in (
        "http://fcm.googleapis.com/a",
        "https://fcm.googleapis.com.attacker.test/a",
        "https://user@fcm.googleapis.com/a",
        "https://127.0.0.1/a",
        "https://web.push.apple.com:8443/a",
    ):
        assert not allowed_endpoint(endpoint)
    assert allowed_endpoint("https://fcm.googleapis.com/a")
    now = utcnow()
    source = {
        "id": "source",
        "source": "SEC",
        "sourcePolicyJson": {},
        "rightsMode": "PUBLIC",
        "firstObservedAt": now,
    }
    news = {"sourceItemId": "source", "publishedAt": now}
    assert news_eligible(news, source, now)
    for change in (
        {"source": "IR"},
        {"sourcePolicyJson": {"policyVersion": 2}},
        {"sourcePolicyJson": {"notifyAllowed": False}},
        {"rightsMode": "NO_REDISTRIBUTION"},
        {"firstObservedAt": now - timedelta(days=2)},
    ):
        assert not news_eligible(news, source | change, now)


def test_retry_after_is_bounded_and_exponential():
    now = utcnow()
    assert retry_at(PushRequestError(), 2, now) == now + timedelta(minutes=2)
    assert retry_at(PushRequestError(429, "30"), 2, now) == now + timedelta(seconds=30)
    assert retry_at(PushRequestError(429, "999999999"), 2, now) == now + timedelta(days=1)


@pytest.mark.asyncio
async def test_native_web_push_encrypts_and_does_not_follow_redirects():
    def keypair():
        secret = ec.generate_private_key(ec.SECP256R1())
        public = secret.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
        encode = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
        return encode(secret.private_numbers().private_value.to_bytes(32, "big")), encode(public)

    private, public = keypair()
    _, receiver = keypair()
    requests = []

    async def mock(request):
        requests.append(request)
        assert request.headers["content-encoding"] == "aes128gcm"
        assert request.headers["ttl"] == "300"
        assert request.headers["authorization"].startswith("vapid ")
        assert b"private test text" not in request.content
        return httpx.Response(307, headers={"location": "https://localhost/secret"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(mock)) as http:
        ctx = SimpleNamespace(
            http=http,
            config=SimpleNamespace(
                httpTimeoutMs=15000,
                webPush=SimpleNamespace(
                    enabled=True,
                    subject="mailto:test@example.com",
                    publicKey=public,
                    privateKey=private,
                ),
            ),
        )
        client = WebPushClient(ctx)
        with pytest.raises(PushRequestError) as failure:
            await client.send(
                {
                    "endpoint": "https://fcm.googleapis.com/test",
                    "p256dh": receiver,
                    "auth": base64.urlsafe_b64encode(b"1234567890123456").decode().rstrip("="),
                },
                {
                    "title": "알림",
                    "body": "private test text",
                    "url": "/operations",
                    "tag": "alert-test",
                },
                300,
            )
        assert failure.value.status == 307
        assert len(requests) == 1
