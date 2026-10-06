import test from "node:test";
import assert from "node:assert/strict";
import { createImageTaskPool } from "../src/image-task-pool.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const job = (run, cancel = async () => {}) => ({ run, cancel });

test("generation can continue after enqueue without waiting for slow image movement", async () => {
  const moving = deferred();
  const workers = [];
  const pool = createImageTaskPool({ concurrency: 1, capacity: 2, onWorkerCreated: (worker) => workers.push(worker) });
  let generated = 0, moved = 0;
  for (let index = 0; index < 3; index++) {
    generated++;
    await pool.enqueue(job(async (worker) => {
      await moving.promise;
      moved++;
      worker.stats.moved++;
    }));
  }
  assert.equal(generated, 3);
  assert.equal(moved, 0);
  assert.deepEqual(pool.stats, { queued: 2, active: 1, waitingProducers: 0 });
  const closing = pool.close();
  assert.equal(pool.close(), closing, "close is repeatable and returns the same completion");
  moving.resolve();
  const results = await closing;
  assert.equal(moved, 3);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === "fulfilled"));
  assert.equal(workers[0].id, "image-worker-1");
  assert.equal(workers[0].stats.processed, 3);
  assert.equal(workers[0].stats.moved, 3);
  assert.equal(workers[0].phase, "finished");
  assert.deepEqual(pool.stats, { queued: 0, active: 0, waitingProducers: 0 });
});

test("bounded waiting queue applies backpressure and releases producers in FIFO order", async () => {
  const first = deferred(), second = deferred();
  const order = [];
  const pool = createImageTaskPool({ concurrency: 1, capacity: 1 });
  await pool.enqueue(job(async () => { order.push(1); await first.promise; }));
  await pool.enqueue(job(async () => { order.push(2); await second.promise; }));
  let thirdAccepted = false, fourthAccepted = false;
  const third = pool.enqueue(job(async () => { order.push(3); })).then(() => { thirdAccepted = true; });
  const fourth = pool.enqueue(job(async () => { order.push(4); })).then(() => { fourthAccepted = true; });
  await nextTurn();
  assert.equal(thirdAccepted, false);
  assert.equal(fourthAccepted, false);
  assert.deepEqual(pool.stats, { queued: 1, active: 1, waitingProducers: 2 });
  first.resolve();
  await third;
  assert.equal(fourthAccepted, false);
  assert.deepEqual(pool.stats, { queued: 1, active: 1, waitingProducers: 1 });
  second.resolve();
  await fourth;
  await pool.close();
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("a failed accepted job does not reject enqueue or stop following jobs", async () => {
  const workers = [], completed = [];
  const pool = createImageTaskPool({ concurrency: 1, capacity: 2, onWorkerCreated: (worker) => workers.push(worker) });
  const failure = new Error("rename failed");
  await pool.enqueue(job(async () => { throw failure; }));
  await pool.enqueue(job(async () => { completed.push("next"); return 42; }));
  const results = await pool.close();
  assert.deepEqual(completed, ["next"]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason, failure);
  assert.equal(results[1].value, 42);
  assert.equal(workers[0].stats.failed, 1);
  assert.equal(workers[0].stats.processed, 2);
});

test("abort rejects pending producers, cancels accepted queued jobs and awaits cleanup", async () => {
  const controller = new AbortController();
  const active = deferred(), cleanup = deferred();
  const calls = [], workers = [];
  const pool = createImageTaskPool({ concurrency: 1, capacity: 1, signal: controller.signal,
    onWorkerCreated: (worker) => workers.push(worker) });
  await pool.enqueue(job(async () => { calls.push("active-run"); await active.promise; }, async () => calls.push("active-cancel")));
  await pool.enqueue(job(async () => calls.push("queued-run"), async () => {
    calls.push("queued-cancel-start");
    await cleanup.promise;
    calls.push("queued-cancel-end");
  }));
  const pending = pool.enqueue(job(async () => calls.push("pending-run"), async () => calls.push("pending-cancel")));
  const pendingRejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await pendingRejected;
  assert.deepEqual(pool.stats, { queued: 1, active: 1, waitingProducers: 0 });
  let closed = false;
  const closing = pool.close().then((results) => { closed = true; return results; });
  active.resolve();
  await nextTurn();
  assert.deepEqual(calls, ["active-run", "queued-cancel-start"]);
  assert.equal(closed, false, "pool still owns and awaits accepted cleanup");
  cleanup.resolve();
  const results = await closing;
  assert.deepEqual(calls, ["active-run", "queued-cancel-start", "queued-cancel-end"]);
  assert.equal(results[0].cancelled, false, "running job handles its own signal");
  assert.equal(results[1].cancelled, true);
  assert.equal(workers[0].stats.cancelled, 1);
  await assert.rejects(pool.enqueue(job(async () => {})), { name: "AbortError" });
});

test("close rejects not-yet-accepted producers while completing accepted jobs", async () => {
  const active = deferred();
  const calls = [];
  const pool = createImageTaskPool({ concurrency: 1, capacity: 1 });
  await pool.enqueue(job(async () => { calls.push(1); await active.promise; }));
  await pool.enqueue(job(async () => calls.push(2)));
  const pending = pool.enqueue(job(async () => calls.push(3)));
  const rejected = assert.rejects(pending, /已关闭/);
  const closing = pool.close();
  await rejected;
  active.resolve();
  await closing;
  assert.deepEqual(calls, [1, 2]);
  await assert.rejects(pool.enqueue(job(async () => {})), /已关闭/);
});

test("failed queued cleanup does not prevent remaining cancelled jobs from cleanup", async () => {
  const controller = new AbortController(), active = deferred();
  const cleaned = [];
  const pool = createImageTaskPool({ concurrency: 1, capacity: 2, signal: controller.signal });
  await pool.enqueue(job(async () => active.promise));
  await pool.enqueue(job(async () => assert.fail("cancelled job must not run"), async () => { throw new Error("cleanup failed"); }));
  await pool.enqueue(job(async () => assert.fail("cancelled job must not run"), async () => cleaned.push("last")));
  controller.abort();
  active.resolve();
  const results = await pool.close();
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].cancelled, true);
  assert.equal(results[2].status, "fulfilled");
  assert.deepEqual(cleaned, ["last"]);
});

