"""Cross-language BullMQ tests against an explicitly configured disposable Redis."""

import asyncio
import json
import os
import re
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from bullmq import Queue
from redis.asyncio import Redis

from orsem_worker.constants import QueueName as Q
from orsem_worker.disclosures.primitives import OpenDartApiError
from orsem_worker.runtime import Worker, processor
from orsem_worker.scheduling import require_native_schedulers

URL = os.environ.get("ORSEM_TEST_REDIS_URL")
pytestmark = pytest.mark.skipif(
    not URL, reason="Set ORSEM_TEST_REDIS_URL to the disposable test Redis."
)
ROOT = Path(__file__).resolve().parents[4]


async def node(code, *args):
    process = await asyncio.create_subprocess_exec(
        "node",
        "-e",
        code,
        str(ROOT / "node_modules/bullmq"),
        URL,
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
    assert process.returncode == 0, stderr.decode()
    return json.loads(stdout)


async def until(predicate):
    async with asyncio.timeout(12):
        while not await predicate():
            await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_node_jobs_python_processing_retry_and_document_delay_keep_identity():
    assert URL == "redis://127.0.0.1:16390/0"
    prefix = "orsem-python-test-" + uuid4().hex
    redis = Redis.from_url(URL, decode_responses=True)
    queues = {
        name: Queue(str(name), {"connection": URL, "prefix": prefix}) for name in (Q.POLL, Q.FILING)
    }
    workers = []
    try:
        await node(
            """const {Queue}=require(process.argv[1]);
          (async()=>{const opts={connection:{host:'127.0.0.1',port:16390},prefix:process.argv[3]};
          const poll=new Queue('orsem-poll',opts), filing=new Queue('orsem-filing',opts);
          await poll.add('poll-opendart',{detailType:'D001'},{jobId:'native-parity',attempts:3,removeOnComplete:{count:100}});
          await poll.add('backfill-opendart',{detailType:'D002',suppressAlerts:true,reason:'BACKFILL'},
            {jobId:'retry-parity',attempts:3,backoff:{type:'exponential',delay:20},removeOnComplete:false});
          await filing.add('enrich-filing',{filingId:'00000000-0000-4000-8000-000000000001',rceptNo:'20260910000001',detailType:'D005'},
            {jobId:'delay-parity',attempts:8,removeOnComplete:false});
          await poll.close();await filing.close();console.log(JSON.stringify({seeded:3}));})().catch(e=>{console.error(e);process.exit(1)});""",
            prefix,
        )
        attempts = 0

        async def poll(data):
            return {"detailType": data["detailType"], "amount": Decimal("9007199254740993.000001")}

        async def backfill(data):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("Transient fixture failure")
            return {"suppressed": data["suppressAlerts"]}

        async def enrich(data):
            raise OpenDartApiError("014", "Fixture document unavailable")

        ctx = SimpleNamespace(services={})
        handlers = {"poll-opendart": poll, "backfill-opendart": backfill, "enrich-filing": enrich}
        for name in queues:
            worker = Worker(
                str(name),
                processor(ctx, name, handlers),
                {"connection": URL, "prefix": prefix, "autorun": False, "drainDelay": 0.1},
            )
            workers.append((worker, asyncio.create_task(worker.run())))

        async def complete():
            return (
                await redis.zcard(f"{prefix}:{Q.POLL}:completed") == 2
                and await redis.zcard(f"{prefix}:{Q.FILING}:delayed") == 1
            )

        await until(complete)
        result = await node(
            """const {Queue}=require(process.argv[1]);
          (async()=>{const opts={connection:{host:'127.0.0.1',port:16390},prefix:process.argv[3]};let rows=[];
          for(const [name,id] of [['orsem-poll','native-parity'],['orsem-poll','retry-parity'],['orsem-filing','delay-parity']]){
            const q=new Queue(name,opts),j=await q.getJob(id);rows.push({id:j.id,state:await j.getState(),data:j.data,
              result:j.returnvalue,attemptsMade:j.attemptsMade,opts:j.opts});await q.close();}
          console.log(JSON.stringify(rows));})().catch(e=>{console.error(e);process.exit(1)});""",
            prefix,
        )
        assert (
            result[0]["id"] == "native-parity"
            and result[0]["result"]["amount"] == "9007199254740993.000001"
        )
        assert (
            result[1]["state"] == "completed"
            and result[1]["attemptsMade"] == 2
            and result[1]["result"]["suppressed"] is True
        )
        assert result[2]["state"] == "delayed" and result[2]["data"]["documentRetryAttempt"] == 1
        assert result[2]["attemptsMade"] == 0 and result[2]["opts"]["attempts"] == 8
    finally:
        for worker, task in workers:
            await worker.close()
            await task
        for queue in queues.values():
            await queue.close()
        keys = [key async for key in redis.scan_iter(match=prefix + ":*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()


@pytest.mark.asyncio
async def test_native_scheduler_generates_node_consumable_jobs_without_duplicates_and_rejects_legacy():
    assert URL == "redis://127.0.0.1:16390/0"
    prefix = "orsem-python-test-" + uuid4().hex
    redis = Redis.from_url(URL, decode_responses=True)
    queue = Queue(str(Q.OUTBOX), {"connection": URL, "prefix": prefix})
    ctx = SimpleNamespace(
        redis=redis, config=SimpleNamespace(redisPrefix=prefix), queues={Q.OUTBOX: queue}
    )
    try:
        await node(
            """const {Queue}=require(process.argv[1]);(async()=>{
          const q=new Queue('orsem-outbox',{connection:{host:'127.0.0.1',port:16390},prefix:process.argv[3]});
          await q.add('legacy',{}, {jobId:'legacy',repeat:{pattern:'* * * * *'}});await q.close();
          console.log(JSON.stringify(true));})().catch(e=>{console.error(e);process.exit(1)});""",
            prefix,
        )
        with pytest.raises(RuntimeError, match="Legacy repeat"):
            await require_native_schedulers(ctx)
        await node(
            """const {Queue}=require(process.argv[1]);(async()=>{
          const q=new Queue('orsem-outbox',{connection:{host:'127.0.0.1',port:16390},prefix:process.argv[3]});
          for(const row of await q.getRepeatableJobs())await q.removeRepeatableByKey(row.key);await q.close();
          console.log(JSON.stringify(true));})().catch(e=>{console.error(e);process.exit(1)});""",
            prefix,
        )
        for _ in range(2):
            await queue.upsertJobScheduler(
                "native-cadence",
                {"every": 200, "limit": 3},
                "dispatch-processing-outbox",
                {"native": True},
                {"removeOnComplete": False, "attempts": 1},
            )
        await require_native_schedulers(ctx)
        assert await queue.getJobSchedulersCount() == 1
        result = await node(
            """const {Worker,Queue}=require(process.argv[1]);(async()=>{
          const opts={connection:{host:'127.0.0.1',port:16390},prefix:process.argv[3]};const seen=[];
          const worker=new Worker('orsem-outbox',async j=>{seen.push({id:j.id,name:j.name,data:j.data});return {ok:true};},opts);
          await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('scheduler timeout')),10000);
            worker.on('completed',()=>{if(seen.length===3){clearTimeout(timeout);resolve();}});worker.on('error',reject);});
          await worker.close();const q=new Queue('orsem-outbox',opts);const count=await q.getJobSchedulersCount();await q.close();
          console.log(JSON.stringify({seen,count}));})().catch(e=>{console.error(e);process.exit(1)});""",
            prefix,
        )
        assert result["count"] == 1 and len({row["id"] for row in result["seen"]}) == 3
        assert all(
            row["name"] == "dispatch-processing-outbox" and row["data"] == {"native": True}
            for row in result["seen"]
        )
    finally:
        await queue.close()
        keys = [key async for key in redis.scan_iter(match=prefix + ":*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()


@pytest.mark.asyncio
async def test_consumed_node_legacy_repeat_with_native_iteration_metadata_still_requires_migration():
    assert URL == "redis://127.0.0.1:16390/0"
    prefix = "orsem-python-test-" + uuid4().hex
    redis = Redis.from_url(URL, decode_responses=True)
    queue = Queue(str(Q.OUTBOX), {"connection": URL, "prefix": prefix})
    ctx = SimpleNamespace(
        redis=redis, config=SimpleNamespace(redisPrefix=prefix), queues={Q.OUTBOX: queue}
    )
    try:
        result = await node(
            """const {Queue,Worker}=require(process.argv[1]);(async()=>{
          const opts={connection:{host:'127.0.0.1',port:16390},prefix:process.argv[3]};
          const q=new Queue('orsem-outbox',opts);
          const job=await q.add('dispatch-processing-outbox',{legacy:true},
            {jobId:'processing-outbox-minute',repeat:{pattern:'* * * * *',tz:'Asia/Seoul'},removeOnComplete:false});
          await job.promote();
          const seen=[];
          const worker=new Worker(q.name,async j=>{seen.push(j.id);return {ok:true};},{...opts,autorun:false});
          const completed=new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('legacy scheduler timeout')),10000);
            worker.once('completed',()=>{clearTimeout(timer);resolve();});
            worker.once('error',error=>{clearTimeout(timer);reject(error);});
          });
          const run=worker.run();
          try {await completed;} finally {await worker.close();await run;}
          const rows=await q.getRepeatableJobs(),client=await q.client;
          const ic=await client.hget(q.toKey('repeat:'+rows[0].key),'ic');
          await q.close();console.log(JSON.stringify({rows,ic,seen,original:job.id}));
          })().catch(e=>{console.error(e);process.exit(1)});""",
            prefix,
        )
        assert result["seen"] == [result["original"]]
        assert len(result["rows"]) == 1
        key = result["rows"][0]["key"]
        assert re.fullmatch(r"[0-9a-f]{32}", key)
        assert int(result["ic"]) > 0  # Created by actual Node consumption, never injected.
        assert await queue.isJobScheduler(key)  # The former guard wrongly accepted this state.
        repeat_key = f"{prefix}:{Q.OUTBOX}:repeat"
        before = await redis.hgetall(f"{repeat_key}:{key}")
        occurrences = await redis.zrange(repeat_key, 0, -1, withscores=True)
        with pytest.raises(RuntimeError, match="Legacy repeat"):
            await require_native_schedulers(ctx)
        assert await redis.hgetall(f"{repeat_key}:{key}") == before
        assert await redis.zrange(repeat_key, 0, -1, withscores=True) == occurrences
    finally:
        await queue.close()
        keys = [key async for key in redis.scan_iter(match=prefix + ":*")]
        if keys:
            await redis.delete(*keys)
        await redis.aclose()
