import { inflateSync } from 'fflate';

const PNG签名 = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG签名 = new Uint8Array([0xff, 0xd8, 0xff]);
const GIF87签名 = new Uint8Array([71, 73, 70, 56, 55, 97]);
const GIF89签名 = new Uint8Array([71, 73, 70, 56, 57, 97]);
const RIFF签名 = new Uint8Array([82, 73, 70, 70]);
const WEBP签名 = new Uint8Array([87, 69, 66, 80]);
const PNG_IEND块签名 = new Uint8Array([73, 69, 78, 68]);

const UTF8解码器 = new TextDecoder('utf-8');

function 读取ZipUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function 读取ZipUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function 读取Uint32BE(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return 0;
  return ((bytes[offset] << 24) >>> 0)
    + (bytes[offset + 1] << 16)
    + (bytes[offset + 2] << 8)
    + bytes[offset + 3];
}

function 字节序列匹配(bytes, offset, signature) {
  if (offset < 0 || offset + signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function 查找字节序列(bytes, signature, startIndex = 0) {
  const start = Math.max(0, startIndex);
  for (let offset = start; offset <= bytes.length - signature.length; offset += 1) {
    if (字节序列匹配(bytes, offset, signature)) return offset;
  }
  return -1;
}

function 图片字节匹配文件名(bytes, fileName) {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.png')) {
    return bytes.length >= 8
      && bytes[0] === 137
      && bytes[1] === 80
      && bytes[2] === 78
      && bytes[3] === 71
      && bytes[4] === 13
      && bytes[5] === 10
      && bytes[6] === 26
      && bytes[7] === 10;
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (lower.endsWith('.webp')) {
    return bytes.length >= 12
      && bytes[0] === 82
      && bytes[1] === 73
      && bytes[2] === 70
      && bytes[3] === 70
      && bytes[8] === 87
      && bytes[9] === 69
      && bytes[10] === 66
      && bytes[11] === 80;
  }
  if (lower.endsWith('.gif')) {
    return bytes.length >= 6
      && bytes[0] === 71
      && bytes[1] === 73
      && bytes[2] === 70
      && bytes[3] === 56;
  }
  return bytes.length > 0;
}

function 提取PNG范围(bytes, start) {
  if (!字节序列匹配(bytes, start, PNG签名)) return null;
  let offset = start + PNG签名.length;
  while (offset + 12 <= bytes.length) {
    const length = 读取Uint32BE(bytes, offset);
    const typeOffset = offset + 4;
    const dataEnd = offset + 8 + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isFinite(length) || chunkEnd > bytes.length) return null;
    if (字节序列匹配(bytes, typeOffset, PNG_IEND块签名)) {
      return bytes.subarray(start, chunkEnd);
    }
    offset = chunkEnd;
  }
  return null;
}

function 提取JPEG范围(bytes, start) {
  if (!字节序列匹配(bytes, start, JPEG签名)) return null;
  for (let offset = start + 3; offset < bytes.length - 1; offset += 1) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === 0xd9) {
      return bytes.subarray(start, offset + 2);
    }
  }
  return null;
}

function 提取GIF范围(bytes, start) {
  if (!字节序列匹配(bytes, start, GIF87签名) && !字节序列匹配(bytes, start, GIF89签名)) return null;
  for (let offset = start + 6; offset < bytes.length; offset += 1) {
    if (bytes[offset] === 0x3b) {
      return bytes.subarray(start, offset + 1);
    }
  }
  return null;
}

function 提取WEBP范围(bytes, start) {
  if (!字节序列匹配(bytes, start, RIFF签名) || !字节序列匹配(bytes, start + 8, WEBP签名)) return null;
  const riffSize = 读取ZipUint32LE(bytes, start + 4);
  const end = start + 8 + riffSize;
  if (riffSize <= 0 || end > bytes.length) return null;
  return bytes.subarray(start, end);
}

