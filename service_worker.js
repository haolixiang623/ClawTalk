import { GatewayClient } from "./shared/gateway_client.js";
import { DEFAULT_SETTINGS, TalkState, buildState } from "./shared/state.js";
import {
  isLoopbackGatewayUrl,
  migrateLegacyGatewaySettings,
} from "./shared/gateway-defaults.mjs";
import {
  buildDemoPreReviewMockAnalysis,
  buildDemoPreReviewPrompt,
  buildDemoPreReviewResultPayload,
  buildDemoPreReviewSummary,
  DEMO_PRE_REVIEW_RESULT_STORAGE_KEY,
  DEMO_PRE_REVIEW_RESULT_URL,
  DEMO_PRE_REVIEW_SELECTORS,
  DEMO_PRE_REVIEW_SESSION_KEY,
  DEMO_PRE_REVIEW_URL,
  findLatestAssistantReplyText,
  normalizeDemoAttachments,
} from "./shared/demo-pre-review.mjs";

let settings = { ...DEFAULT_SETTINGS };
let state = buildState(settings);

let gatewayClient = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY_MS = 60000; // 1 minute max
const INITIAL_RECONNECT_DELAY_MS = 2000; // 2 seconds

// Track one-off TTS requests (e.g., Settings -> Test speech)
const pendingTtsRequests = new Map(); // requestId -> { resolve, reject, timeoutId, meta }

// (removed) pendingMessageIds: unused and could grow unbounded.

// Speech/end -> transcript timing.
let awaitingTranscript = false;
let transcriptWaitTimer = null;

// Track ordering within a single utterance (some SpeechRecognition implementations
// can fire result before end, which would otherwise trigger a false timeout).
let utteranceActive = false;
let utteranceHasTranscript = false;

const HEADER_RULE_ID_START = 1000;

// Run output buffering (for CHAT streaming).
const chatRunBuffers = new Map(); // runId -> { text, lastUpdatedAtMs }

