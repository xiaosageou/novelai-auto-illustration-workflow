const DEFAULT_ENDPOINTS = [
  "https://sakizuki-danboorusearch.hf.space/mcp/mcp",
  "https://sakizuki-danboorusearchonline.ms.show/mcp/mcp"
];

const PROTOCOL_VERSION = "2025-06-18";

function parseEndpointList(endpoint) {
  const configured = String(endpoint || process.env.DANBOORU_MCP_URL || "")
    .split(/[,，\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_ENDPOINTS;
}

function parseMcpPayload(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) {
    return JSON.parse(trimmed);
  }

  const messages = [];
  let dataLines = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (line === "" && dataLines.length > 0) {
      messages.push(JSON.parse(dataLines.join("\n")));
      dataLines = [];
    }
  }
  if (dataLines.length > 0) {
    messages.push(JSON.parse(dataLines.join("\n")));
  }

  return messages.find(item => item?.result || item?.error) || messages[0] || null;
}

function extractToolJson(result) {
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter(item => item?.type === "text" && item.text)
      .map(item => item.text)
      .join("\n")
      .trim();
    return text ? JSON.parse(text) : {};
  }
  return result || {};
}

class DanbooruMcpHttpClient {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.sessionId = "";
    this.nextId = 1;
    this.initialized = false;
  }

  async request(method, params = {}, { notification = false, timeoutMs = 120000 } = {}) {
    const payload = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: this.nextId++, method, params };

    const headers = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream"
    };
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (res.status === 202 && notification) {
      return {};
    }

    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}`);
    }

    const newSessionId = res.headers.get("mcp-session-id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    const parsed = parseMcpPayload(await res.text());
    if (parsed?.error) {
      throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    }
    return parsed?.result || parsed || {};
  }

  async initialize() {
    if (this.initialized) return;

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "novelai-illustrator",
        version: "1.0.0"
      }
    }, { timeoutMs: 120000 });

    await this.request("notifications/initialized", {}, {
      notification: true,
      timeoutMs: 30000
    });

    this.initialized = true;
  }

  async callTool(name, args, timeoutMs = 120000) {
    await this.initialize();
    const result = await this.request("tools/call", {
      name,
      arguments: args
    }, { timeoutMs });
    return extractToolJson(result);
  }
}

const clients = new Map();

function getClient(endpoint) {
  if (!clients.has(endpoint)) {
    clients.set(endpoint, new DanbooruMcpHttpClient(endpoint));
  }
  return clients.get(endpoint);
}

async function callFirstAvailable(endpointConfig, call) {
  const errors = [];
  for (const endpoint of parseEndpointList(endpointConfig)) {
    try {
      return await call(getClient(endpoint), endpoint);
    } catch (error) {
      clients.delete(endpoint);
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

export async function searchTagsMcp(query, options = {}) {
  return callFirstAvailable(options.endpoint, async (client) => {
    return client.callTool("search_tags", {
      query,
      search_mode: options.search_mode || "full_scene",
      category: options.category || "all",
      show_nsfw: options.show_nsfw !== false,
      include_wiki: Boolean(options.include_wiki)
    }, options.timeoutMs || 120000);
  });
}

export async function getRelatedTagsMcp(tags, options = {}) {
  return callFirstAvailable(options.endpoint, async (client) => {
    return client.callTool("get_related_tags", {
      tags,
      limit: options.limit || 50,
      show_nsfw: options.show_nsfw !== false,
      include_wiki: Boolean(options.include_wiki)
    }, options.timeoutMs || 120000);
  });
}

export function clearDanbooruMcpSessions() {
  clients.clear();
}