export function detectImageMimeType(fileName) {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

export function uint8ArrayToDataUrl(bytes, mimeType) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export function 从二进制中提取首张图片(bytes, startIndex = 0) {
  const candidates = [
    { fileName: 'image_0.png', offset: 查找字节序列(bytes, PNG签名, startIndex), extract: 提取PNG范围 },
    { fileName: 'image_0.jpg', offset: 查找字节序列(bytes, JPEG签名, startIndex), extract: 提取JPEG范围 },
    { fileName: 'image_0.gif', offset: 查找字节序列(bytes, GIF87签名, startIndex), extract: 提取GIF范围 },
    { fileName: 'image_0.gif', offset: 查找字节序列(bytes, GIF89签名, startIndex), extract: 提取GIF范围 },
    { fileName: 'image_0.webp', offset: 查找字节序列(bytes, RIFF签名, startIndex), extract: 提取WEBP范围 }
  ]
    .filter((candidate) => candidate.offset >= 0)
    .sort((a, b) => a.offset - b.offset);
  for (const candidate of candidates) {
    const imageBytes = candidate.extract(bytes, candidate.offset);
    if (imageBytes?.length && 图片字节匹配文件名(imageBytes, candidate.fileName)) {
      return { fileName: candidate.fileName, imageBytes };
    }
  }
  return null;
}

export function 从Zip中央目录提取首张图片(bytes) {
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (读取ZipUint32LE(bytes, offset) !== 0x02014b50) continue;

    const compressionMethod = 读取ZipUint16LE(bytes, offset + 10);
    const compressedSize = 读取ZipUint32LE(bytes, offset + 20);
    const fileNameLength = 读取ZipUint16LE(bytes, offset + 28);
    const extraLength = 读取ZipUint16LE(bytes, offset + 30);
    const commentLength = 读取ZipUint16LE(bytes, offset + 32);
    const localHeaderOffset = 读取ZipUint32LE(bytes, offset + 42);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > bytes.length) return null;

    const fileName = UTF8解码器.decode(bytes.subarray(fileNameStart, fileNameEnd));
    if (!/\.(png|jpe?g|webp|gif)$/i.test(fileName)) {
      offset = fileNameEnd + extraLength + commentLength - 1;
      continue;
    }

    if (localHeaderOffset + 30 > bytes.length || 读取ZipUint32LE(bytes, localHeaderOffset) !== 0x04034b50) {
      return null;
    }
    const localFileNameLength = 读取ZipUint16LE(bytes, localHeaderOffset + 26);
    const localExtraLength = 读取ZipUint16LE(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > bytes.length || dataEnd > bytes.length) return null;

    const compressedBytes = bytes.subarray(dataStart, dataEnd);
    if (compressionMethod === 0) {
      return 图片字节匹配文件名(compressedBytes, fileName) ? { fileName, imageBytes: compressedBytes } : null;
    }
    if (compressionMethod === 8) {
      const imageBytes = inflateSync(compressedBytes);
      return 图片字节匹配文件名(imageBytes, fileName) ? { fileName, imageBytes } : null;
    }
    throw new Error(`不支持的 ZIP 压缩方式: ${compressionMethod}`);
  }

  return null;
}

export function 从Zip本地文件头提取首张图片(bytes) {
  for (let offset = 0; offset <= bytes.length - 30; offset += 1) {
    if (读取ZipUint32LE(bytes, offset) !== 0x04034b50) continue;

    const compressionMethod = 读取ZipUint16LE(bytes, offset + 8);
    const compressedSize = 读取ZipUint32LE(bytes, offset + 18);
    const fileNameLength = 读取ZipUint16LE(bytes, offset + 26);
    const extraLength = 读取ZipUint16LE(bytes, offset + 28);
    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > bytes.length) continue;

    const fileName = UTF8解码器.decode(bytes.subarray(fileNameStart, fileNameEnd));
    const dataStart = fileNameEnd + extraLength;
    if (dataStart >= bytes.length || !/\.(png|jpe?g|webp|gif)$/i.test(fileName)) {
      offset = Math.max(offset, dataStart - 1);
      continue;
    }

    try {
      if (compressionMethod === 8) {
        const compressedBytes = compressedSize > 0 && dataStart + compressedSize <= bytes.length
          ? bytes.subarray(dataStart, dataStart + compressedSize)
          : bytes.subarray(dataStart);
        const imageBytes = inflateSync(compressedBytes);
        if (图片字节匹配文件名(imageBytes, fileName)) {
          return { fileName, imageBytes };
        }
      } else if (compressionMethod === 0 && compressedSize > 0 && dataStart + compressedSize <= bytes.length) {
        const imageBytes = bytes.subarray(dataStart, dataStart + compressedSize);
        if (图片字节匹配文件名(imageBytes, fileName)) {
          return { fileName, imageBytes };
        }
      } else if (compressionMethod === 0) {
        const imageEntry = 从二进制中提取首张图片(bytes, dataStart);
        if (imageEntry) {
          return {
            fileName: fileName || imageEntry.fileName,
            imageBytes: imageEntry.imageBytes
          };
        }
      }
    } catch {
      // 继续扫描，因为 PK 签名可能出现在压缩数据中
    }
  }

  return null;
}

/**
 * 核心对外接口：解压 ZIP 或从二进制数据中智能扫描并提取首张图片
 */
export function extractFirstImageFromZip(buffer) {
  const bytes = new Uint8Array(buffer);
  return 从Zip中央目录提取首张图片(bytes) 
    || 从Zip本地文件头提取首张图片(bytes) 
    || 从二进制中提取首张图片(bytes);
}
