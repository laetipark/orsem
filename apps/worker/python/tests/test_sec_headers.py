"""SEC identification at the final HTTP boundary; no external requests."""

import httpx
import pytest
from test_connectors import context

from orsem_worker.connectors.sec_access import SecHttp


@pytest.mark.parametrize("host", ["sec.gov", "www.sec.gov", "data.sec.gov"])
@pytest.mark.parametrize(
    "supplied",
    [
        None,
        {"Accept": "application/json", "User-Agent": "python-httpx/0.28.1"},
        [("User-Agent", "curl/8.9.1"), ("user-agent", "")],
    ],
)
async def test_sec_contact_is_present_once_at_transport_boundary(host, supplied):
    received = []
    identity = "Synthetic Collector contact@example.com"
    ctx = context(
        {"SEC_USER_AGENT": identity},
        httpx.MockTransport(lambda request: received.append(request) or httpx.Response(200)),
    )
    try:
        await SecHttp(ctx).request(f"https://{host}/fixture", headers=supplied)
        assert len(received) == 1
        assert received[0].headers.get_list("user-agent") == [identity]
        if isinstance(supplied, dict):
            assert received[0].headers["accept"] == "application/json"
            assert supplied["User-Agent"] == "python-httpx/0.28.1"
    finally:
        await ctx.http.aclose()


async def test_missing_sec_contact_does_not_reserve_slot_or_send_request():
    received = []
    ctx = context(
        transport=httpx.MockTransport(
            lambda request: received.append(request) or httpx.Response(200)
        )
    )
    try:
        with pytest.raises(ValueError, match="SEC_USER_AGENT is required"):
            await SecHttp(ctx).request("https://data.sec.gov/fixture")
        assert not received
        assert not ctx.db.states
    finally:
        await ctx.http.aclose()


async def test_sec_identity_is_not_added_to_other_hosts_or_redirects():
    received = []
    ctx = context(
        {"SEC_USER_AGENT": "Synthetic Collector contact@example.com"},
        httpx.MockTransport(
            lambda request: (
                received.append(request)
                or httpx.Response(302, headers={"Location": "https://publisher.example/target"})
            )
        ),
    )
    try:
        await SecHttp(ctx).request("https://data.sec.gov/fixture")
        assert len(received) == 1
        await SecHttp(ctx).request(
            "https://publisher.example/fixture", headers={"User-Agent": "App"}
        )
        assert len(received) == 2
        assert received[1].headers["user-agent"] == "App"
    finally:
        await ctx.http.aclose()
