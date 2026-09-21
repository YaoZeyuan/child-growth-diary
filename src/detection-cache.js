import fs from 'node:fs';
import path from 'node:path';

// Bump when image preprocessing or output decoding in person-detector.js changes.
export const PREPROCESS_VERSION = 1;

export function matchesCachedResult(record, fingerprint) {
  return record?.file === fingerprint.file
    && typeof record.hasPerson === 'boolean'
    && record.size === fingerprint.size
    && record.mtimeMs === fingerprint.mtimeMs
    && record.modelSha256 === fingerprint.modelSha256
    && record.threshold === fingerprint.threshold
    && record.preprocessVersion === fingerprint.preprocessVersion
    && record.provider === fingerprint.provider;
}

function validateRecord(record, lineNumber) {
  if (!record || typeof record !== 'object' || typeof record.file !== 'string'
    || typeof record.hasPerson !== 'boolean') {
    throw new Error(`检测结果第 ${lineNumber} 行缺少有效的 file / hasPerson 字段。`);
  }
  return record;
}

// Process the JSONL incrementally: only the latest result for each file is retained.
export async function readDetectionCache(resultsPath, { retainRecords = true } = {}) {
  const records = new Map();
  let offset = 0;
  let lineNumber = 0;
  let carry = Buffer.alloc(0);
  let count = 0;
  const addRecord = (record, line) => {
    validateRecord(record, line);
    count += 1;
    if (retainRecords) records.set(record.file, record);
  };
  try {
    for await (const chunk of fs.createReadStream(resultsPath)) {
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let start = 0;
      let end;
      while ((end = buffer.indexOf(10, start)) !== -1) {
        lineNumber += 1;
        const line = buffer.subarray(start, end).toString('utf8').trim();
        if (line) {
          let record;
          try {
            record = JSON.parse(line);
          } catch (error) {
            throw new Error(`检测结果第 ${lineNumber} 行 JSON 损坏；请修复或指定新的 --results 文件。`, { cause: error });
          }
          addRecord(record, lineNumber);
        }
        offset += end - start + 1;
        start = end + 1;
      }
      carry = buffer.subarray(start);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { records, count: 0, needsNewline: false, truncateAt: null, truncatedBytes: 0 };
    }
    throw error;
  }

  if (carry.length) {
    const line = carry.toString('utf8').trim();
    if (line) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // A crash may leave a partial final write. Remove it before appending so it
        // cannot turn into a corrupt interior line on the next run.
        return { records, count, needsNewline: false, truncateAt: offset, truncatedBytes: carry.length };
      }
      addRecord(record, lineNumber + 1);
    }
    return { records, count, needsNewline: true, truncateAt: null, truncatedBytes: 0 };
  }
  return { records, count, needsNewline: false, truncateAt: null, truncatedBytes: 0 };
}

export async function openDetectionResults(resultsPath, { useCache = true } = {}) {
  const absolutePath = path.resolve(resultsPath);
  const lockPath = `${absolutePath}.lock`;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  let lockFd;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`结果文件正在使用，或上次异常退出留下了锁：${lockPath}\n请先确认没有检测进程在运行，再手动删除这个 .lock 文件后重试。`, { cause: error });
    }
    throw error;
  }
  let resultsFd;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (resultsFd !== undefined) fs.closeSync(resultsFd);
    } finally {
      try {
        fs.closeSync(lockFd);
      } finally {
        fs.unlinkSync(lockPath);
      }
    }
  };
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
    const loaded = await readDetectionCache(absolutePath, { retainRecords: useCache });
    if (loaded.truncateAt !== null) fs.truncateSync(absolutePath, loaded.truncateAt);
    resultsFd = fs.openSync(absolutePath, 'a');
    if (loaded.needsNewline) fs.writeFileSync(resultsFd, '\n');
    return {
      ...loaded,
      path: absolutePath,
      append(record) {
        if (closed) throw new Error('结果文件已经关闭。');
        validateRecord(record, '待写入');
        // Synchronous append is bounded to one small JSON record and naturally
        // applies backpressure; no pending writes can be lost on normal close.
        try {
          fs.writeFileSync(resultsFd, JSON.stringify(record) + '\n');
        } catch (cause) {
          // A partial write must remain the final line so the next run can repair it.
          const error = new Error(`结果写入失败，已停止以保护断点文件：${cause.message}`, { cause });
          error.code = 'DETECTION_RESULT_WRITE_FAILED';
          throw error;
        }
        if (useCache) loaded.records.set(record.file, record);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
