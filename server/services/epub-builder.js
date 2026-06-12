import JSZip from 'jszip';
import path from 'path';
import { promises as fs } from 'fs';

export class EPUBBuilder {
  constructor(title, author, outputPath) {
    this.title = title || "未命名书籍";
    this.author = author || "匿名";
    this.outputPath = outputPath;
    this.bookId = `urn:uuid:${this._uuidv4()}`;
    
    // 章节结构：[ { volume, chapter, text } ]
    this.chapters = [];
    // 图片资源：{ [name]: Buffer/Uint8Array }
    this.images = {};

    this.cssContent = `
body {
    font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
    margin: 5% 8%;
    color: #2c3e50;
    line-height: 1.8;
    font-size: 1.05em;
    background-color: #fcfbf9; /* 高雅浅黄色纸张质感 */
}
h1.volume-title {
    text-align: center;
    margin-top: 35%;
    font-size: 2.2em;
    color: #8e44ad; /* 霓虹紫色系 */
    text-shadow: 1px 1px 3px rgba(0,0,0,0.15);
    border-bottom: 2px solid #8e44ad;
    padding-bottom: 15px;
}
h2.chapter-title {
    font-size: 1.6em;
    color: #2c3e50;
    border-left: 5px solid #a855f7;
    padding-left: 12px;
    margin-top: 1.5em;
    margin-bottom: 1em;
}
p {
    text-indent: 2em;
    margin-top: 0.5em;
    margin-bottom: 0.5em;
    text-align: justify;
}
/* 插图排版 */
.illustration-container {
    text-align: center;
    margin: 2em 0;
    padding: 10px;
    background-color: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    box-shadow: 0 4px 15px rgba(0,0,0,0.06);
}
.illustration-container img {
    max-width: 95%;
    height: auto;
    border-radius: 8px;
}
.illustration-caption {
    font-size: 0.85em;
    color: #64748b;
    margin-top: 8px;
    font-style: italic;
    text-indent: 0;
    text-align: center;
}
    `.trim();
  }

  _uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  setCustomCSS(cssContent) {
    this.cssContent = cssContent.trim();
  }

  addImage(name, data) {
    this.images[name] = data;
  }

  addChapter(volume, chapter, text) {
    this.chapters.push({ volume, chapter, text });
  }

  _cleanTextToXHTML(text) {
    const lines = text.split(/\r?\n/);
    const xhtmlParts = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 匹配 [插图：文件名] 占位符
      const imgMatch = trimmed.match(/^\[插图[：:](.+)\]$/);
      if (imgMatch) {
        const imgName = imgMatch[1].trim();
        xhtmlParts.push([
          '<div class="illustration-container">',
          `  <img src="images/${imgName}" alt="${imgName}" />`,
          `  <div class="illustration-caption">章节精美插图 - ${imgName}</div>`,
          '</div>'
        ].join('\n'));
      } else {
        // XML 转义
        const escaped = trimmed
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
        xhtmlParts.push(`<p>${escaped}</p>`);
      }
    }

    return xhtmlParts.join('\n');
  }

  /**
   * 打包构建并写入 EPUB 文件
   */
  async build() {
    const zip = new JSZip();

    // 1. mimetype (必须是第一个文件，且不进行压缩存储)
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

    // 2. META-INF/container.xml
    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`.trim();
    zip.file("META-INF/container.xml", containerXml);

    // 3. OEBPS/style.css
    zip.file("OEBPS/style.css", this.cssContent);

    const manifestFiles = []; // { id, href, mediaType }
    const xhtmlSpineItems = [];
    const tocEntries = [];

    let currentVolume = "";
    let volIdx = 0;
    let chapIdx = 0;

    // 4. 生成 XHTML 章节文件
    for (const item of this.chapters) {
      const { volume, chapter, text } = item;

      // 生成分卷扉页
      if (volume && volume !== currentVolume) {
        currentVolume = volume;
        volIdx++;
        const volId = `vol_${volIdx}`;
        const volHref = `vol_${volIdx}.xhtml`;

        const volXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <title>${volume}</title>
  <link rel="stylesheet" href="style.css" type="text/css" />
</head>
<body>
  <h1 class="volume-title">${volume}</h1>
</body>
</html>`.trim();

        zip.file(`OEBPS/${volHref}`, volXhtml);
        manifestFiles.push({ id: volId, href: volHref, mediaType: "application/xhtml+xml" });
        xhtmlSpineItems.push(volId);

        tocEntries.push({
          type: "volume",
          title: volume,
          href: volHref,
          id: volId,
          chapters: []
        });
      }

      // 生成章节正文页
      chapIdx++;
      const chapId = `chap_${chapIdx}`;
      const chapHref = `chap_${chapIdx}.xhtml`;
      const xhtmlBody = this._cleanTextToXHTML(text);

      const chapXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head>
  <title>${chapter}</title>
  <link rel="stylesheet" href="style.css" type="text/css" />
