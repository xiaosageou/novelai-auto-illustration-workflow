#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MIN = 800;
const DEFAULT_MAX = 1000;

function printUsage() {
  console.log(`Usage:
  node tools/novel-to-sillytavern-chat.mjs <input.txt> [output.txt] [options]

Options:
  --speaker <name>       Message speaker name. Default: 小说旁白
  --start <timestamp>    First message time. Default: current local time
                        Example: "2026年7月10日 10:00"
  --min <chars>          Preferred minimum block size. Default: 800
  --max <chars>          Preferred maximum block size. Default: 1000
  --minutes <n>          Minutes added per message. Default: 1
  --format <jsonl|text>  Output format. Default: jsonl

JSONL output starts with chat_metadata, then one SillyTavern message per line.`);
}

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    speaker: '小说旁白',
    start: null,
    min: DEFAULT_MIN,
    max: DEFAULT_MAX,
    minutes: 1,
    format: 'jsonl'
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--help' || item === '-h') {
      args.help = true;
      continue;
    }
    if (item === '--speaker') {
      args.speaker = argv[++i] || args.speaker;
      continue;
    }
    if (item === '--start') {
      args.start = argv[++i] || null;
      continue;
    }
    if (item === '--min') {
      args.min = Number(argv[++i]) || DEFAULT_MIN;
      continue;
    }
    if (item === '--max') {
      args.max = Number(argv[++i]) || DEFAULT_MAX;
      continue;
    }
    if (item === '--minutes') {
      args.minutes = Number(argv[++i]) || 1;
      continue;
    }
    if (item === '--format') {
      args.format = argv[++i] || args.format;
      continue;
    }
    positional.push(item);
  }

  args.input = positional[0] || null;
  args.output = positional[1] || null;
  if (args.min > args.max) {
    throw new Error('--min cannot be greater than --max');
  }
  if (!['jsonl', 'text'].includes(args.format)) {
    throw new Error('--format must be jsonl or text');
  }
  return args;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTimestamp(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatIsoTimestamp(date) {
  return date.toISOString();
}

function parseStartTimestamp(raw) {
  if (!raw) return new Date();

  const match = String(raw).match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{1,2})$/);
  if (match) {
    const [, year, month, day, hour, minute] = match.map(Number);
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  throw new Error(`Invalid --start timestamp: ${raw}`);
}