// Deduplication for chat events (gateway may retransmit or client may reconnect).
const lastChatSeqByRunId = new Map(); // runId -> last seq processed
const lastFinalTextByRunId = new Map(); // runId -> last final text logged
const DEMO_PRE_REVIEW_ORIGIN_PATTERN = "http://127.0.0.1:4180/*";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTabReady(tabId, { timeoutMs = 15000, expectedPrefix = "" } = {}) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    const url = String(tab?.url || "");
    const urlMatches = !expectedPrefix || url.startsWith(expectedPrefix);

    if (tab?.status === "complete" && urlMatches) {
      return tab;
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for tab ${tabId} to load.`);
}

async function executeDemoScript(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });

  return results?.[0]?.result;
}

async function ensureDemoExecutionAccess() {
  if (!chrome.tabs?.create || !chrome.tabs?.update) {
    throw new Error("chrome.tabs API is unavailable. Reload the extension after updating the manifest.");
  }

  if (!chrome.scripting?.executeScript) {
    throw new Error("chrome.scripting API is unavailable. Reload the extension after updating the manifest.");
  }

  if (chrome.permissions?.contains) {
    try {
      const hasOriginAccess = await chrome.permissions.contains({ origins: [DEMO_PRE_REVIEW_ORIGIN_PATTERN] });
      if (!hasOriginAccess) {
        throw new Error(
          `Missing host access for ${DEMO_PRE_REVIEW_ORIGIN_PATTERN}. Reload the unpacked extension so the new demo permissions apply.`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(
        `Unable to verify host access for ${DEMO_PRE_REVIEW_ORIGIN_PATTERN}. Reload the unpacked extension and try again.`,
      );
    }
  }
}

async function loadSessionMessages(sessionKey, limit = 20) {
  if (!gatewayClient || !gatewayClient.connected) {
    throw new Error("Gateway not connected.");
  }

  const response = await gatewayClient.request(
    "chat.history",
    { sessionKey, limit: Math.max(5, Math.min(2000, Number(limit) || 20)) },
    { timeoutMs: 20000 },
  );

  return Array.isArray(response?.payload?.messages) ? response.payload.messages : [];
}

async function waitForAssistantReply({
  sessionKey,
  previousReplyText = "",
  timeoutMs = 45000,
  pollMs = 2000,
}) {
  const startedAt = Date.now();
  const baseline = String(previousReplyText || "").trim();

  while (Date.now() - startedAt < timeoutMs) {
    const messages = await loadSessionMessages(sessionKey, 20);
    const latestReplyText = findLatestAssistantReplyText(messages);
    if (latestReplyText && latestReplyText !== baseline) {
      return latestReplyText;
    }

    await delay(pollMs);
  }

  throw new Error(`Timed out waiting for an assistant reply in session ${sessionKey}.`);
}

async function showDemoResultPage(tabId, payload) {
  const serializablePayload = JSON.parse(JSON.stringify(payload));

  await executeDemoScript(
    tabId,
    (storageKey, value) => {
      sessionStorage.setItem(storageKey, JSON.stringify(value));
      return true;
    },
    [DEMO_PRE_REVIEW_RESULT_STORAGE_KEY, serializablePayload],
  );

  await chrome.tabs.update(tabId, { url: DEMO_PRE_REVIEW_RESULT_URL });
  await waitForTabReady(tabId, { expectedPrefix: DEMO_PRE_REVIEW_RESULT_URL });
}

async function sendPromptToGateway({
  text,
  sessionKey,
  chatPreviewText = "",
  sourceLabel = "Text prompt",
}) {
  const promptText = String(text || "").trim();
  if (!promptText) {
    throw new Error("Message is empty.");
  }

  if (!settings.dryRun && (!gatewayClient || !gatewayClient.connected)) {
    throw new Error("Gateway not connected.");
  }

  const previewText = String(chatPreviewText || promptText).trim() || promptText;
  upsertChatMessage({ runId: `user-${Date.now()}`, role: "user", text: previewText, final: true });

  if (settings.dryRun) {
    logInfo("speech", `${sourceLabel} (dry run): ${promptText}`);
    return { ok: true, dryRun: true };
  }

  const response = await gatewayClient.sendChat(promptText, sessionKey);
  if (response?.ok === false) {
    throw new Error(response?.error?.message || "chat.send failed.");
  }

  updateTalkStatus(TalkState.THINKING);
  logInfo("speech", `${sourceLabel} sent (${promptText.length} chars).`);
  return response;
}

async function runDemoPreReviewFlow() {
  if (state.demoPreReviewRunning) {
    throw new Error("Demo flow is already running.");
  }

  state.demoPreReviewRunning = true;
  broadcastState();

  try {
    await ensureDemoExecutionAccess();
    logInfo("connect", `Demo permissions ready for ${DEMO_PRE_REVIEW_ORIGIN_PATTERN}.`);
    logInfo("connect", `Opening demo review list: ${DEMO_PRE_REVIEW_URL}`);
    const tab = await chrome.tabs.create({ url: DEMO_PRE_REVIEW_URL, active: true });
    const tabId = tab?.id;

    if (typeof tabId !== "number") {
      throw new Error("Failed to create demo tab.");
    }

    await waitForTabReady(tabId, { expectedPrefix: DEMO_PRE_REVIEW_URL });

    const firstCase = await executeDemoScript(
      tabId,
      (selectors) => {
        const link = document.querySelector(selectors.firstPendingLink);
        if (!(link instanceof HTMLAnchorElement)) {
          return { ok: false, error: "No pending case found on the demo list page." };
        }

        return {
          ok: true,
          detailUrl: new URL(link.getAttribute("href") || "", window.location.href).href,
          caseTitle: link.dataset.caseTitle || link.textContent || "",
        };
      },
      [DEMO_PRE_REVIEW_SELECTORS],
    );

    if (!firstCase?.ok || !firstCase?.detailUrl) {
      throw new Error(firstCase?.error || "Failed to read the first demo case.");
    }

    logInfo("connect", `Opening first demo case: ${firstCase.caseTitle || firstCase.detailUrl}`);
    await chrome.tabs.update(tabId, { url: firstCase.detailUrl });
    await waitForTabReady(tabId, { expectedPrefix: "http://127.0.0.1:4180/demo/review-detail.html" });

    const extractedDetail = await executeDemoScript(
      tabId,
      (selectors) => {
        const root = document.querySelector(selectors.detailRoot);
        if (!(root instanceof HTMLElement)) {
          return { ok: false, error: "Demo detail page did not render expected content." };
        }

        const readText = (selector) => {
          const node = document.querySelector(selector);
          return node ? String(node.textContent || "").trim() : "";
        };

        const attachments = Array.from(document.querySelectorAll(selectors.attachmentLink))
          .filter((node) => node instanceof HTMLAnchorElement)
          .map((link) => ({
            name: link.dataset.attachmentName || String(link.textContent || "").trim(),
            url: link.href,
          }));

        return {
          ok: true,
          caseTitle: readText(selectors.caseTitle),
          caseNumber: readText(selectors.caseNumber),
          caseStatus: readText(selectors.caseStatus),
          detailUrl: window.location.href,
          attachments,
          extractedAt: new Date().toISOString(),
        };
      },
      [DEMO_PRE_REVIEW_SELECTORS],
    );

    if (!extractedDetail?.ok) {
      throw new Error(extractedDetail?.error || "Failed to extract demo detail data.");
    }

    const detail = {
      ...extractedDetail,
      attachments: normalizeDemoAttachments(extractedDetail.attachments),
    };

    const prompt = buildDemoPreReviewPrompt(detail);
    const summary = buildDemoPreReviewSummary(detail);
    let previousReplyText = "";

    if (!settings.dryRun) {
      try {
        previousReplyText = findLatestAssistantReplyText(
          await loadSessionMessages(DEMO_PRE_REVIEW_SESSION_KEY, 20),
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logDebug("gateway.eventNames", `Failed to read baseline demo session history: ${msg}`);
      }
    }

    logInfo(
      "connect",
      `Captured demo case ${detail.caseNumber || "<unknown>"} with ${detail.attachments.length} attachment(s).`,
    );

    await sendPromptToGateway({
      text: prompt,
      sessionKey: DEMO_PRE_REVIEW_SESSION_KEY,
      chatPreviewText: summary,
      sourceLabel: "Demo pre-review prompt",
    });

    logInfo("connect", `Demo pre-review dispatched to session ${DEMO_PRE_REVIEW_SESSION_KEY}. Waiting for analysis...`);

    let analysisText = "";
    let resultSource = "openclaw";
    try {
      analysisText = settings.dryRun
        ? buildDemoPreReviewMockAnalysis(detail)
        : await waitForAssistantReply({
          sessionKey: DEMO_PRE_REVIEW_SESSION_KEY,
          previousReplyText,
        });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      resultSource = settings.dryRun ? "dry-run" : "timeout";
      analysisText = settings.dryRun
        ? buildDemoPreReviewMockAnalysis(detail)
        : [
          "办件概览：已完成页面抓取并成功把附件信息发送给 OpenClaw。",
          `附件检查：共抓取 ${detail.attachments.length} 个附件，请先确认链接有效性。`,
          "预审建议：",
          "1. 检查 OpenClaw 当前 session 是否返回了分析结果。",
          "2. 确认模型或 skill 是否正常执行。",
          "3. 如需重跑，可再次点击预审 Demo。",
          `风险提醒：等待 OpenClaw 返回结果时超时，错误信息：${msg}`,
        ].join("\n");
      logError(`Demo result fallback used: ${msg}`);
    }

    const resultPayload = buildDemoPreReviewResultPayload({
      detail,
      analysisText,
      sessionKey: DEMO_PRE_REVIEW_SESSION_KEY,
      source: resultSource,
    });

    await showDemoResultPage(tabId, resultPayload);
    logInfo("connect", `Demo result page opened (${resultSource}).`);
    return { ok: true };
  } finally {
    state.demoPreReviewRunning = false;
    broadcastState();
  }
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: "state.update", payload: state });
}

function computeLogConfig() {
  const debugEnabled = Boolean(settings.logDebug);
  const infoEnabled = settings.logInfo !== false;

  return {
    debugEnabled,
    infoEnabled,

    debugGatewayEventNames: debugEnabled && Boolean(settings.logDebugGatewayEventNames),
    debugGatewayHeartbeats: debugEnabled && Boolean(settings.logDebugGatewayHeartbeats),
    debugTranscriptText: debugEnabled && Boolean(settings.logDebugTranscriptText),

    infoConnect: infoEnabled && settings.logInfoConnect !== false,
    infoAssistant: infoEnabled && settings.logInfoAssistant !== false,
    infoSpeech: infoEnabled && settings.logInfoSpeech !== false
  };
}

function resolveMaxLogEntries() {
  const n = Number(settings.maxLogEntries);
  if (!Number.isFinite(n)) return 100;
  return Math.max(10, Math.min(2000, Math.floor(n)));
}

function resolveMaxChatMessages() {
  const n = Number(settings.maxChatMessages);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function addLog(message, level = "info", kind = "general") {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    kind,
    message
  };
  const max = resolveMaxLogEntries();
  state.logs = [...state.logs, entry].slice(-max);
  broadcastState();
}

function upsertChatMessage({ runId, text, role = "assistant", final = false, timestamp }) {
  const ts = timestamp || new Date().toISOString();
  const id = String(runId || "unknown");

  // Update existing entry for this runId (streaming), or append a new one.
  const existingIndex = state.chat?.findIndex?.((m) => m.runId === id) ?? -1;
  const nextEntry = { runId: id, timestamp: ts, role, text: String(text || ""), final: Boolean(final) };

  if (!Array.isArray(state.chat)) {
    state.chat = [];
  }

  if (existingIndex >= 0) {
    const existing = state.chat[existingIndex] || {};
    state.chat[existingIndex] = { ...existing, ...nextEntry };
  } else {
    state.chat = [...state.chat, nextEntry];
  }

  const max = resolveMaxChatMessages();
  if (state.chat.length > max) {
    state.chat = state.chat.slice(-max);
  }

  broadcastState();
}

function logDebug(kind, message) {
  const cfg = computeLogConfig();
  if (!cfg.debugEnabled) return;

  // Gate debug subcategories.
  if (kind === "gateway.eventNames" && !cfg.debugGatewayEventNames) return;
  if (kind === "gateway.heartbeats" && !cfg.debugGatewayHeartbeats) return;
  if (kind === "speech.transcriptText" && !cfg.debugTranscriptText) return;

  addLog(message, "debug", kind);
}

function logInfo(kind, message) {
  const cfg = computeLogConfig();
  if (!cfg.infoEnabled) return;

  // Gate info subcategories.
  if (kind === "connect" && !cfg.infoConnect) return;
  if (kind === "assistant" && !cfg.infoAssistant) return;
  if (kind === "speech" && !cfg.infoSpeech) return;

  addLog(message, "info", kind);
}

function logError(message) {
  // Errors always show.
  addLog(message, "error", "error");
}

async function loadSettings() {
  const storedSettings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const { settings: migratedSettings, didMigrate } =
    migrateLegacyGatewaySettings(storedSettings);

  settings = { ...DEFAULT_SETTINGS, ...migratedSettings };

  if (didMigrate) {
    await chrome.storage.local.set({
      gatewayUrl: settings.gatewayUrl,
      gatewayToken: settings.gatewayToken,
    });
  }

  state.gatewayUrl = settings.gatewayUrl;
  state.gatewayAdditionalOrigins = settings.gatewayAdditionalOrigins;
  state.dryRun = settings.dryRun;
  state.speakingEnabled = Boolean(settings.speakingEnabled);
  state.pushToTalk = Boolean(settings.pushToTalk);

  state.sessionKey = settings.sessionKey;
  state.loadSessionHistory = settings.loadSessionHistory !== false;
  state.sessionHistoryLimit = settings.sessionHistoryLimit;

  state.maxLogEntries = settings.maxLogEntries;
  state.maxChatMessages = settings.maxChatMessages;

  state.logDebug = Boolean(settings.logDebug);
  state.logDebugGatewayEventNames = Boolean(settings.logDebugGatewayEventNames);
  state.logDebugGatewayHeartbeats = Boolean(settings.logDebugGatewayHeartbeats);
  state.logDebugTranscriptText = Boolean(settings.logDebugTranscriptText);
  state.logDebugGatewayResPayload = Boolean(settings.logDebugGatewayResPayload);

  state.logInfo = settings.logInfo !== false;
  state.logInfoConnect = settings.logInfoConnect !== false;
  state.logInfoAssistant = settings.logInfoAssistant !== false;
  state.logInfoSpeech = settings.logInfoSpeech !== false;
  state.sttLang = settings.sttLang;
  state.inputDeviceId = settings.inputDeviceId;
  state.vad = settings.vad;

  // TTS provider settings (used by offscreen).
  state.ttsProvider = settings.ttsProvider || (settings.useElevenLabs ? "elevenlabs" : "default");

  if (didMigrate) {
    logInfo(
      "connect",
      "Reset legacy remote gateway defaults to the local OpenClaw gateway. Add your local gateway token in Settings before connecting.",
    );
  }

  broadcastState();
  await updateGatewayHeaderRules();
  return settings;
}

async function ensureOffscreen() {
  if (!chrome.offscreen?.hasDocument) {
    return { supported: false, created: false };
  }

  const hasDoc = await chrome.offscreen.hasDocument();
  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play assistant TTS audio for talk mode."
    });
    return { supported: true, created: true };
  }

  return { supported: true, created: false };
}

function updateTalkStatus(status) {
  state.status = status;
  broadcastState();
}

async function updateGatewayHeaderRules() {
  if (!chrome.declarativeNetRequest) return;

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const existingIds = existingRules.map((rule) => rule.id);
  if (existingIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existingIds });
  }

  const headers = Array.isArray(settings.gatewayHeaders) ? settings.gatewayHeaders : [];
  if (!headers.length) return;

  let url;
  try {
    url = new URL(settings.gatewayUrl);
  } catch {
    logError("Invalid gateway URL for header rules.");
    return;
  }

  const urlFilter = `${url.protocol}//${url.host}`;
  const rules = headers.map((header, index) => ({
    id: HEADER_RULE_ID_START + index,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: header.name,
          operation: "set",
          value: header.value
        }
      ]
    },
    condition: {
      urlFilter,
      resourceTypes: ["websocket"]
    }
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Schedule a reconnect with exponential backoff.
 * Each attempt doubles the delay, capped at MAX_RECONNECT_DELAY_MS.
 */
function scheduleReconnect() {
  if (reconnectTimer || !state.connectEnabled) return;

  // Cap attempts to avoid indefinite growth (reset after successful connect or manual toggle).
  if (reconnectAttempt > 16) {
    logError(`Reconnect attempts exhausted (${reconnectAttempt}). Stopping auto-reconnect. Press Connect to retry manually.`);
    return;
  }

  // Exponential backoff: 2s, 4s, 8s, 16s, ... up to 60s.
  const delayMs = Math.min(
    INITIAL_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt),
    MAX_RECONNECT_DELAY_MS
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (state.connectEnabled && !state.gatewayConnected) {
      reconnectAttempt += 1;
      connectGateway();
    }
  }, delayMs);

  if (reconnectAttempt > 0) {
    logInfo("connect", `Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${reconnectAttempt + 1})...`);
  }
}

