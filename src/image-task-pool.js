import { performance } from "node:perf_hooks";
import { setWorkerPhase } from "./worker-diagnostics.js";

function abortReason(signal) {
  return signal?.reason ?? new DOMException("图片任务池已取消", "AbortError");
}

// 图片任务单独排队；enqueue 只等待接管，不等待移动完成。
export function createImageTaskPool({
  concurrency, capacity, signal, onWorkerCreated = () => {}, onSettled = () => {},
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("图片 worker 数必须为正整数");
  }
  if (!Number.isSafeInteger(capacity) || capacity < 0) {
    throw new Error("图片等待队列容量必须为非负整数");
  }

  const workers = Array.from({ length: concurrency }, (_, index) => ({
    id: `image-worker-${index + 1}`,
    phase: "idle",
    stats: { processed: 0, moved: 0, failed: 0, cancelled: 0, workingSeconds: 0 },
  }));
  for (const worker of workers) onWorkerCreated(worker);

  const idleWorkers = [...workers];
  const queue = [];
  const waitingProducers = [];
  const results = [];
  const settlementErrors = [];
  let active = 0;
  let accepting = !signal?.aborted;
  let settled = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });

  function rejectProducers(reason) {
    for (const producer of waitingProducers.splice(0)) producer.reject(reason);
  }

  function finishIfDrained() {
    if (accepting || active || queue.length || settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    for (const worker of workers) setWorkerPhase(worker, "finished", { pid: undefined });
    resolveCompletion(results);
  }

  async function execute(entry, worker) {
    const startedAt = performance.now();
    let cancelled = signal?.aborted === true;
    setWorkerPhase(worker, cancelled ? "cleanup" : "publish", { pid: undefined });
    try {
      const value = await (cancelled ? entry.job.cancel(worker) : entry.job.run(worker));
      results[entry.index] = { status: "fulfilled", value, cancelled, workerId: worker.id };
      if (cancelled) worker.stats.cancelled++;
    } catch (reason) {
      cancelled ||= signal?.aborted === true;
      results[entry.index] = { status: "rejected", reason, cancelled, workerId: worker.id };
      if (cancelled) worker.stats.cancelled++;
      else worker.stats.failed++;
    } finally {
      worker.stats.processed++;
      worker.stats.workingSeconds += (performance.now() - startedAt) / 1000;
      setWorkerPhase(worker, "idle", { pid: undefined });
      try {
        await onSettled(results[entry.index], worker, entry.job);
      } catch (reason) {
        // Diagnostics/accounting callbacks must not lose a job or stall pool draining.
        settlementErrors.push({ index: entry.index, workerId: worker.id, reason });
      }
      active--;
      idleWorkers.push(worker);
      pump();
    }
  }

  function dispatch() {
    while (idleWorkers.length && queue.length) {
      const worker = idleWorkers.shift();
      const entry = queue.shift();
      active++;
      // execute catches individual job errors; they never reject an accepted enqueue.
      void execute(entry, worker);
    }
  }

  function pump() {
    dispatch();
    while (accepting && waitingProducers.length && (queue.length < capacity || idleWorkers.length)) {
      const producer = waitingProducers.shift();
      const index = results.length;
      results.push(undefined);
      queue.push({ job: producer.job, index });
      producer.resolve();
      dispatch();
    }
    finishIfDrained();
  }

  function onAbort() {
    accepting = false;
    rejectProducers(abortReason(signal));
    // Already accepted queued jobs remain owned by this pool and run their cleanup.
    pump();
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  finishIfDrained();

  return {
    enqueue(job) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortReason(signal)); return; }
        if (!accepting) { reject(new Error("图片任务池已关闭")); return; }
        if (typeof job?.run !== "function" || typeof job?.cancel !== "function") {
          reject(new TypeError("图片任务必须提供 run 和 cancel 函数"));
          return;
        }
        waitingProducers.push({ job, resolve, reject });
        pump();
      });
    },
    close() {
      accepting = false;
      rejectProducers(signal?.aborted ? abortReason(signal) : new Error("图片任务池已关闭"));
      pump();
      return completion;
    },
    get stats() {
      return { queued: queue.length, active, waitingProducers: waitingProducers.length };
    },
    results,
    settlementErrors,
  };
}
