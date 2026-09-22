import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesCachedResult, openDetectionResults, PREPROCESS_VERSION } from './detection-cache.js';
import { imageUri, writeDetectionReports } from './detection-report.js';

const HELP = `判断图片中是否有人（宝宝或成人均算）。

用法：
  node src/detect-person.js --image "output/某张图片.jpg"
  node src/detect-person.js --input output --limit 100
  node src/detect-person.js --all --no-html

选项：
  --image PATH       单张图片；标准输出只有 true / false，出错时不输出布尔值
  --input DIR        批量扫描目录，默认 output；递归扫描 .jpg 和 .jpeg
  --limit N          检查 URI 升序的前 N 张，默认 100（包含命中缓存的图片）
  --all              检测全部图片，不能与 --limit 同时使用
  --json PATH        有人图片 URI 数组，默认 detection-results/person-images.json
  --html PATH        十列查验页，默认 detection-results/person-review.html
  --no-html          不生成 HTML；全量数十万张时建议使用
  --cache PATH       内部断点缓存，默认 detection-results/person-results.jsonl
  --results PATH     --cache 的兼容别名；后续合成请使用 --json 输出的文件
  --confidence N     人体置信度阈值，默认 0.15，范围 (0, 1]
  --provider NAME    推理设备：auto / cpu / dml，默认 auto
  --device-id N      DirectML 显卡编号，默认 0
  --model PATH       自定义 YOLO26 ONNX 模型路径
  --no-cache         重新检测选中图片，并追加新的结果
  --help, -h         显示帮助

相对路径均相对于当前工作目录。默认查验 100 张，缓存逐张保存，可中断后继续。
JSON / HTML 仅包含本次选中并尝试检测的图片，每次覆盖，不混入历史缓存。
同一缓存不能被两个进程同时写入。错误在 HTML 中显示为灰色，不记为 false。
`;