/** Reset reconnect state after a successful connect. */
function resetReconnectState() {
  if (reconnectAttempt !== 0) {
    reconnectAttempt = 0;
    logInfo("connect", "Reconnect state reset.");
  }
}

function disconnectGateway() {
  clearReconnect();
  if (gatewayClient) {
    gatewayClient.close();
    gatewayClient = null;
  }
  state.gatewayConnected = false;

  // If we're not actively running the talk loop, reflect a disconnected talk state.
  if (!state.talkEnabled) {
    updateTalkStatus(TalkState.DISCONNECTED);
  } else if (!settings.dryRun) {
    // Talk is running but gateway was disconnected.
    updateTalkStatus(TalkState.ERROR);
  }

  broadcastState();
}

function connectGateway() {
  disconnectGateway();

  if (settings.dryRun) {
    logInfo("connect", "Dry run enabled. Skipping gateway connection.");
    state.gatewayConnected = true;
    if (!state.talkEnabled) {
      updateTalkStatus(TalkState.IDLE);
    }
    broadcastState();
    return;
  }

  if (!settings.gatewayToken && !settings.deviceToken) {
    const missingTokenMessage = isLoopbackGatewayUrl(settings.gatewayUrl)
      ? "Missing gateway token or device token. Local OpenClaw gateways usually require the token from ~/.openclaw/openclaw.json or `openclaw config get gateway.auth.token`."
      : "Missing gateway token or device token. Please set it in Settings.";

    logError(missingTokenMessage);
    state.gatewayConnected = false;
    broadcastState();
    return;
  }

  logInfo("connect", `Connecting to gateway at ${settings.gatewayUrl}...`);

  gatewayClient = new GatewayClient({
    url: settings.gatewayUrl,
    token: settings.gatewayToken,
    deviceToken: settings.deviceToken,
    // Enable debug frames only when debug logging is enabled.
    debugEvents: Boolean(settings.logDebug),
    onEvent: handleGatewayEvent,
    onState: handleGatewaySocketState
  });

  gatewayClient
    .connect()
    .then(() => {
      state.gatewayConnected = true;

      // Reset reconnect state after successful connection.
      resetReconnectState();

      // If we're connected and not currently in a talk loop, show an idle-ready state.
      if (!state.talkEnabled) {
        updateTalkStatus(TalkState.IDLE);
      }

      broadcastState();
      logInfo("connect", "Gateway connected.");

      // Load session history into CHAT (optional).
      loadSessionHistoryIntoChat((settings.sessionKey || "main").trim() || "main");

      // If user already enabled Talk, allow it to proceed.
      if (state.talkEnabled && state.status === TalkState.ERROR) {
        updateTalkStatus(TalkState.LISTENING);
      }
    })
    .catch((error) => {
      state.gatewayConnected = false;
      broadcastState();
      const msg = error instanceof Error ? error.message : String(error);
      logError(`Gateway connection failed: ${msg}. Retrying...`);
      scheduleReconnect();
    });
}

