# Python worker integration contract

This package is being implemented alongside the existing worker. Existing TypeScript and
production `dist` files remain intact until parity and deployment checks pass.

- Package: `apps/worker/python/orsem_worker`; tests: `apps/worker/python/tests`.
- All application execution must be native Python; no JavaScript subprocess bridge.
- `RuntimeContext` is provided by `orsem_worker.core` (root-owned).
- `ctx.config` exposes existing worker config **camelCase attributes** (same meanings).
- `ctx.db.fetch_one(sql, params=None)` -> dict or None; `fetch_all` -> list[dict];
  `execute` -> affected-row count. SQL uses SQLAlchemy `:parameter` bindings.
- `async with ctx.db.transaction() as tx:` supplies the same three methods on one
  transactional connection. SQL JSON parameters should use `json_text(value)` from core.
- `ctx.redis` is redis.asyncio.Redis with decoded strings, using configured URL.
- `ctx.http` is httpx.AsyncClient, redirect following disabled. Connector implementations
  must retain bounded responses, hostname/IP/redirect/rights rules from the old runtime.
- `await ctx.enqueue(queue_name, job_name, payload, options=None)` queues a BullMQ job.
- `ctx.services` is a dict for shared service instances; don't access another agent's
  implementation until its interface is agreed in a message.
- Each owned module exports `async def register(ctx) -> dict[str, Handler]`, where each
  Handler accepts the camelCase job payload dict and returns an awaitable JSON result.
  Register itself must not perform ingestion, change schedules, or send notifications.
- Optional `async def start(ctx)` starts non-queue loops after all modules are registered.
  Use `ctx.periodic(name, seconds, callable, immediately=True)` to register loops.
- Optional cleanup uses `ctx.on_close(async_callable)`.
- Helpers from core: `utcnow()` (aware UTC), `db_time(value)` (naive UTC for MySQL),
  `json_text(value)` (UTF-8 compact JSON), `decode_json(value, default=None)`,
  `identifier()` (UUID string), and `sha256(value: bytes | str)`.
- Keep dates as dates, instants UTC, decimal values lossless. Never auto-create schema.
- Port rights/security/retired-connector behavior. No new feature activation, dummy success,
  swallowed errors, or NotImplemented placeholders on supported runtime paths.
- Don't change npm/PM2/source TS files or live data unless specifically assigned.
- No live external requests or DB writes from tests; use isolated fixtures/databases.