function normalizeText(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isChapterHeading(line) {
  const text = line.trim();
  if (!text || text.length > 80) return false;
  return /^第[零〇一二三四五六七八九十百千万\d]+[章节卷回部][^\n]{0,50}$/.test(text)
    || /^chapter\s+\d+\b.{0,50}$/i.test(text);
}

function splitChapters(text) {
  const lines = normalizeText(text).split('\n');
  const chapters = [];
  let current = { title: '第1章', content: [] };
  let seenHeading = false;

  for (const line of lines) {
    if (isChapterHeading(line)) {
      if (seenHeading || current.content.some(item => item.trim())) {
        chapters.push(current);
      }
      seenHeading = true;
      current = { title: line.trim(), content: [] };
      continue;
    }
    current.content.push(line);
  }

  if (current.content.some(item => item.trim())) {
    chapters.push(current);
  }

  return chapters.length ? chapters : [{ title: '第1章', content: [normalizeText(text)] }];
}

function splitOversizedParagraph(paragraph, max) {
  if (paragraph.length <= max) return [paragraph];

  const sentenceParts = paragraph
    .split(/(?<=[。！？!?；;])\s*/u)
    .filter(Boolean);
  const units = sentenceParts.length > 1 ? sentenceParts : paragraph.match(new RegExp(`.{1,${max}}`, 'gu')) || [];
  const result = [];
  let buffer = '';

  for (const unit of units) {
    if (!buffer) {
      buffer = unit;
      continue;
    }
    if ((buffer + unit).length <= max) {
      buffer += unit;
    } else {
      result.push(buffer.trim());
      buffer = unit;
    }
  }
  if (buffer.trim()) result.push(buffer.trim());
  return result;
}

function paragraphUnits(chapterContent, max) {
  return normalizeText(chapterContent.join('\n'))
    .split(/\n\s*\n/g)
    .map(item => item.trim())
    .filter(Boolean)
    .flatMap(paragraph => splitOversizedParagraph(paragraph, max));
}

function chunkChapter(chapterContent, min, max) {
  const units = paragraphUnits(chapterContent, max);
  const chunks = [];
  let buffer = '';

  const append = (left, right) => left ? `${left}\n\n${right}` : right;

  for (const unit of units) {
    if (!buffer) {
      buffer = unit;
      continue;
    }

    const next = append(buffer, unit);
    if (next.length <= max) {
      buffer = next;
      continue;
    }

    if (buffer.length >= min) {
      chunks.push(buffer.trim());
      buffer = unit;
      continue;
    }

    chunks.push(buffer.trim());
    buffer = unit;
  }

  if (buffer.trim()) {
    const last = chunks[chunks.length - 1];
    if (last && buffer.length < min && (last.length + buffer.length + 2) <= max) {
      chunks[chunks.length - 1] = append(last, buffer).trim();
    } else {
      chunks.push(buffer.trim());
    }
  }

  return chunks;
}

function messageText(chapterNumber, chunkIndex, body) {
  return `<章节>第${chapterNumber}章第${chunkIndex + 1}块</章节>
<正文>
${body}
</正文>`;
}

function buildTextMessages(chapters, options) {
  const startDate = parseStartTimestamp(options.start);
  const messages = [];
  let messageIndex = 0;

  chapters.forEach((chapter, chapterIndex) => {
    const chapterNumber = chapterIndex + 1;
    const chunks = chunkChapter(chapter.content, options.min, options.max);
    chunks.forEach((body, chunkIndex) => {
      const date = new Date(startDate.getTime() + messageIndex * options.minutes * 60 * 1000);
      messages.push(`${options.speaker} [${formatTimestamp(date)}]
${messageText(chapterNumber, chunkIndex, body)}`);
      messageIndex += 1;
    });
  });

  return messages.join('\n\n\n');
}

function buildJsonlMessages(chapters, options) {
  const startDate = parseStartTimestamp(options.start);
  const lines = [
    JSON.stringify({
      chat_metadata: {
        integrity: cryptoRandomId(),
        note_prompt: '',
        note_interval: 1,
        note_position: 1,
        note_depth: 4,
        note_role: 0,
        'st-chatu8': { data: {} },
        timedWorldInfo: { sticky: {}, cooldown: {} },
        variables: {},
        tainted: true,
        lastInContextMessageId: 0
      },
      user_name: 'unused',
      character_name: options.speaker
    })
  ];
  let messageIndex = 0;

  chapters.forEach((chapter, chapterIndex) => {
    const chapterNumber = chapterIndex + 1;
    const chunks = chunkChapter(chapter.content, options.min, options.max);
    chunks.forEach((body, chunkIndex) => {
      const date = new Date(startDate.getTime() + messageIndex * options.minutes * 60 * 1000);
      const sendDate = formatIsoTimestamp(date);
      const mes = messageText(chapterNumber, chunkIndex, body);
      lines.push(JSON.stringify({
        name: options.speaker,
        is_user: false,
        is_system: false,
        send_date: sendDate,
        mes,
        extra: {
          send_date: sendDate,
          extra: {}
        },
        swipe_id: 0,
        swipes: [mes],
        swipe_info: [
          {
            send_date: sendDate,
            extra: {}
          }
        ]
      }));
      messageIndex += 1;
    });
  });

  return lines.join('\n');
}

function cryptoRandomId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16);
    const resolved = char === 'x' ? value : (value & 0x3) | 0x8;
    return resolved.toString(16);
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.input) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const inputPath = path.resolve(options.input);
  const outputPath = options.output
    ? path.resolve(options.output)
    : inputPath.replace(/(\.[^.]+)?$/, options.format === 'jsonl' ? '.sillytavern-chat.jsonl' : '.sillytavern-chat.txt');

  const text = fs.readFileSync(inputPath, 'utf8');
  const chapters = splitChapters(text);
  const output = options.format === 'jsonl'
    ? buildJsonlMessages(chapters, options)
    : buildTextMessages(chapters, options);
  fs.writeFileSync(outputPath, output, 'utf8');

  const messageCount = options.format === 'jsonl'
    ? Math.max(output.split('\n').length - 1, 0)
    : output.split(/\n\n\n/).filter(Boolean).length;
  console.log(`Wrote ${messageCount} messages to ${outputPath}`);
}

main();