function handleGatewaySocketState(status, detail) {
  if (detail?.code !== undefined) {
    logInfo("connect", `Gateway socket: ${status} (code=${detail.code}, reason=${detail.reason || "<none>"}, clean=${detail.wasClean})`);
  } else if (detail?.url) {
    logInfo("connect", `Gateway socket: ${status} (url=${detail.url})`);
  } else {
    logInfo("connect", `Gateway socket: ${status}`);
  }

  if (status === "device_token_issued" && detail?.deviceToken) {
    settings.deviceToken = String(detail.deviceToken);
    chrome.storage.local.set({ deviceToken: settings.deviceToken }).catch(() => {});
    logInfo("connect", "Gateway issued a paired device token for future reconnects.");
    return;
  }

  if (status === "pairing_required") {
    state.connectEnabled = false;
    broadcastState();

    const requestId = detail?.requestId ? ` Request ID: ${detail.requestId}.` : "";
    const reason = detail?.reason ? ` Reason: ${detail.reason}.` : "";
    logError(
      "This browser extension now presents a real OpenClaw device identity, so the gateway requires a one-time device approval before chat.write is allowed." +
      reason +
      requestId +
      " Approve the pending device in OpenClaw, then press Connect again.",
    );
    return;
  }

  // Show diagnostic hints as error logs for better visibility.
  if (status === "socket_diagnostic" && detail?.hint) {
    logError(`Connection hint: ${detail.hint}`);
    return;
  }

  if (status === "socket_closed") {
    state.gatewayConnected = false;

    const code = detail?.code;
    const reason = String(detail?.reason || "");

    // Circuit-breaker: if the server rejects our connect parameters (policy violation 1008),
    // do NOT auto-retry. This can otherwise create an infinite reconnect loop and freeze Chrome.
    if (code === 1008 && /invalid connect params|INVALID_REQUEST/i.test(reason)) {
      state.connectEnabled = false;
      broadcastState();
      logError(`Gateway rejected connect params (${reason}). Auto-retry disabled. Fix client/settings then press Connect again.`);
      // If talk loop is running and gateway drops, surface it.
      if (state.talkEnabled && !settings.dryRun) {
        updateTalkStatus(TalkState.ERROR);
      }
      return;
    }

    // Provide helpful hints for common close codes.
    let hint = null;
    if (code === 1006) {
      hint = "Connection closed abnormally (code 1006). This usually means:\n" +
             "1. The lobster service on the server is not running or has crashed\n" +
             "2. The extension does not have permission to connect to this origin\n" +
             "3. A firewall or proxy is blocking WebSocket connections\n\n" +
             "Try: Check if the lobster service is running on the server, or go to Settings > Gateway URL and save to grant permissions.";
    } else if (code === 1008) {
      hint = "Connection rejected by server (code 1008). Check your token or server configuration.";
    } else if (code === 1001) {
      hint = "Server is going away. The gateway may have been shut down.";
    } else if (code === 1011) {
      hint = "Server encountered an unexpected condition. Check server logs.";
    }

    if (hint) {
      logError(hint);
    } else {
      logInfo("connect", `Connection closed unexpectedly (code ${code}). Retries remaining: ${16 - reconnectAttempt}`);
    }

    broadcastState();

    // If user wants to remain connected, try to reconnect.
    if (state.connectEnabled) {
      scheduleReconnect();
    }

    // If talk loop is running and gateway drops, surface it.
    if (state.talkEnabled && !settings.dryRun) {
      updateTalkStatus(TalkState.ERROR);
    }
  }
}