export function parseArgs(args) {
  const options = {
    input: 'output', results: 'detection-results/person-results.jsonl',
    jsonPath: 'detection-results/person-images.json', htmlPath: 'detection-results/person-review.html', limit: 100,
    confidence: 0.15, provider: 'auto', deviceId: 0, useCache: true,
  };
  const valueFlags = new Map([
    ['--image', 'image'], ['--input', 'input'], ['--results', 'results'],
    ['--cache', 'results'], ['--json', 'jsonPath'], ['--html', 'htmlPath'],
    ['--limit', 'limit'], ['--confidence', 'confidence'], ['--provider', 'provider'],
    ['--device-id', 'deviceId'], ['--model', 'modelPath'],
  ]);
  const supplied = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--no-cache') {
      options.useCache = false;
      supplied.add(flag);
    } else if (flag === '--all' || flag === '--no-html') {
      options[flag === '--all' ? 'all' : 'noHtml'] = true;
      supplied.add(flag);
    } else if (valueFlags.has(flag)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} 后面需要一个值。`);
      options[valueFlags.get(flag)] = value;
      supplied.add(flag);
    } else {
      throw new Error(`未知参数：${flag}。使用 --help 查看用法。`);
    }
  }
  if (options.help) return options;
  for (const name of ['confidence', 'deviceId', 'limit']) {
    if (options[name] !== undefined) options[name] = Number(options[name]);
  }
  if (!Number.isFinite(options.confidence) || options.confidence <= 0 || options.confidence > 1) {
    throw new Error('--confidence 必须大于 0 且不超过 1。');
  }
  if (!Number.isSafeInteger(options.deviceId) || options.deviceId < 0) {
    throw new Error('--device-id 必须是大于等于 0 的整数。');
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error('--limit 必须是大于等于 1 的整数。');
  }
  if (!['auto', 'cpu', 'dml'].includes(options.provider)) {
    throw new Error('--provider 只能是 auto、cpu 或 dml。');
  }
  if (options.all && supplied.has('--limit')) throw new Error('--all 不能与 --limit 同时使用。');
  if (options.noHtml && supplied.has('--html')) throw new Error('--no-html 不能与 --html 同时使用。');
  if (supplied.has('--cache') && supplied.has('--results')) throw new Error('--cache 和 --results 是同一参数，不能同时使用。');
  if (options.image && ['--input', '--results', '--cache', '--limit', '--all', '--json', '--html', '--no-html', '--no-cache'].some(flag => supplied.has(flag))) {
    throw new Error('--image 单张模式不能同时使用批量检测的输入、数量、结果或缓存选项。');
  }
  if (options.all) options.limit = undefined;
  if (options.noHtml) options.htmlPath = undefined;
  if (!options.image) {
    if (path.extname(options.jsonPath).toLowerCase() !== '.json') throw new Error('--json 必须是 .json 文件。');
    if (options.htmlPath && !/\.html?$/i.test(options.htmlPath)) throw new Error('--html 必须是 .html 或 .htm 文件。');
    const paths = [options.results, options.jsonPath, options.htmlPath].filter(Boolean).map(file => {
      const absolute = path.resolve(file);
      return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    });
    if (new Set(paths).size !== paths.length) throw new Error('JSON、HTML 和内部缓存必须使用不同文件。');
  }
  return options;
}

export async function findImages(directory) {
  const root = path.resolve(directory);
  const files = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) files.push(entryPath);
    }
  }
  // Code-point order is stable across machines, unlike locale-sensitive sorting.
  return files.sort((a, b) => {
    const left = imageUri(a), right = imageUri(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { createPersonDetector } = await import('./person-detector.js');
  if (options.image) {
    const detector = await createPersonDetector(options);
    try {
      const hasPerson = await detector.detect(path.resolve(options.image));
      process.stdout.write(`${hasPerson}\n`);
    } finally {
      await detector.close();
    }
    return;
  }

  console.error(`扫描图片目录：${path.resolve(options.input)}`);
  const allFiles = await findImages(options.input);
  const files = options.limit === undefined ? allFiles : allFiles.slice(0, options.limit);
  console.error(`找到 ${allFiles.length.toLocaleString()} 张图片，本次选择 ${files.length.toLocaleString()} 张。`);
  if (!files.length) {
    await writeDetectionReports({ records: [], jsonPath: options.jsonPath, htmlPath: options.htmlPath,
      metadata: { threshold: options.confidence, selected: 0, total: allFiles.length, interrupted: false, errors: 0 } });
    console.error('没有图片，已输出空 JSON 清单和所选查验页。');
    return;
  }
  const results = await openDetectionResults(options.results, { useCache: options.useCache });
  let detector;
  let interrupted = false;
  const requestStop = () => {
    if (!interrupted) console.error('收到中断，当前图片处理完后退出，已完成结果会保留。');
    interrupted = true;
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  try {
    if (results.truncatedBytes) console.error(`已清理上次未写完的末行（${results.truncatedBytes} 字节）。`);
    detector = await createPersonDetector(options);
    console.error(`推理设备：${detector.provider}，阈值：${options.confidence}，结果：${results.path}`);
    const counts = { processed: 0, cached: 0, detected: 0, positive: 0, negative: 0, errors: 0 };
    const reportRecords = [];
    const started = performance.now();
    let lastLog = started;
    for (const file of files) {
      if (interrupted) break;
      try {
        const stat = await fs.stat(file);
        const fingerprint = {
          file, size: stat.size, mtimeMs: stat.mtimeMs, modelSha256: detector.modelSha256,
          threshold: options.confidence, preprocessVersion: PREPROCESS_VERSION, provider: detector.provider,
        };
        const cached = results.records.get(file);
        let hasPerson, score;
        if (options.useCache && matchesCachedResult(cached, fingerprint)) {
          hasPerson = cached.hasPerson;
          score = cached.confidence;
          counts.cached += 1;
        } else {
          const detection = await detector.inspect(file);
          if (typeof detection.hasPerson !== 'boolean' || !Number.isFinite(detection.confidence)) {
            throw new Error('模型返回无效的检测结果。');
          }
          const after = await fs.stat(file);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
            throw new Error('检测期间图片发生变化，本张未缓存，请重试。');
          }
          hasPerson = detection.hasPerson;
          score = detection.confidence;
          results.append({ ...fingerprint, hasPerson, confidence: detection.confidence });
          counts.detected += 1;
        }
        reportRecords.push({ file, hasPerson, confidence: score });
        if (hasPerson) counts.positive += 1;
        else counts.negative += 1;
      } catch (error) {
        if (error.code === 'DETECTION_RESULT_WRITE_FAILED') throw error;
        counts.errors += 1;
        reportRecords.push({ file, error: error.message });
        console.error(`检测失败：${file}\n  ${error.message}`);
      }
      counts.processed += 1;
      const now = performance.now();
      if (now - lastLog >= 5000 || counts.processed === files.length) {
        console.error(`[${counts.processed}/${files.length}] 检出人 ${counts.positive}，未检出 ${counts.negative}，缓存 ${counts.cached}，失败 ${counts.errors}，用时 ${((now - started) / 1000).toFixed(1)} 秒`);
        lastLog = now;
      }
    }
    const report = await writeDetectionReports({
      records: reportRecords, jsonPath: options.jsonPath, htmlPath: options.htmlPath,
      metadata: { threshold: options.confidence, selected: files.length, total: allFiles.length, interrupted, errors: counts.errors },
    });
    console.error(`${interrupted ? '已中断' : '已完成'}：新检测 ${counts.detected}，缓存 ${counts.cached}，检出人 ${counts.positive}，未检出 ${counts.negative}，失败 ${counts.errors}。\n有人图片 JSON：${report.jsonPath}${report.htmlPath ? `\n查验页：${report.htmlPath}` : ''}`);
    if (counts.errors) process.exitCode = 1;
    if (interrupted) process.exitCode = 130;
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    try {
      if (detector) await detector.close();
    } finally {
      results.close();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
