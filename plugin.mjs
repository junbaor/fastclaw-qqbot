#!/usr/bin/env node
/**
 * FastClaw QQ Bot Channel Plugin
 *
 * JSON-RPC subprocess plugin that bridges QQ messages via the official QQ Bot API.
 * Uses OAuth2 access_token + WebSocket gateway for real-time message receiving.
 *
 * Protocol:
 *   FastClaw → plugin:  initialize, channel.send, shutdown (JSON-RPC requests)
 *   plugin → FastClaw:  message.inbound (JSON-RPC notifications)
 *
 * Supports:
 *   - C2C (private) messages
 *   - Group messages
 *   - Guild (channel) messages
 */

import { createInterface } from "node:readline";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import WebSocket from "ws";

// ── File Logger ──

const LOG_DIR = join(homedir(), ".fastclaw", "logs");
const LOG_FILE = join(LOG_DIR, "qqbot.log");
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function fileLog(direction, label, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${direction}] ${label}: ${typeof data === "string" ? data : JSON.stringify(data)}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// ── Constants ──

const API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// QQ Bot intents
const INTENTS = {
  DIRECT_MESSAGE: 1 << 12,           // 频道私信
  GROUP_AND_C2C: 1 << 25,            // 群聊和 C2C 私聊
  INTERACTION: 1 << 26,              // 按钮交互回调
  PUBLIC_GUILD_MESSAGES: 1 << 30,    // 频道公开消息（公域）
};
const FULL_INTENTS =
  INTENTS.PUBLIC_GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGE |
  INTENTS.GROUP_AND_C2C |
  INTENTS.INTERACTION;

// Reconnect config
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const MAX_RECONNECT_ATTEMPTS = 50;

// ── State ──

let config = {};
let apiBase = API_BASE;
let tokenCache = null; // { token, expiresAt }
let sessionId = null;
let lastSeq = null;
let ws = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let isShuttingDown = false;

// ── JSON-RPC I/O ──

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", result, id });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", error: { code, message }, id });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function notifyInbound({ channel, chatId, userId, text, peerKind, senderName }) {
  const params = { channel, chatId, userId, text, peerKind, senderName };
  fileLog("RPC-OUT", "message.inbound", params);
  notify("message.inbound", params);
}

function log(msg) {
  fileLog("LOG", "info", msg);
}

// ── QQ Bot API ──

async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  log("Fetching new access token...");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appId: config.appId,
      clientSecret: config.clientSecret,
    }),
  });

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };
  log(`Access token obtained, expires in ${data.expires_in}s`);
  return tokenCache.token;
}

