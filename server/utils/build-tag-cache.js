import fs from 'fs';
import path from 'path';
import CryptoJS from 'crypto-js';

const tagDataDir = 'd:/antigravity/nai/st-chatu8-main/tagData';
const outputDir = 'd:/antigravity/nai/server/database';
const encryptionKey = "a-very-secret-key-that-is-not-so-secret";

async function buildCache() {
  console.log('[Tag Cache Builder] Starting tag cache fusion...');
  
  if (!fs.existsSync(tagDataDir)) {
    console.error(`Error: tagData directory does not exist at ${tagDataDir}`);
    return;
  }
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 搜集所有的 danbooru json 和 NSFW json
  const files = [];
  for (let i = 1; i <= 25; i++) {
    const numStr = String(i).padStart(3, '0');
    files.push(`danbooru_${numStr}.json`);
  }
  files.push('tag_NSFW001.json');

  const allTags = [];
  const seenEnglishTags = new Set();

  for (const fileName of files) {
    const filePath = path.join(tagDataDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`[Warning] File not found: ${fileName}, skipping.`);
      continue;
    }

    try {
      console.log(`[Processing] Reading and decrypting: ${fileName}...`);
      const encryptedText = fs.readFileSync(filePath, 'utf-8').trim();
      
      // 解密
      const bytes = CryptoJS.AES.decrypt(encryptedText, encryptionKey);
      const decryptedText = bytes.toString(CryptoJS.enc.Utf8);
      
      if (!decryptedText) {
        console.error(`[Error] Decrypted text is empty for ${fileName}`);
        continue;
      }

      const fileData = JSON.parse(decryptedText);
      
      // danbooru_xxx.json 文件的结构可能是 { key: [tags] } 或者直接是 { tags_array }
      // 从之前的 test-decrypt.js 输出看，它是 { key: [tags] } 的对象，例如：
      // {
      //   "0": [ { tag, translate, hot, ... }, ... ]
      // }
      // 我们需要遍历所有的 values
      let count = 0;
      
      const processTagItem = (item) => {
        if (!item || !item.tag) return;
        
        const english = item.tag.trim().toLowerCase();
        const chinese = (item.translate || '').trim();
        const hot = Number(item.hot) || 0;

        if (!english) return;
        if (!chinese || chinese === '无翻译') return;

        // 排重，保留热度高的
        if (seenEnglishTags.has(english)) {
          return;
        }

        seenEnglishTags.add(english);
        allTags.push({
          e: english,
          c: chinese,
          h: hot
        });
        count++;
      };

      if (Array.isArray(fileData)) {
        for (const item of fileData) {
          processTagItem(item);
        }
      } else if (typeof fileData === 'object') {
        for (const tagsList of Object.values(fileData)) {
          if (Array.isArray(tagsList)) {
            for (const item of tagsList) {
              processTagItem(item);
            }
          }
        }
      }
      
      console.log(`[Success] Extracted ${count} valid tags from ${fileName}`);
    } catch (e) {
      console.error(`[Error] Failed to process ${fileName}:`, e.message);
    }
  }

  // 按热度倒序排序，有助于检索时优先匹配常用词
  allTags.sort((a, b) => b.h - a.h);

  const outputPath = path.join(outputDir, 'danbooru_tags.json');
  console.log(`[Saving] Writing ${allTags.length} merged tags to ${outputPath}...`);
  fs.writeFileSync(outputPath, JSON.stringify(allTags, null, 2), 'utf-8');
  console.log('[Tag Cache Builder] All done! Cache built successfully.');
}

buildCache();
