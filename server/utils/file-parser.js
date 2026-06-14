import JSZip from 'jszip';

/**
 * 解码 XML/HTML 实体字符
 */
function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * 解析 .txt 小说文本，自动识别 utf-8 和 gbk 编码
 */
export function parseTxt(buffer) {
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(buffer);
  } catch (e) {
    try {
      const gbkDecoder = new TextDecoder('gbk');
      return gbkDecoder.decode(buffer);
    } catch (err) {
      return buffer.toString('utf-8');
    }
  }
}

/**
 * 解析 .docx 微软 Word 格式小说文本
 */
export async function parseDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error("无效的 Word 文档：未找到 word/document.xml");
  }
  const xmlText = await docFile.async("text");
  
  const paragraphs = [];
  // 匹配段落 <w:p>
  const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pMatch;
  
  while ((pMatch = pRegex.exec(xmlText)) !== null) {
    const pContent = pMatch[1];
    
    // 匹配段落内部的文本 <w:t>，换行 <w:br> 和制表符 <w:tab>
    const elementRegex = /<(w:t|w:br|w:tab)\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*>|<w:tab\b[^>]*>/g;
    let pText = "";
    let elemMatch;
    
    while ((elemMatch = elementRegex.exec(pContent)) !== null) {
      // 区分匹配到的标签类型
      const matchedTag = elemMatch[1] || (elemMatch[0].includes('br') ? 'w:br' : 'w:tab');
      if (matchedTag === 'w:t') {
        pText += elemMatch[2] || "";
      } else if (matchedTag === 'w:br') {
        pText += "\n";
      } else if (matchedTag === 'w:tab') {
        pText += "\t";
      }
    }
    
    // 过滤空的段落
    const cleanText = decodeXmlEntities(pText).trim();
    if (cleanText) {
      paragraphs.push(cleanText);
    }
  }
  
  return paragraphs.join("\n\n");
}

/**
 * 解析 .epub 电子书小说文本
 */
export async function parseEpub(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  
  // 1. 获取 container.xml 并找到 OPF 文件路径
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) {
    throw new Error("无效的 EPUB 文件：未找到 META-INF/container.xml");
  }
  const containerXml = await containerFile.async("text");
  const rootfileMatch = containerXml.match(/<rootfile\b[^>]*full-path="([^"]+)"/i);
  if (!rootfileMatch) {
    throw new Error("无效的 EPUB 文件：container.xml 中未找到 rootfile 节点");
  }
  
  const opfPath = rootfileMatch[1];
  
  // 计算 OPF 所在目录前缀（EPUB 内部相对路径用正斜杠）
  const parts = opfPath.split('/');
  parts.pop();
  const opfDir = parts.length > 0 ? parts.join('/') + '/' : '';
  
  // 2. 读取并解析 OPF 配置文件
  const opfFile = zip.file(opfPath);
  if (!opfFile) {
    throw new Error(`未找到 OPF 配置文件: ${opfPath}`);
  }
  const opfXml = await opfFile.async("text");
  
  // 解析 manifest 节点中的全部 item
  const manifestItems = {};
  const manifestMatch = opfXml.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  if (!manifestMatch) {
    throw new Error("EPUB 配置文件中未找到 manifest 节点");
  }
  
  const itemTags = manifestMatch[1].match(/<item\b[^>]*>/g) || [];
  for (const itemTag of itemTags) {
    const idMatch = itemTag.match(/\bid="([^"]+)"/i);
    const hrefMatch = itemTag.match(/\bhref="([^"]+)"/i);
    if (idMatch && hrefMatch) {
      // 存储时对 href 进行 url 解码
      manifestItems[idMatch[1]] = decodeURIComponent(hrefMatch[1]);
    }
  }
  
  // 解析 spine 节点，按照阅读顺序记录 idref
  const spineMatch = opfXml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!spineMatch) {
    throw new Error("EPUB 配置文件中未找到 spine 节点");
  }
  
  const spineItems = [];
  const itemrefTags = spineMatch[1].match(/<itemref\b[^>]*>/g) || [];
  for (const itemrefTag of itemrefTags) {
    const idrefMatch = itemrefTag.match(/\bidref="([^"]+)"/i);
    if (idrefMatch) {
      spineItems.push(idrefMatch[1]);
    }
  }
  
  // 3. 遍历 spine 中的每一个章节文件，提取文本
  const textParts = [];
  for (const idref of spineItems) {
    const href = manifestItems[idref];
    if (!href) continue;
    
    const fullPath = opfDir + href;
    const chapFile = zip.file(fullPath);
    if (!chapFile) continue;
    
    const htmlContent = await chapFile.async("text");
    
    // 仅提取 <body> 中的内容以过滤头部元数据和样式
    const bodyMatch = htmlContent.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    let bodyContent = bodyMatch ? bodyMatch[1] : htmlContent;
    
    // 将 HTML/XML 块级标签替换为换行，使段落清晰
    bodyContent = bodyContent
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n");
      
    // 剥离所有 HTML/XML 标签
    let text = bodyContent.replace(/<[^>]+>/g, "");
    
    // 解码 HTML/XML 实体
    text = decodeXmlEntities(text);
    
    // 规范化多余空行
    text = text.replace(/\r?\n/g, "\n")
               .replace(/\n\s*\n\s*\n+/g, "\n\n")
               .trim();
               
    if (text) {
      textParts.push(text);
    }
  }
  
  return textParts.join("\n\n");
}

/**
 * 统一文件解析入口
 */
export async function parseFile(filename, buffer) {
  const ext = filename.split('.').pop().toLowerCase();
  
  switch (ext) {
    case 'txt':
      return parseTxt(buffer);
    case 'docx':
      return parseDocx(buffer);
    case 'epub':
      return parseEpub(buffer);
    default:
      throw new Error(`不支持的文件格式: .${ext}。目前支持导入的格式有: .txt, .docx, .epub`);
  }
}
