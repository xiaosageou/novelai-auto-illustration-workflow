// danbooru-mcp-client.js
// ──────────────────────────────────────────────
// 在线 Danbooru 标签检索 MCP 服务 Node.js 客户端
// 支持自动探活、双端点 failover、SSE 结果解析与 429 退避
// ──────────────────────────────────────────────

import { ProxyAgent, setGlobalDispatcher } from 'undici';

const MCP_URL_HF = "https://sakizuki-danboorusearch.hf.space/mcp/mcp";
const MCP_URL_MS = "https://sakizuki-danboorusearchonline.ms.show/mcp/mcp";
const TIMEOUT = 90000; // 90s

let activeUrl = MCP_URL_HF;

const HEADERS_BASE = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

export function getActiveEndpoint() {
  return activeUrl === MCP_URL_MS ? "ms" : "hf";
}

async function newSessionId(url) {
  const payload = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "novelai-illustrator-client", version: "1.0" },
      capabilities: {},
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: HEADERS_BASE,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      throw new Error(`HTTP Error ${resp.status}`);
    }

    const sessionId = resp.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("MCP initialize 响应中未包含 mcp-session-id 标头");
    }
    return sessionId;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function parseResponseText(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        return JSON.parse(line.substring(5).trim());
      }
    }
    throw new Error("Event Stream 响应中未包含 data: 行");
  }
  return JSON.parse(text);
}

async function rpcCall(method, params, reqId = 1) {
  const urlsToTry = [activeUrl, activeUrl === MCP_URL_HF ? MCP_URL_MS : MCP_URL_HF];
  let lastError = null;

  for (const url of urlsToTry) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    try {
      const sessionId = await newSessionId(url);
      const payload = {
        jsonrpc: "2.0",
        id: reqId,
        method,
        params,
      };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          ...HEADERS_BASE,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!resp.ok) {
        throw new Error(`HTTP Error ${resp.status}`);
      }

      const ct = resp.headers.get("content-type") || "";
      const text = await resp.text();
      const rpcResp = parseResponseText(text, ct);

      if (rpcResp.error) {
        throw new Error(rpcResp.error.message || `${method} 错误`);
      }

      if (url !== activeUrl) {
        console.warn(`[danbooru_mcp] 节点切换！已成功重定向至 ${url === MCP_URL_MS ? 'MS' : 'HF'} 节点`);
        activeUrl = url;
      }

      return rpcResp.result || {};
    } catch (err) {
      clearTimeout(timeoutId);
      console.error(`[danbooru_mcp] 请求端点 ${url} 发生异常: ${err.message}，尝试切换备用端点...`);
      lastError = err;
    }
  }

  throw new Error(`所有在线 MCP 端点访问均失败。最后一次报错: ${lastError.message}`);
}

async function callMcp(toolName, args) {
  const retryDelays = [3000, 7000, 15000];
  let lastError = null;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const result = await rpcCall("tools/call", { name: toolName, arguments: args });
      const contentBlocks = result.content || [];

      for (const block of contentBlocks) {
        if (block.type === "text") {
          const textVal = block.text;
          try {
            return JSON.parse(textVal);
          } catch (e) {
            return { raw: textVal };
          }
        }
      }
      return { error: "MCP 服务返回的内容块为空" };
    } catch (err) {
      // 检查是否是 429 (虽然 Node.js fetch 没直接抛出 HTTPStatusError，但我们可以通过错误信息或状态码判定)
      if (err.message.includes("429") && attempt < retryDelays.length) {
        const delay = retryDelays[attempt];
        console.warn(`[danbooru_mcp] 触发 429 频控限制，将在 ${delay / 1000} 秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        lastError = err;
        continue;
      }
      return { error: err.message };
    }
  }
  return { error: `由于频控限制重试失败: ${lastError.message}` };
}

/**
 * 检索 Danbooru 标签
 */
export async function searchTagsOnline(query, options = {}) {
  const defaults = {
    search_mode: "full_scene",
    category: "all",
    show_nsfw: true,
    include_wiki: false,
  };
  return await callMcp("search_tags", {
    query,
    ...defaults,
    ...options,
  });
}

/**
 * 获取相关推荐标签
 */
export async function getRelatedTagsOnline(tags, limit = 30) {
  if (!tags || tags.length === 0) {
    return { error: "tags 列表不能为空" };
  }
  return await callMcp("get_related_tags", {
    tags,
    limit,
    show_nsfw: true,
    include_wiki: false,
  });
}
