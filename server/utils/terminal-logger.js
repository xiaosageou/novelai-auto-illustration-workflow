import fs from 'fs';
import path from 'path';
import util from 'util';

const LOG_DIR = path.join(process.cwd(), 'logs');
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console)
};

let logFilePath = '';
let writeFailureReported = false;

function localDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localTimestamp(date = new Date()) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${localDateStamp(date)} ${hours}:${minutes}:${seconds}.${milliseconds}`;
}

function formatArgument(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  return util.inspect(value, {
    depth: 8,
    colors: false,
    compact: true,
    breakLength: Infinity
  });
}

function appendLog(level, args) {
  try {
    const currentPath = path.join(LOG_DIR, `server-${localDateStamp()}.log`);
    if (currentPath !== logFilePath) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logFilePath = currentPath;
    }

    const message = args.map(formatArgument).join(' ').replace(ANSI_ESCAPE_PATTERN, '');
    fs.appendFileSync(logFilePath, `[${localTimestamp()}] [${level}] ${message}\n`, 'utf8');
  } catch (error) {
    if (!writeFailureReported) {
      writeFailureReported = true;
      originalConsole.error(`[Terminal Logger] 写入日志失败: ${error.message}`);
    }
  }
}

function wrapConsoleMethod(method, level) {
  console[method] = (...args) => {
    originalConsole[method](...args);
    appendLog(level, args);
  };
}

fs.mkdirSync(LOG_DIR, { recursive: true });
wrapConsoleMethod('log', 'INFO');
wrapConsoleMethod('info', 'INFO');
wrapConsoleMethod('warn', 'WARN');
wrapConsoleMethod('error', 'ERROR');
wrapConsoleMethod('debug', 'DEBUG');

console.log('');
console.log(`===== 后端会话启动 | PID ${process.pid} =====`);
console.log(`[Terminal Logger] 实时日志保存至: ${path.join(LOG_DIR, `server-${localDateStamp()}.log`)}`);

process.on('uncaughtExceptionMonitor', (error, origin) => {
  appendLog('FATAL', [`未捕获异常 (${origin})`, error]);
});

process.on('unhandledRejection', (reason) => {
  appendLog('ERROR', ['未处理的 Promise 拒绝', reason]);
});

process.on('exit', (code) => {
  appendLog('INFO', [`===== 后端会话结束 | PID ${process.pid} | exit ${code} =====`]);
});

export function getTerminalLogPath() {
  return logFilePath || path.join(LOG_DIR, `server-${localDateStamp()}.log`);
}