function stripReplyTags(text) {
  if (!text) return "";
  // Remove OpenClaw reply tags that are meant as routing metadata, not user-visible text.
  return String(text)
    .replace(/\[\[\s*reply_to:[^\]]+\]\]/g, "")
    .trim();
}

function extractPlainTextFromMessage(message) {
  if (!message) return "";
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = content
    .map((c) => {
      if (!c) return "";
      if (c.type === "text" || c.type === "input_text" || c.type === "output_text") {
        return c.text || c.value || c.content || "";
      }
      // Compact placeholders for non-text parts.
      if (c.type === "image") return "[image]";
      if (c.type === "audio") return "[audio]";
      if (c.type === "toolCall") return "";
      if (c.type === "toolResult") return "";
      if (c.type === "thinking") return "";
      return "";
    })
    .filter(Boolean);
  return stripReplyTags(parts.join(""));
}

function resetChatBuffers() {
  chatRunBuffers.clear();
  lastChatSeqByRunId.clear();
  lastFinalTextByRunId.clear();
}

async function loadSessionHistoryIntoChat(sessionKey) {
  if (!gatewayClient || !gatewayClient.connected) {
    return;
  }
  if (settings.loadSessionHistory === false) {
    return;
  }

  const limit = Math.max(10, Math.min(2000, Number(settings.sessionHistoryLimit) || 200));

  try {
    const res = await gatewayClient.request("chat.history", { sessionKey, limit }, { timeoutMs: 20000 });
    const messages = res?.payload?.messages || [];

    // Replace current chat view with history.
    resetChatBuffers();

    const chatItems = messages
      .map((m, idx) => {
        const role = m?.role || "";
        const text = extractPlainTextFromMessage(m);
        if (!text) return null;

        const ts = m?.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString();

        return {
          runId: `hist-${sessionKey}-${idx}`,
          timestamp: ts,
          role: role || "unknown",
          text,
          final: true
        };
      })
      .filter(Boolean);

    state.chat = chatItems.slice(-resolveMaxChatMessages());
    broadcastState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logDebug("gateway.eventNames", `Failed to load chat history: ${msg}`);
  }
}

function extractChatMessageText(message) {
  if (!message) return "";
  // Typical OpenClaw message shape: { role, content:[{type:"text", text:"..."}, ...] }
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = content
    .map((c) => (c?.type === "text" ? c.text : ""))
    .filter(Boolean);
  return parts.join("");
}

function extractRunIdFromPayload(payload) {
  return (
    payload?.runId ||
    payload?.id ||
    payload?.payload?.runId ||
    payload?.message?.runId ||
    payload?.params?.runId ||
    payload?.data?.runId ||
    null
  );
}

function extractStreamingAssistantText(payload) {
  // Streaming events (often event.name === "agent") can have wildly different shapes.
  // We intentionally accept a few common fields, and fall back to generic text/content.
  const data = payload?.data || payload?.params || payload?.result || payload || {};

  const role = data.role || data.sender || data.from || payload?.role;
  if (role && role !== "assistant") return null;

  const text =
    data.text ||
    data.delta ||
    data.content ||
    data.message ||
    data?.message?.text ||
    payload?.text ||
    payload?.content;

  if (!text) return null;
  return stripReplyTags(String(text));
}

