"""Session-lock ordering against two real connections to disposable MySQL."""

import asyncio
import os
from types import SimpleNamespace

import pytest

from orsem_worker.core import Database, identifier
from orsem_worker.market.common import named_lock

URL = os.environ.get("ORSEM_MARKET_TEST_DB", "")
pytestmark = pytest.mark.skipif(not URL, reason="Requires disposable ORSEM_MARKET_TEST_DB.")


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["commit", "rollback", "cancel"])
async def test_named_lock_keeps_ownership_through_commit_or_rollback(monkeypatch, outcome):
    assert (
        URL
        == "mysql://root@localhost/orsem_test?unix_socket=/tmp/orsem-python-migration-20260910/mysql.sock"
    )
    db = Database.from_url(URL)
    ctx = SimpleNamespace(db=db)
    company_id = identifier()
    lock_name = "orsem-test-commit-" + company_id
    before_release, release_allowed, body_written = (asyncio.Event() for _ in range(3))
    original_fetch = Database.fetch_one
    owner_connection = None
    intercepted = False

    async def intercept_release(self, sql, params=None):
        nonlocal intercepted
        if "RELEASE_LOCK" in sql and params.get("name") == lock_name and not intercepted:
            intercepted = True
            before_release.set()
            await release_allowed.wait()
        return await original_fetch(self, sql, params)

    monkeypatch.setattr(Database, "fetch_one", intercept_release)

    async def writer():
        nonlocal owner_connection
        async with named_lock(ctx, lock_name) as tx:
            assert tx is not None
            owner_connection = (await tx.fetch_one("SELECT CONNECTION_ID() AS id"))["id"]
            await tx.execute(
                "UPDATE companies SET name_en='committed' WHERE id=:id", {"id": company_id}
            )
            body_written.set()
            if outcome == "rollback":
                raise ValueError("synthetic write failure")
            if outcome == "cancel":
                await asyncio.Event().wait()

    task = None
    try:
        await db.execute(
            "INSERT INTO companies(id,market,name_ko,name_en,is_listed) "
            "VALUES(:id,'NASDAQ','Synthetic lock test','original',0)",
            {"id": company_id},
        )
        task = asyncio.create_task(writer())
        await asyncio.wait_for(body_written.wait(), 2)
        if outcome == "cancel":
            task.cancel()
        await asyncio.wait_for(before_release.wait(), 2)

        # While RELEASE_LOCK is held back, a different connection must see the
        # final committed/rolled-back state, and still cannot take ownership.
        observer = await db.fetch_one(
            "SELECT name_en,CONNECTION_ID() AS connection_id FROM companies WHERE id=:id",
            {"id": company_id},
        )
        assert observer["connection_id"] != owner_connection
        assert observer["name_en"] == ("committed" if outcome == "commit" else "original")
        assert (await db.fetch_one("SELECT IS_USED_LOCK(:name) AS owner", {"name": lock_name}))[
            "owner"
        ] == owner_connection
        async with named_lock(ctx, lock_name, timeout=0) as contender:
            assert contender is None

        release_allowed.set()
        if outcome == "commit":
            await asyncio.wait_for(task, 2)
        elif outcome == "rollback":
            with pytest.raises(ValueError, match="synthetic write failure"):
                await task
        else:
            with pytest.raises(asyncio.CancelledError):
                await task
        async with named_lock(ctx, lock_name, timeout=0) as successor:
            assert successor is not None
            row = await successor.fetch_one(
                "SELECT name_en FROM companies WHERE id=:id", {"id": company_id}
            )
            assert row["name_en"] == ("committed" if outcome == "commit" else "original")
        assert (await db.fetch_one("SELECT IS_USED_LOCK(:name) AS owner", {"name": lock_name}))[
            "owner"
        ] is None
    finally:
        release_allowed.set()
        if task:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await db.execute("DELETE FROM companies WHERE id=:id", {"id": company_id})
        await db.close()