test("zero waiting capacity hands off directly and already-aborted pool accepts nothing", async () => {
  const active = deferred();
  const pool = createImageTaskPool({ concurrency: 1, capacity: 0 });
  await pool.enqueue(job(async () => active.promise));
  let accepted = false;
  const pending = pool.enqueue(job(async () => {})).then(() => { accepted = true; });
  await nextTurn();
  assert.equal(accepted, false);
  assert.deepEqual(pool.stats, { queued: 0, active: 1, waitingProducers: 1 });
  active.resolve();
  await pending;
  await pool.close();
  const controller = new AbortController();
  controller.abort();
  const aborted = createImageTaskPool({ concurrency: 1, capacity: 1, signal: controller.signal });
  await assert.rejects(aborted.enqueue(job(async () => assert.fail("must not start"))), { name: "AbortError" });
  assert.deepEqual(await aborted.close(), []);
});

test("settled hook runs once after cleanup and accounting, preserves metadata and tolerates hook errors", async () => {
  const controller = new AbortController(), active = deferred(), cleanup = deferred();
  const hooks = [], calls = [];
  const pool = createImageTaskPool({ concurrency: 1, capacity: 1, signal: controller.signal,
    onSettled: async (result, worker, acceptedJob) => {
      hooks.push({ result, processed: worker.stats.processed, cancelled: worker.stats.cancelled,
        filePath: acceptedJob.filePath, sourceWorkerId: acceptedJob.sourceWorkerId });
      if (hooks.length === 1) throw new Error("hook failed");
      calls.push("cleanup-hook");
    } });
  await pool.enqueue({ ...job(async () => active.promise), filePath: "first.mp4", sourceWorkerId: "nvidia-worker-1" });
  await pool.enqueue({ ...job(async () => assert.fail("must cancel"), async () => {
    calls.push("cleanup-start");
    await cleanup.promise;
    calls.push("cleanup-end");
  }), filePath: "second.mp4", sourceWorkerId: "amd-worker-1" });
  controller.abort();
  active.resolve();
  await nextTurn();
  assert.equal(hooks.length, 1);
  assert.deepEqual(calls, ["cleanup-start"]);
  cleanup.resolve();
  const results = await pool.close();
  assert.equal(hooks.length, 2);
  assert.equal(hooks[0].processed, 1);
  assert.equal(hooks[1].processed, 2);
  assert.equal(hooks[1].cancelled, 1);
  assert.equal(hooks[0].filePath, "first.mp4");
  assert.equal(hooks[1].sourceWorkerId, "amd-worker-1");
  assert.equal(hooks[0].result, results[0]);
  assert.equal(hooks[1].result, results[1]);
  assert.deepEqual(calls, ["cleanup-start", "cleanup-end", "cleanup-hook"]);
  assert.equal(pool.settlementErrors.length, 1);
  assert.match(pool.settlementErrors[0].reason.message, /hook failed/);
  assert.deepEqual(pool.stats, { queued: 0, active: 0, waitingProducers: 0 });
});