</head>
<body>
  <h2 class="chapter-title">${chapter}</h2>
  ${xhtmlBody}
</body>
</html>`.trim();

      zip.file(`OEBPS/${chapHref}`, chapXhtml);
      manifestFiles.push({ id: chapId, href: chapHref, mediaType: "application/xhtml+xml" });
      xhtmlSpineItems.push(chapId);

      const chapEntry = {
        type: "chapter",
        title: chapter,
        href: chapHref,
        id: chapId
      };

      if (tocEntries.length > 0 && tocEntries[tocEntries.length - 1].type === "volume") {
        tocEntries[tocEntries.length - 1].chapters.push(chapEntry);
      } else {
        tocEntries.push(chapEntry);
      }
    }

    // 5. 写入打包插图资源 OEBPS/images/
    for (const [imgName, imgData] of Object.entries(this.images)) {
      zip.file(`OEBPS/images/${imgName}`, imgData);
      const imgId = `img_${imgName.replace(/\./g, '_')}`;
      
      const ext = path.extname(imgName).toLowerCase();
      let mediaType = "image/png";
      if (ext === ".jpg" || ext === ".jpeg") mediaType = "image/jpeg";
      else if (ext === ".gif") mediaType = "image/gif";
      else if (ext === ".webp") mediaType = "image/webp";

      manifestFiles.push({ id: imgId, href: `images/${imgName}`, mediaType });
    }

    // 6. 生成 OEBPS/content.opf
    const manifestItems = [
      '    <item id="css" href="style.css" media-type="text/css" />',
      '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />',
      ...manifestFiles.map(f => `    <item id="${f.id}" href="${f.href}" media-type="${f.mediaType}" />`)
    ];

    const spineItems = xhtmlSpineItems.map(id => `    <itemref idref="${id}" />`);

    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${this.title}</dc:title>
    <dc:creator>${this.author}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:identifier id="BookID">${this.bookId}</dc:identifier>
    <meta property="dcterms:modified">2026-06-01T12:00:00Z</meta>
  </metadata>
  <manifest>
\n${manifestItems.join('\n')}
  </manifest>
  <spine toc="ncx">
\n${spineItems.join('\n')}
  </spine>
</package>`.trim();

    zip.file("OEBPS/content.opf", contentOpf);

    // 7. 生成 OEBPS/toc.ncx (目录导航)
    const navPoints = [];
    let playOrder = 0;

    for (const entry of tocEntries) {
      playOrder++;
      if (entry.type === "volume") {
        const volPoints = [];
        for (const chap of entry.chapters) {
          playOrder++;
          volPoints.push(`    <navPoint id="${chap.id}" playOrder="${playOrder}">
      <navLabel><text>${chap.title}</text></navLabel>
      <content src="${chap.href}" />
    </navPoint>`);
        }

        navPoints.push(`  <navPoint id="${entry.id}" playOrder="${playOrder - volPoints.length}">
    <navLabel><text>${entry.title}</text></navLabel>
    <content src="${entry.href}" />
\n${volPoints.join('\n')}
  </navPoint>`);
      } else {
        navPoints.push(`  <navPoint id="${entry.id}" playOrder="${playOrder}">
    <navLabel><text>${entry.title}</text></navLabel>
    <content src="${entry.href}" />
  </navPoint>`);
      }
    }

    const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${this.bookId}" />
    <meta name="dtb:depth" content="2" />
    <meta name="dtb:totalPageCount" content="0" />
    <meta name="dtb:maxPageNumber" content="0" />
  </head>
  <docTitle><text>${this.title}</text></docTitle>
  <docAuthor><text>${this.author}</text></docAuthor>
  <navMap>
\n${navPoints.join('\n')}
  </navMap>
</ncx>`.trim();

    zip.file("OEBPS/toc.ncx", tocNcx);

    // 8. 生成 EPUB 压缩文件
    const content = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });

    // 确保输出路径父文件夹存在
    await fs.mkdir(path.dirname(this.outputPath), { recursive: true });
    await fs.writeFile(this.outputPath, content);

    console.log(`[EPUB Builder] 成功打包 EPUB 文件 -> ${this.outputPath}`);
    return this.outputPath;
  }
}