function handleGatewayEvent(event) {
  if (event.type === "debug") {
    logDebug("gateway.eventNames", `Gateway debug: ${event.name}`);
    return;
  }

  const name = event.name || "";
  const payload = event.payload;

  // Stream updates into CHAT (but don't spam the Logs).
  const CHAT_THROTTLE_MS = 200;

  if (name === "agent") {
    const runId = String(extractRunIdFromPayload(payload) || "agent");
    const text = extractStreamingAssistantText(payload);
    if (text) {
      const now = Date.now();
      const prev = chatRunBuffers.get(runId) || { text: "", lastUpdatedAtMs: 0 };

      // Throttle UI updates to keep it readable ("live a scatti").
      if (text !== prev.text && now - prev.lastUpdatedAtMs > CHAT_THROTTLE_MS) {
        chatRunBuffers.set(runId, { text, lastUpdatedAtMs: now });
        upsertChatMessage({ runId, role: "assistant", text, final: false });
      }
    }

    // Still allow debugging of event names.
    logDebug("gateway.eventNames", "Gateway event: agent");
    return;
  }

  // Final chat message: this is what we want to log once + (optionally) speak.
  if (name === "chat") {
    const runId = String(extractRunIdFromPayload(payload) || payload?.runId || "chat");
    const stateValue = payload?.state;
    const seq = typeof payload?.seq === "number" ? payload.seq : null;

    // Deduplicate by (runId, seq) when available.
    if (seq !== null) {
      const last = lastChatSeqByRunId.get(runId);
      if (typeof last === "number" && seq <= last) {
        logDebug("gateway.eventNames", `Gateway event: chat (dedup seq=${seq})`);
        return;
      }
      lastChatSeqByRunId.set(runId, seq);
    }

    logDebug("gateway.eventNames", "Gateway event: chat");

    // Some gateway builds stream partial content via chat events (state: "delta" / "partial" / etc.).
    // We treat any non-final chat with a message body as a live update for the CHAT window.
    if (stateValue && stateValue !== "final") {
      const partialText = stripReplyTags(extractChatMessageText(payload?.message));
      if (partialText) {
        const now = Date.now();
        const prev = chatRunBuffers.get(runId) || { text: "", lastUpdatedAtMs: 0 };
        if (partialText !== prev.text && now - prev.lastUpdatedAtMs > CHAT_THROTTLE_MS) {
          chatRunBuffers.set(runId, { text: partialText, lastUpdatedAtMs: now });
          upsertChatMessage({ runId, role: "assistant", text: partialText, final: false });
        }
      }
      return;
    }

    if (stateValue === "final") {
      const finalText = stripReplyTags(extractChatMessageText(payload?.message));
      if (finalText) {
        // Update CHAT window with the final version.
        upsertChatMessage({ runId, role: "assistant", text: finalText, final: true });

        // Extra safety: if gateway replays the final, don't spam logs/tts.
        const prevFinal = lastFinalTextByRunId.get(runId);
        if (prevFinal === finalText) {
          logDebug("gateway.eventNames", "Chat final replay suppressed.");
          return;
        }
        lastFinalTextByRunId.set(runId, finalText);

        // Cleanup to avoid unbounded growth (can otherwise degrade Chrome over long sessions).
        chatRunBuffers.delete(runId);
        lastChatSeqByRunId.delete(runId);
        // Keep lastFinalTextByRunId entry briefly for dedup, then drop it.
        setTimeout(() => lastFinalTextByRunId.delete(runId), 5 * 60 * 1000);

        if (state.speakingEnabled) {
          ensureOffscreen()
            .then(() => chrome.runtime.sendMessage({ type: "offscreen.updateSettings", payload: settings }))
            .then(() => chrome.runtime.sendMessage({ type: "offscreen.playTts", payload: { text: finalText } }))
            .catch((error) => {
              const msg = error instanceof Error ? error.message : String(error);
              logError(`TTS failed: ${msg}`);
            });
          updateTalkStatus(TalkState.SPEAKING);
          logInfo("assistant", `Assistant reply received (${finalText.length} chars).`);
        } else {
          logInfo("assistant", `Assistant: ${finalText}`);
          updateTalkStatus(TalkState.LISTENING);
        }
      }
    }

    return;
  }

  // Other events: debug names/heartbeats, and optional raw res payload.
  const isHeartbeat =
    name === "tick" ||
    name === "health" ||
    name.endsWith(".tick") ||
    name.endsWith(".health") ||
    name.includes("heartbeat");

  if (name) {
    logDebug("gateway.eventNames", `Gateway event: ${name}`);
  } else {
    logDebug("gateway.eventNames", "Gateway event received.");
  }

  if (isHeartbeat) {
    logDebug("gateway.heartbeats", name ? `Gateway heartbeat: ${name}` : "Gateway heartbeat");
  }

  const cfg = computeLogConfig();
  if (cfg.debugEnabled && Boolean(settings.logDebugGatewayResPayload) && name === "res") {
    let raw = "";
    try {
      raw = JSON.stringify(payload);
    } catch {
      raw = String(payload);
    }
    if (raw.length > 1200) raw = `${raw.slice(0, 1200)}…`;
    addLog(`Gateway res payload: ${raw}`, "debug", "gateway.resPayload");
  }
}