async function apiRequest(method, path, body) {
  const token = await getAccessToken();
  const url = `${apiBase}${path}`;
  const options = {
    method,
    headers: {
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  fileLog("API-REQ", `${method} ${path}`, body || "no body");

  const resp = await fetch(url, options);
  const text = await resp.text();

  fileLog("API-RSP", `${method} ${path} status=${resp.status}`, text);

  if (!resp.ok) {
    throw new Error(`API Error [${path}] ${resp.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function getGatewayUrl() {
  const data = await apiRequest("GET", "/gateway");
  return data.url;
}

// ── Message Sending ──

function getNextMsgSeq(msgId) {
  const timePart = Date.now() % 100000000;
  const random = Math.floor(Math.random() * 65536);
  return (timePart ^ random) % 65536;
}

async function sendC2CMessage(openid, content, msgId) {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest("POST", `/v2/users/${openid}/messages`, {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

async function sendGroupMessage(groupOpenid, content, msgId) {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest("POST", `/v2/groups/${groupOpenid}/messages`, {
    content,
    msg_type: 0,
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

async function sendChannelMessage(channelId, content, msgId) {
  return apiRequest("POST", `/channels/${channelId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

async function sendDmMessage(guildId, content, msgId) {
  return apiRequest("POST", `/dms/${guildId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

// ── WebSocket Gateway ──

function cleanup() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }
  ws = null;
}

function getReconnectDelay() {
  const idx = Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1);
  return RECONNECT_DELAYS[idx];
}

async function connectGateway() {
  if (isShuttingDown) return;

  cleanup();

  try {
    await getAccessToken();
    const gatewayUrl = await getGatewayUrl();
    log(`Connecting to gateway: ${gatewayUrl}`);

    ws = new WebSocket(gatewayUrl);

    ws.on("open", () => {
      log("WebSocket connected");
      fileLog("WS-EVENT", "OPEN", "connection established");
    });

    ws.on("message", (raw) => {
      const rawStr = raw.toString();
      try {
        const payload = JSON.parse(rawStr);
        fileLog("WS-RECV", `op=${payload.op} t=${payload.t || "N/A"}`, rawStr);
        handleGatewayPayload(payload);
      } catch (err) {
        fileLog("WS-RECV", "PARSE-ERROR", rawStr);
        log(`Failed to parse gateway message: ${err.message}`);
      }
    });

    ws.on("ping", (data) => {
      fileLog("WS-EVENT", "PING", data?.toString() || "");
    });

    ws.on("pong", (data) => {
      fileLog("WS-EVENT", "PONG", data?.toString() || "");
    });

    ws.on("close", (code, reason) => {
      log(`WebSocket closed: code=${code} reason=${reason}`);
      fileLog("WS-EVENT", "CLOSE", `code=${code} reason=${reason}`);
      cleanup();
      if (!isShuttingDown) {
        scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      log(`WebSocket error: ${err.message}`);
      fileLog("WS-EVENT", "ERROR", err.message);
    });
  } catch (err) {
    log(`Gateway connection failed: ${err.message}`);
    if (!isShuttingDown) {
      scheduleReconnect();
    }
  }
}

function scheduleReconnect() {
  if (isShuttingDown || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log("Max reconnect attempts reached or shutting down");
    return;
  }
  const delay = getReconnectDelay();
  reconnectAttempts++;
  log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(() => connectGateway(), delay);
}

// ── Gateway Payload Handling ──

// Track last message IDs per chat to support passive replies within 5-minute window
const lastMsgIds = new Map(); // chatKey → { msgId, timestamp }

function setLastMsgId(chatKey, msgId) {
  lastMsgIds.set(chatKey, { msgId, timestamp: Date.now() });
}

function getLastMsgId(chatKey) {
  const entry = lastMsgIds.get(chatKey);
  if (!entry) return undefined;
  // QQ passive reply window is 5 minutes
  if (Date.now() - entry.timestamp > 4.5 * 60 * 1000) {
    lastMsgIds.delete(chatKey);
    return undefined;
  }
  return entry.msgId;
}

function handleGatewayPayload(payload) {
  const { op, d, s, t } = payload;

  // Log every payload for debugging
  if (op !== 11) { // Skip heartbeat ACK noise
    log(`[ws-recv] op=${op} t=${t || "N/A"} s=${s ?? "N/A"} d_keys=${d ? Object.keys(d).join(",") : "null"}`);
  }

  // Track sequence number
  if (s) lastSeq = s;

  switch (op) {
    case 10: // Hello — start heartbeat and identify/resume
      handleHello(d);
      break;
    case 11: // Heartbeat ACK
      break;
    case 0: // Dispatch
      handleDispatch(t, d);
      break;
    case 7: // Reconnect
      log("Server requested reconnect");
      cleanup();
      connectGateway();
      break;
    case 9: // Invalid Session
      log("Invalid session, resetting");
      sessionId = null;
      lastSeq = null;
      cleanup();
      scheduleReconnect();
      break;
    default:
      log(`Unknown op: ${op}, full payload: ${JSON.stringify(payload).slice(0, 500)}`);
  }
}

function handleHello(d) {
  const heartbeatInterval = d?.heartbeat_interval || 41250;
  log(`Hello received, heartbeat interval: ${heartbeatInterval}ms`);

  // Start heartbeat
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const hb = { op: 1, d: lastSeq };
      fileLog("WS-SEND", "HEARTBEAT", hb);
      ws.send(JSON.stringify(hb));
    }
  }, heartbeatInterval);

  // Identify or Resume
  if (sessionId && lastSeq !== null) {
    log(`Resuming session: ${sessionId}, seq: ${lastSeq}`);
    const resumePayload = {
      op: 6,
      d: { token: `QQBot ${tokenCache?.token}`, session_id: sessionId, seq: lastSeq },
    };
    fileLog("WS-SEND", "RESUME", resumePayload);
    ws.send(JSON.stringify(resumePayload));
  } else {
    log("Identifying...");
    log(`[identify] intents=${FULL_INTENTS} (0x${FULL_INTENTS.toString(16)}), token_prefix=QQBot ${tokenCache?.token?.slice(0, 10)}...`);
    const identifyPayload = {
      op: 2,
      d: {
        token: `QQBot ${tokenCache?.token}`,
        intents: FULL_INTENTS,
        shard: [0, 1],
        properties: {
          $os: "linux",
          $browser: "fastclaw",
          $device: "fastclaw",
        },
      },
    };
    fileLog("WS-SEND", "IDENTIFY", { ...identifyPayload, d: { ...identifyPayload.d, token: "QQBot ***" } });
    ws.send(JSON.stringify(identifyPayload));
  }
}

async function handleDispatch(eventType, data) {
  log(`[dispatch] eventType=${eventType}, data=${JSON.stringify(data).slice(0, 500)}`);

  switch (eventType) {
    case "READY":
      sessionId = data.session_id;
      reconnectAttempts = 0;
      log(`Ready! session=${sessionId}, user=${data.user?.username || "unknown"}, shard=${JSON.stringify(data.shard)}`);
      break;

    case "RESUMED":
      reconnectAttempts = 0;
      log("Session resumed");
      break;

    // C2C private message
    case "C2C_MESSAGE_CREATE": {
      const userId = data.author?.user_openid || data.author?.id || "";
      const rawContent = (data.content || "").trim();
      const msgId = data.id || "";
      const attachmentText = await formatAttachments(data.attachments);
      const content = rawContent + attachmentText;
      log(`[C2C] userId=${userId}, content="${content}", msgId=${msgId}, author=${JSON.stringify(data.author)}`);
      if ((!rawContent && !attachmentText) || !userId) {
        log(`[C2C] SKIPPED: content empty=${!rawContent}, attachments empty=${!attachmentText}, userId empty=${!userId}`);
        break;
      }

      const chatKey = `c2c:${userId}`;
      setLastMsgId(chatKey, msgId);

      log(`C2C ← ${userId}: ${content.slice(0, 200)}`);
      notifyInbound({
        channel: "qqbot",
        chatId: chatKey,
        userId,
        text: content,
        peerKind: "dm",
        senderName: userId.slice(0, 8),
      });
      log(`[C2C] notifyInbound sent for chatId=${chatKey}`);
      break;
    }

    // Group message (被 @ 时触发)
    case "GROUP_AT_MESSAGE_CREATE": {
      const groupId = data.group_openid || data.group_id || "";
      const senderId = data.author?.member_openid || data.author?.id || "";
      const rawContent = (data.content || "").trim();
      const msgId = data.id || "";
      const attachmentText = await formatAttachments(data.attachments);
      log(`[Group@] groupId=${groupId}, senderId=${senderId}, rawContent="${rawContent}", msgId=${msgId}, author=${JSON.stringify(data.author)}`);
      if ((!rawContent && !attachmentText) || !groupId) {
        log(`[Group@] SKIPPED: rawContent empty=${!rawContent}, groupId empty=${!groupId}`);
        break;
      }

      const content = stripMentions(rawContent) + attachmentText;
      const chatKey = `group:${groupId}`;
      setLastMsgId(chatKey, msgId);

      log(`Group ← ${groupId}/${senderId}: ${content.slice(0, 200)}`);
      notifyInbound({
        channel: "qqbot",
        chatId: chatKey,
        userId: senderId,
        text: content,
        peerKind: "group",
        senderName: data.author?.username || senderId.slice(0, 8),
      });
      log(`[Group@] notifyInbound sent for chatId=${chatKey}`);
      break;
    }

    // Group message (普通消息，非 @ 触发)
    case "GROUP_MESSAGE_CREATE": {
      const groupId = data.group_openid || data.group_id || "";
      const senderId = data.author?.member_openid || data.author?.id || "";
      const rawContent = (data.content || "").trim();
      const msgId = data.id || "";
      const attachmentText = await formatAttachments(data.attachments);
      log(`[Group] groupId=${groupId}, senderId=${senderId}, rawContent="${rawContent}", msgId=${msgId}`);
      if ((!rawContent && !attachmentText) || !groupId) {
        log(`[Group] SKIPPED: rawContent empty=${!rawContent}, groupId empty=${!groupId}`);
        break;
      }

      const content = stripMentions(rawContent) + attachmentText;
      const chatKey = `group:${groupId}`;
      setLastMsgId(chatKey, msgId);

      log(`Group ← ${groupId}/${senderId}: ${content.slice(0, 200)}`);
      notifyInbound({
        channel: "qqbot",
        chatId: chatKey,
        userId: senderId,
        text: content,
        peerKind: "group",
        senderName: data.author?.username || senderId.slice(0, 8),
      });
      log(`[Group] notifyInbound sent for chatId=${chatKey}`);
      break;
    }

    // Guild channel message (public)
    case "AT_MESSAGE_CREATE":
    case "MESSAGE_CREATE": {
      const channelId = data.channel_id || "";
      const authorId = data.author?.id || "";
      const rawContent = (data.content || "").trim();
      const isBot = data.author?.bot;
      log(`[Guild] channelId=${channelId}, authorId=${authorId}, rawContent="${rawContent}", isBot=${isBot}`);
      if (!rawContent || !channelId || isBot) {
        log(`[Guild] SKIPPED: rawContent empty=${!rawContent}, channelId empty=${!channelId}, isBot=${isBot}`);
        break;
      }

      const content = stripMentions(rawContent);
      const chatKey = `channel:${channelId}`;
      setLastMsgId(chatKey, data.id || "");

      log(`Guild ← ${channelId}/${authorId}: ${content.slice(0, 200)}`);
      notifyInbound({
        channel: "qqbot",
        chatId: chatKey,
        userId: authorId,
        text: content,
        peerKind: "group",
        senderName: data.author?.username || data.member?.nick || authorId.slice(0, 8),
      });
      log(`[Guild] notifyInbound sent for chatId=${chatKey}`);
      break;
    }

    // Guild DM
    case "DIRECT_MESSAGE_CREATE": {
      const guildId = data.guild_id || "";
      const authorId = data.author?.id || "";
      const content = (data.content || "").trim();
      const isBot = data.author?.bot;
      log(`[DM] guildId=${guildId}, authorId=${authorId}, content="${content}", isBot=${isBot}`);
      if (!content || !guildId || isBot) {
        log(`[DM] SKIPPED: content empty=${!content}, guildId empty=${!guildId}, isBot=${isBot}`);
        break;
      }

      const chatKey = `dm:${guildId}`;
      setLastMsgId(chatKey, data.id || "");

      log(`DM ← ${guildId}/${authorId}: ${content.slice(0, 200)}`);
      notifyInbound({
        channel: "qqbot",
        chatId: chatKey,
        userId: authorId,
        text: content,
        peerKind: "dm",
        senderName: data.author?.username || authorId.slice(0, 8),
      });
      log(`[DM] notifyInbound sent for chatId=${chatKey}`);
      break;
    }

    default:
      log(`[dispatch] UNHANDLED eventType=${eventType}, data=${JSON.stringify(data).slice(0, 300)}`);
      break;
  }
}

/**
 * Strip @mention tags from message content.
 * QQ messages contain <@!openid> or <@openid> patterns for mentions.
 */
function stripMentions(text) {
  if (!text) return text;
  // Remove <@!xxx> and <@xxx> patterns
  return text.replace(/<@!?\w+>/g, "").trim();
}

/**
 * Format attachments (images, files, etc.) as text descriptions appended to the message.
 * Since fastclaw's inbound protocol only supports text, we embed attachment info in the text.
 * For text-based files, download and inline the content.
 */
async function formatAttachments(attachments) {
  if (!attachments || !attachments.length) return "";
  const parts = [];
  for (const att of attachments) {
    const type = att.content_type || "";
    const filename = att.filename || "";
    const url = att.url || "";

    if (type.startsWith("image/")) {
      parts.push(`\n[图片: ${url}]`);
    } else if (type.startsWith("audio/") || filename.endsWith(".silk")) {
      parts.push(`\n[语音: ${url}]`);
    } else if (type.startsWith("video/")) {
      parts.push(`\n[视频: ${url}]`);
    } else if (isTextFile(filename)) {
      // Download text-based files and inline content
      try {
        log(`[attachment] Downloading text file: ${filename} (${att.size || "?"} bytes)`);
        const content = await downloadTextFile(url);
        if (content) {
          parts.push(`\n[文件: ${filename}]\n\`\`\`\n${content}\n\`\`\``);
        } else {
          parts.push(`\n[文件: ${filename}] (下载失败)`);
        }
      } catch (err) {
        log(`[attachment] Download failed: ${err.message}`);
        parts.push(`\n[文件: ${filename}] (下载失败: ${err.message})`);
      }
    } else {
      parts.push(`\n[文件: ${filename || url}${url ? " " + url : ""}]`);
    }
  }
  return parts.join("");
}

const TEXT_FILE_EXTS = new Set([
  ".sql", ".txt", ".json", ".xml", ".csv", ".md", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".conf", ".log", ".sh", ".bash", ".zsh",
  ".py", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx",
  ".go", ".rs", ".java", ".c", ".cpp", ".h", ".hpp", ".cs",
  ".rb", ".php", ".lua", ".r", ".swift", ".kt", ".scala",
  ".html", ".css", ".scss", ".less", ".vue", ".svelte",
  ".env", ".gitignore", ".dockerfile", ".makefile",
]);

function isTextFile(filename) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  const dotIdx = lower.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_FILE_EXTS.has(lower.slice(dotIdx));
}

async function downloadTextFile(url, maxBytes = 50000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf).slice(0, maxBytes);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Outbound: channel.send ──

async function handleChannelSend(params) {
  const { chatId, text } = params;
  if (!chatId || !text) throw new Error("chatId and text required");

  const plainText = stripThinkTags(text);
  const replyMsgId = getLastMsgId(chatId);

  if (chatId.startsWith("c2c:")) {
    const openid = chatId.slice(4);
    await sendC2CMessage(openid, plainText, replyMsgId);
    log(`C2C → ${openid}: ${plainText.slice(0, 80)}`);
    return { status: "sent", target: chatId };
  }

  if (chatId.startsWith("group:")) {
    const groupOpenid = chatId.slice(6);
    await sendGroupMessage(groupOpenid, plainText, replyMsgId);
    log(`Group → ${groupOpenid}: ${plainText.slice(0, 80)}`);
    return { status: "sent", target: chatId };
  }

  if (chatId.startsWith("channel:")) {
    const channelId = chatId.slice(8);
    await sendChannelMessage(channelId, plainText, replyMsgId);
    log(`Channel → ${channelId}: ${plainText.slice(0, 80)}`);
    return { status: "sent", target: chatId };
  }

  if (chatId.startsWith("dm:")) {
    const guildId = chatId.slice(3);
    await sendDmMessage(guildId, plainText, replyMsgId);
    log(`DM → ${guildId}: ${plainText.slice(0, 80)}`);
    return { status: "sent", target: chatId };
  }

  throw new Error(`Unknown chatId format: ${chatId}`);
}

/**
 * Strip <think>...</think> blocks and markdown formatting from model output.
 */
function stripThinkTags(text) {
  let r = text;
  r = r.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Code blocks → plain code
  r = r.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim());
  // Images
  r = r.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links → text only
  r = r.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables
  r = r.replace(/^\|[\s:|-]+\|$/gm, "");
  r = r.replace(/^\|(.+)\|$/gm, (_, inner) =>
    inner.split("|").map((c) => c.trim()).join("  ")
  );
  // Bold / italic / strikethrough
  r = r.replace(/(\*\*|__)(.*?)\1/g, "$2");
  r = r.replace(/(\*|_)(.*?)\1/g, "$2");
  r = r.replace(/~~(.*?)~~/g, "$1");
  // Headers
  r = r.replace(/^#{1,6}\s+/gm, "");
  // Blockquotes
  r = r.replace(/^>\s?/gm, "");
  // List markers
  r = r.replace(/^[-*+]\s/gm, "• ");
  return r.trim();
}

// ── Request Handler ──

async function handleRequest(req) {
  const { method, params, id } = req;

  switch (method) {
    case "initialize": {
      config = params?.config || {};
      if (!config.appId || !config.clientSecret) {
        return respondError(id, -32000, "appId and clientSecret are required");
      }

      // Use sandbox API if configured
      if (config.sandbox === "true" || config.sandbox === true) {
        apiBase = SANDBOX_API_BASE;
        log("Using sandbox API");
      }

      log(`Initializing with appId=${config.appId}`);

      // Pre-fetch token then connect gateway
      try {
        await getAccessToken();
        connectGateway();
        return respond(id, { status: "ok" });
      } catch (err) {
        return respondError(id, -32000, `Init failed: ${err.message}`);
      }
    }

    case "channel.send": {
      try {
        const result = await handleChannelSend(params);
        return respond(id, result);
      } catch (err) {
        return respondError(id, -32000, err.message);
      }
    }

    case "shutdown": {
      log("Shutting down...");
      isShuttingDown = true;
      cleanup();
      respond(id, { status: "ok" });
      setTimeout(() => process.exit(0), 100);
      return;
    }

    default:
      return respondError(id, -32601, `Unknown method: ${method}`);
  }
}

// ── Main: read JSON-RPC from stdin ──

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;

  fileLog("RPC-IN", "request", line);

  try {
    const req = JSON.parse(line);
    await handleRequest(req);
  } catch (err) {
    send({
      jsonrpc: "2.0",
      error: { code: -32700, message: `Parse error: ${err.message}` },
      id: null,
    });
  }
});

rl.on("close", () => {
  isShuttingDown = true;
  cleanup();
  process.exit(0);
});

log("Plugin process started, waiting for initialize...");
