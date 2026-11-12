/**
 * WAV 处理：解析头部、流式写入、PCM 提取、尽力删除。
 *
 * TTS 返回 24kHz/16bit/单声道 WAV。整章音频按块顺序拼成一个 WAV，
 * 用「先占位写头 → 流式追加 PCM → 回头补头」，内存恒定、磁盘只留一份临时文件。
 */

import fs from 'node:fs';

const RIFF = 'RIFF';
const WAVE = 'WAVE';
const HEADER_BYTES = 44;

/** 解析 WAV 头，返回格式信息与 PCM 数据区间（支持额外 chunk） */
export function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) throw new Error('WAV 数据过短，无法解析');
  if (buffer.toString('ascii', 0, 4) !== RIFF || buffer.toString('ascii', 8, 12) !== WAVE) {
    throw new Error('不是合法的 RIFF/WAVE 数据');
  }

  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV 缺少 fmt chunk');
      const available = buffer.length - body;
      const dataBytes = size === 0 || size > available ? available : size;
      return { ...fmt, dataOffset: body, dataBytes };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV 缺少 data chunk');
}

/** 取出 PCM 裸数据 */
export function extractPcm(buffer) {
  const info = parseWav(buffer);
  return { ...info, pcm: buffer.subarray(info.dataOffset, info.dataOffset + info.dataBytes) };
}

export function durationFromBytes(dataBytes, { sampleRate, channels, bitsPerSample }) {
  const bytesPerFrame = (bitsPerSample / 8) * channels;
  if (!bytesPerFrame || !sampleRate) return 0;
  return dataBytes / (bytesPerFrame * sampleRate);
}

/** 流式 WAV 写入器 */
export class WavStreamWriter {
  constructor(filePath, { sampleRate, channels = 1, bitsPerSample = 16 }) {
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitsPerSample = bitsPerSample;
    this.dataBytes = 0;
    this.fd = null;
  }

  open() {
    this.fd = fs.openSync(this.filePath, 'w');
    fs.writeSync(this.fd, Buffer.alloc(HEADER_BYTES));
    return this;
  }

  append(pcm) {
    if (!pcm || !pcm.length) return;
    fs.writeSync(this.fd, pcm);
    this.dataBytes += pcm.length;
  }

  appendSilence(seconds) {
    const frames = Math.round(this.sampleRate * seconds);
    if (frames <= 0) return;
    const total = frames * this.channels * (this.bitsPerSample / 8);
    const chunk = Buffer.alloc(Math.min(total, 1 << 20));
    let left = total;
    while (left > 0) {
      const n = Math.min(left, chunk.length);
      fs.writeSync(this.fd, n === chunk.length ? chunk : chunk.subarray(0, n));
      left -= n;
    }
    this.dataBytes += total;
  }

  finish() {
    if (this.fd === null) return this.durationSec;
    const header = buildHeader({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample,
      dataBytes: this.dataBytes,
    });
    fs.writeSync(this.fd, header, 0, header.length, 0);
    fs.closeSync(this.fd);
    this.fd = null;
    return this.durationSec;
  }

  abort() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* ignore */ }
      this.fd = null;
    }
  }

  get durationSec() {
    return durationFromBytes(this.dataBytes, this);
  }
}

/** 构造 44 字节标准 PCM WAV 头 */
export function buildHeader({ sampleRate, channels = 1, bitsPerSample = 16, dataBytes }) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const buf = Buffer.alloc(HEADER_BYTES);
  buf.write(RIFF, 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write(WAVE, 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/**
 * 尽力删除文件或目录，永不抛错。
 *
 * 某些安全策略会把删除接管成「移入回收站」，即使成功也可能抛错；
 * 有声书生产不能因为清理失败就整章失败。
 */
export function removeTree(target, { recursive = true } = {}) {
  if (!target) return true;
  try {
    fs.rmSync(target, { recursive, force: true, maxRetries: 2 });
  } catch { /* 交给手工兜底 */ }
  if (!fs.existsSync(target)) return true;

  const walk = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    if (stat.isDirectory()) {
      if (recursive) {
        let names = [];
        try { names = fs.readdirSync(p); } catch { names = []; }
        for (const name of names) walk(`${p}/${name}`);
      }
      try { fs.rmdirSync(p); } catch { /* ignore */ }
    } else {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  };
  walk(target);
  return !fs.existsSync(target);
}