function sendTranscript(text) {
  // Any transcript means the "no transcript" watchdog should be suppressed.
  awaitingTranscript = false;
  utteranceActive = false;
  utteranceHasTranscript = true;

  if (transcriptWaitTimer) {
    clearTimeout(transcriptWaitTimer);
    transcriptWaitTimer = null;
  }

  if (settings.dryRun) {
    logInfo("speech", `Transcript (dry run): ${text}`);
    updateTalkStatus(TalkState.LISTENING);
    return;
  }

  if (!gatewayClient || !gatewayClient.connected) {
    updateTalkStatus(TalkState.ERROR);
    logError("Cannot send transcript: gateway not connected.");
    return;
  }

  const targetSessionKey = (settings.sessionKey || "main").trim() || "main";
  gatewayClient.sendChat(text, targetSessionKey)
    .then((response) => {
      if (response?.ok === false) {
        const errorMessage = response?.error?.message || "chat.send failed.";
        updateTalkStatus(TalkState.ERROR);
        logError(`Cannot send transcript: ${errorMessage}`);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      updateTalkStatus(TalkState.ERROR);
      logError(`Cannot send transcript: ${message}`);
    });

  updateTalkStatus(TalkState.THINKING);
  logDebug("speech.transcriptText", `Transcript: ${text}`);
  logInfo("speech", `Transcript sent (${text.length} chars).`);
}

async function startTalk() {
  await loadSettings();

  if (!state.gatewayConnected && !settings.dryRun) {
    logError("Connect to the gateway before starting Talk.");
    return;
  }

  // Talk loop runs in the sidepanel (mic/VAD/STT). Offscreen is for TTS only.
  state.talkEnabled = true;
  broadcastState();
  logInfo("speech", "Starting talk loop.");

  if (state.speakingEnabled) {
    try {
      const offscreenStatus = await ensureOffscreen();
      if (offscreenStatus?.supported === false) {
        logError("Offscreen API not available; TTS disabled.");
      }
      chrome.runtime.sendMessage({ type: "offscreen.updateSettings", payload: settings });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError(`Offscreen setup failed: ${msg}`);
    }
  }

  updateTalkStatus(TalkState.LISTENING);
}

function stopTalk() {
  state.talkEnabled = false;
  broadcastState();

  // Sidepanel will stop mic/VAD/STT on state update. Offscreen only needs to stop TTS.
  chrome.runtime.sendMessage({ type: "offscreen.stopTts" });

  updateTalkStatus(TalkState.IDLE);
  logInfo("speech", "Talk loop stopped.");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "panel.getState") {
    sendResponse(state);
    return;
  }

  if (message.type === "panel.listSessions") {
    if (!gatewayClient || !gatewayClient.connected) {
      sendResponse({ ok: false, error: "Gateway not connected." });
      return;
    }

    gatewayClient
      .request("sessions.list", { limit: 50, includeGlobal: true, includeDerivedTitles: true, includeLastMessage: true })
      .then((res) => {
        const sessions = res?.payload?.sessions || [];
        state.sessions = sessions;
        broadcastState();
        sendResponse({ ok: true, sessions });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });

    return true;
  }

  if (message.type === "panel.deleteSession") {
    const key = String(message.payload?.key || "").trim();
    if (!key) {
      sendResponse({ ok: false, error: "Session key required." });
      return;
    }
    if (key === "main") {
      sendResponse({ ok: false, error: "Cannot delete main session." });
      return;
    }
    if (!gatewayClient || !gatewayClient.connected) {
      sendResponse({ ok: false, error: "Gateway not connected." });
      return;
    }

    gatewayClient
      .request("sessions.delete", { key, deleteTranscript: true }, { timeoutMs: 20000 })
      .then(() => {
        // If we deleted the active session, reset back to main.
        if ((settings.sessionKey || "main") === key) {
          settings.sessionKey = "main";
          state.sessionKey = "main";
          chrome.storage.local.set({ sessionKey: "main" });
        }

        // Refresh session list.
        return gatewayClient.request("sessions.list", { limit: 50, includeGlobal: true, includeDerivedTitles: true, includeLastMessage: true });
      })
      .then((res) => {
        state.sessions = res?.payload?.sessions || [];
        broadcastState();
        sendResponse({ ok: true });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });

    return true;
  }

  if (message.type === "panel.logError") {
    const msgText = String(message.payload?.message || "").trim();
    if (msgText) {
      logError(msgText);
    }
    sendResponse?.({ ok: true });
    return;
  }

  if (message.type === "panel.setSessionKey") {
    const key = String(message.payload?.sessionKey || "main").trim() || "main";
    settings.sessionKey = key;
    state.sessionKey = key;
    chrome.storage.local.set({ sessionKey: key });
    broadcastState();
    logInfo("connect", `Session set to ${key}.`);

    // Load history for the newly selected session (optional).
    loadSessionHistoryIntoChat(key);

    sendResponse?.({ ok: true });
    return;
  }

  if (message.type === "panel.sendTextPrompt") {
    const text = String(message.payload?.text || "").trim();
    if (!text) {
      sendResponse?.({ ok: false, error: "Message is empty." });
      return;
    }

    const targetSessionKey = (settings.sessionKey || "main").trim() || "main";

    sendPromptToGateway({
      text,
      sessionKey: targetSessionKey,
      chatPreviewText: text,
      sourceLabel: "Text prompt",
    })
      .then(() => {
        sendResponse?.({ ok: true });
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        updateTalkStatus(TalkState.ERROR);
        logError(`Text prompt failed: ${errorMessage}`);
        sendResponse?.({ ok: false, error: errorMessage });
      });

    return true;
  }

  if (message.type === "panel.runDemoPreReview") {
    if (state.demoPreReviewRunning) {
      sendResponse?.({ ok: false, error: "Demo flow is already running." });
      return;
    }

    sendResponse?.({ ok: true, started: true });

    runDemoPreReviewFlow()
      .then(() => {
        logInfo("connect", "Demo pre-review flow completed.");
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        updateTalkStatus(TalkState.ERROR);
        logError(`Demo pre-review failed: ${errorMessage}`);
      });

    return;
  }

  if (message.type === "panel.toggleConnect") {
    loadSettings().then(() => {
      state.connectEnabled = !state.connectEnabled;
      broadcastState();
      if (state.connectEnabled) {
        connectGateway();
      } else {
        // Stop talk before disconnect for cleanliness.
        if (state.talkEnabled) {
          stopTalk();
        }
        // Ensure UI reflects we're fully disconnected.
        updateTalkStatus(TalkState.DISCONNECTED);
        disconnectGateway();
        logInfo("connect", "Gateway disconnected.");
      }
    });
    return;
  }

  if (message.type === "panel.toggleTalk") {
    if (state.talkEnabled) {
      stopTalk();
    } else {
      startTalk();
    }
    return;
  }

  if (message.type === "panel.setTalkEnabled") {
    const enabled = Boolean(message.payload?.enabled);
    if (enabled) {
      startTalk();
    } else {
      stopTalk();
    }
    return;
  }

  if (message.type === "panel.setSpeaking") {
    const enabled = Boolean(message.payload?.enabled);
    state.speakingEnabled = enabled;
    broadcastState();
    chrome.storage.local.set({ speakingEnabled: enabled });

    // If user turns Speaking OFF while audio is playing, stop immediately.
    if (!enabled) {
      ensureOffscreen()
        .then((status) => {
          if (status?.supported === false) return;
          chrome.runtime.sendMessage({ type: "offscreen.stopTts" });
        })
        .catch(() => {
          // ignore
        });

      if (state.status === TalkState.SPEAKING) {
        // Return to a sensible non-speaking state.
        updateTalkStatus(state.talkEnabled ? TalkState.LISTENING : TalkState.IDLE);
      }
    }

    logInfo("connect", `Speaking ${enabled ? "enabled" : "disabled"}.`);
    return;
  }

  if (message.type === "options.updated") {
    loadSettings();
    chrome.runtime.sendMessage({ type: "offscreen.updateSettings", payload: settings });
    return;
  }

  if (message.type === "options.testSpeech") {
    const text = String(message.payload?.text || "").trim();
    if (!text) {
      sendResponse?.({ ok: false, error: "Text is empty." });
      return;
    }

    const requestId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
      ? globalThis.crypto.randomUUID()
      : String(Date.now()) + "-" + Math.random().toString(16).slice(2);

    logDebug("speech.test", `Speech test: requested (len=${text.length})`);

    const waitForComplete = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingTtsRequests.delete(requestId);
        logDebug("speech.test", "Speech test: timed out");
        reject(new Error("TTS timed out"));
      }, 20000);
      pendingTtsRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
        meta: { kind: "speechTest", startedAtMs: Date.now(), textLen: text.length }
      });
    });

    ensureOffscreen()
      .then((status) => {
        if (status?.supported === false) {
          throw new Error("Offscreen API not available");
        }
        return chrome.runtime.sendMessage({ type: "offscreen.updateSettings", payload: settings });
      })
      .then(() => chrome.runtime.sendMessage({ type: "offscreen.playTts", payload: { text, requestId } }))
      .then(() => waitForComplete)
      .then(() => sendResponse?.({ ok: true }))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse?.({ ok: false, error: msg });
      });

    return true;
  }

  if (message.type === "tts.complete") {
    const requestId = message.payload?.requestId;

    // Speech test completion.
    if (requestId && pendingTtsRequests.has(requestId)) {
      const pending = pendingTtsRequests.get(requestId);
      const tookMs = pending?.meta?.startedAtMs ? Date.now() - pending.meta.startedAtMs : null;
      logDebug("speech.test", `Speech test: complete${tookMs !== null ? ` (took ${tookMs}ms)` : ""}`);
      clearTimeout(pending.timeoutId);
      pendingTtsRequests.delete(requestId);
      pending.resolve(true);
      return;
    }

    // Regular assistant TTS completion: return from SPEAKING to LISTENING/IDLE.
    if (state.status === TalkState.SPEAKING) {
      if (state.talkEnabled) {
        updateTalkStatus(TalkState.LISTENING);
      } else if (state.gatewayConnected || settings.dryRun) {
        updateTalkStatus(TalkState.IDLE);
      } else {
        updateTalkStatus(TalkState.DISCONNECTED);
      }
    }

    return;
  }

  if (message.type === "tts.error") {
    const requestId = message.payload?.requestId;
    const errMsg = String(message.payload?.error || "TTS failed");

    // Speech test errors.
    if (requestId && pendingTtsRequests.has(requestId)) {
      const pending = pendingTtsRequests.get(requestId);
      const tookMs = pending?.meta?.startedAtMs ? Date.now() - pending.meta.startedAtMs : null;
      logDebug(
        "speech.test",
        `Speech test: error${tookMs !== null ? ` (after ${tookMs}ms)` : ""}: ${errMsg}`
      );
      clearTimeout(pending.timeoutId);
      pendingTtsRequests.delete(requestId);
      pending.reject(new Error(errMsg));
      return;
    }

    // Regular assistant TTS errors.
    logError(errMsg);
    if (state.status === TalkState.SPEAKING) {
      if (state.talkEnabled) {
        updateTalkStatus(TalkState.LISTENING);
      } else if (state.gatewayConnected || settings.dryRun) {
        updateTalkStatus(TalkState.IDLE);
      } else {
        updateTalkStatus(TalkState.DISCONNECTED);
      }
    }

    return;
  }

  // Offscreen mic loop events
  if (message.type === "speech.start") {
    utteranceActive = true;
    utteranceHasTranscript = false;

    awaitingTranscript = false;
    if (transcriptWaitTimer) {
      clearTimeout(transcriptWaitTimer);
      transcriptWaitTimer = null;
    }
    updateTalkStatus(TalkState.LISTENING);
    return;
  }

  if (message.type === "speech.error") {
    awaitingTranscript = false;
    if (transcriptWaitTimer) {
      clearTimeout(transcriptWaitTimer);
      transcriptWaitTimer = null;
    }
    const code = message.payload?.error || "unknown";
    const detail = message.payload?.message ? ` (${message.payload.message})` : "";
    logError(`SpeechRecognition error: ${code}${detail}`);
    updateTalkStatus(TalkState.LISTENING);
    return;
  }

  if (message.type === "speech.end") {
    // Ignore spurious end events when we never observed a matching speech.start.
    if (!utteranceActive) {
      return;
    }

    // SpeechRecognition can emit result before end(). If we already received a transcript
    // for this utterance, don't start the "no transcript" watchdog.
    if (utteranceHasTranscript) {
      utteranceActive = false;
      return;
    }

    // Treat end-of-speech as "thinking" (send + wait for reply), but guard against
    // the case where SpeechRecognition returns no transcript.
    awaitingTranscript = true;
    updateTalkStatus(TalkState.THINKING);

    if (transcriptWaitTimer) {
      clearTimeout(transcriptWaitTimer);
    }
    transcriptWaitTimer = setTimeout(() => {
      transcriptWaitTimer = null;
      if (awaitingTranscript && state.talkEnabled) {
        awaitingTranscript = false;
        utteranceActive = false;
        logDebug("speech.transcriptText", "No transcript received (SpeechRecognition may have returned empty).");
        updateTalkStatus(TalkState.LISTENING);
      }
    }, 4000);

    return;
  }

  if (message.type === "speech.transcript") {
    utteranceActive = true;
    utteranceHasTranscript = Boolean(message.payload?.text);

    if (message.payload?.text) {
      sendTranscript(message.payload.text);
    } else {
      awaitingTranscript = false;
      if (transcriptWaitTimer) {
        clearTimeout(transcriptWaitTimer);
        transcriptWaitTimer = null;
      }
      logDebug("speech.transcriptText", "Empty transcript received.");
      updateTalkStatus(TalkState.LISTENING);
    }
    return;
  }

  if (message.type === "speech.interrupt") {
    chrome.runtime.sendMessage({ type: "offscreen.stopTts" });
    updateTalkStatus(TalkState.LISTENING);
    return;
  }

  if (message.type === "tts.complete") {
    // Only meaningful when speaking is enabled.
    if (state.speakingEnabled) {
      updateTalkStatus(TalkState.LISTENING);
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) => console.warn("[ClawTalk] Failed to set side panel behavior", error));
  }
});

loadSettings();
