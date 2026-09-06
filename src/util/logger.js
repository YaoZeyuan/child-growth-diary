import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";
import { Console } from "node:console";
import dayjs from "dayjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Logger {
  constructor(options = {}) {
    // 允许自定义日志目录，默认根目录下的 ./log
    this.logDir =
      options.logDir || path.resolve(path.join(__dirname, "..", "..", "log"));

    console.log("日志将输出于 => ", this.logDir);
    // 创建原生 Console 实例，保证控制台输出行为与系统 console 完全一致
    this.nativeConsole = new Console({
      stdout: process.stdout,
      stderr: process.stderr,
    });

    this._ensureLogDir();
  }

  /**
   * 确保日志目录存在
   */
  _ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * 清除 ANSI 颜色控制字符（避免控制台颜色写入日志文件变乱码）
   */
  _stripAnsi(str) {
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  }

  /**
   * 格式化参数为字符串
   */
  _formatArgs(args) {
    return args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        return util.inspect(arg, { depth: null, colors: false });
      })
      .join(" ");
  }

  /**
   * 写入日志的核心私有方法
   */
  _writeLog(level, args) {
    const now = dayjs();
    const timeStr = now.format("YYYY-MM-DD HH:mm:ss");
    const dateStr = now.format("YYYY-MM-DD");

    // 1. 格式化日志内容
    const rawMessage = this._formatArgs(args);
    const cleanMessage = this._stripAnsi(rawMessage);
    const logLine = `[${timeStr}] [${level.toUpperCase()}] ${cleanMessage}\n`;

    // 2. 拼接当天文件名：./log/monitor-YYYY-MM-DD.log
    const logFilePath = path.join(this.logDir, `monitor-${dateStr}.log`);

    // 3. 追加写入文件（UTF-8 编码，跨平台无乱码）
    try {
      fs.appendFileSync(logFilePath, logLine, "utf8");
    } catch (err) {
      this.nativeConsole.error("写入日志文件失败:", err);
    }
  }

  /**
   * 对应 console.log
   */
  log(...args) {
    this.nativeConsole.log(...args);
    this._writeLog("info", args);
  }

  /**
   * 对应 console.info
   */
  info(...args) {
    this.nativeConsole.info(...args);
    this._writeLog("info", args);
  }

  /**
   * 对应 console.warn
   */
  warn(...args) {
    this.nativeConsole.warn(...args);
    this._writeLog("warn", args);
  }

  /**
   * 对应 console.error
   */
  error(...args) {
    this.nativeConsole.error(...args);
    this._writeLog("error", args);
  }
}

// 导出单例，方便直接作为默认 logger 使用
export const logger = new Logger();
export default Logger;
