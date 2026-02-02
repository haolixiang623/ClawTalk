const gatewayUrlInput = document.getElementById("gateway-url");
const gatewayTokenInput = document.getElementById("gateway-token");
const gatewayOriginsInput = document.getElementById("gateway-origins");
const headersList = document.getElementById("headers-list");
const addHeaderButton = document.getElementById("add-header");
const dryRunInput = document.getElementById("dry-run");
// (legacy) debug-events checkbox removed
const sttLangInput = document.getElementById("stt-lang");
const pushToTalkInput = document.getElementById("push-to-talk");

const sessionKeyInput = document.getElementById("session-key");

const loadSessionHistoryInput = document.getElementById("load-session-history");
const sessionHistoryLimitInput = document.getElementById("session-history-limit");

const maxLogEntriesInput = document.getElementById("max-log-entries");
const maxChatMessagesInput = document.getElementById("max-chat-messages");

const logDebugInput = document.getElementById("log-debug");
const logDebugGatewayEventsInput = document.getElementById("log-debug-gateway-events");
const logDebugGatewayHeartbeatsInput = document.getElementById("log-debug-gateway-heartbeats");
const logDebugTranscriptTextInput = document.getElementById("log-debug-transcript-text");
const logDebugGatewayResPayloadInput = document.getElementById("log-debug-gateway-res-payload");

const logInfoInput = document.getElementById("log-info");
const logInfoConnectInput = document.getElementById("log-info-connect");
const logInfoAssistantInput = document.getElementById("log-info-assistant");
const logInfoSpeechInput = document.getElementById("log-info-speech");

const micSelect = document.getElementById("mic-select");
const refreshMicsButton = document.getElementById("refresh-mics");
const micTestButton = document.getElementById("mic-test");
const micMeterFill = document.getElementById("mic-meter-fill");
const micTestStatus = document.getElementById("mic-test-status");

const speechTestButton = document.getElementById("speech-test");
const speechTestText = document.getElementById("speech-test-text");
const speechTestStatus = document.getElementById("speech-test-status");
const ttsProviderSelect = document.getElementById("tts-provider");
const elevenlabsSettings = document.getElementById("elevenlabs-settings");
const elevenlabsKeyInput = document.getElementById("elevenlabs-key");
const elevenlabsVoiceInput = document.getElementById("elevenlabs-voice");
const saveButton = document.getElementById("save");
const saveStatus = document.getElementById("save-status");

const DEFAULTS = {
  gatewayUrl: "ws://127.0.0.1:18789",
  gatewayToken: "",
  gatewayHeaders: [],
  // Back-compat: old list. With the new behavior, the active gateway origin is always included
  // automatically, and this text box is only for "additional" origins.
  gatewayAllowedOrigins: ["ws://127.0.0.1:18789/*"],
  gatewayAdditionalOrigins: [],
  dryRun: false,

  sessionKey: "main",

  loadSessionHistory: true,
  sessionHistoryLimit: 200,

  maxLogEntries: 100,
  maxChatMessages: 20,

  logDebug: false,
  logDebugGatewayEventNames: false,
  logDebugGatewayHeartbeats: false,
  logDebugTranscriptText: false,
  logDebugGatewayResPayload: false,

  logInfo: true,
  logInfoConnect: true,
  logInfoAssistant: true,
  logInfoSpeech: true,

  sttLang: "it-IT",
  inputDeviceId: "",
  pushToTalk: false,
  ttsProvider: "default",
  // Back-compat (old boolean setting)
  ttsProvider: "default",
  // Back-compat (old boolean setting)
  useElevenLabs: false,
  elevenlabsKey: "",
  elevenlabsVoice: ""
};

let micTestActive = false;

function createHeaderRow({ name = "", value = "" } = {}) {
  const row = document.createElement("div");
  row.className = "header-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Header name";
  nameInput.value = name;
  nameInput.className = "header-name";

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.placeholder = "Header value";
  valueInput.value = value;
  valueInput.className = "header-value";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "header-remove";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", () => {
    row.remove();
  });

  row.append(nameInput, valueInput, removeButton);
  return row;
}

function renderHeaders(headers = []) {
  headersList.innerHTML = "";
  headers.forEach((header) => {
    headersList.append(createHeaderRow(header));
  });
}

function showStatus(text) {
  saveStatus.textContent = text;
  setTimeout(() => {
    saveStatus.textContent = "";
  }, 2000);
}

function normalizeGatewayOriginLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    // Allow patterns like ws://host/* (URL parsing fails on naked wildcards)
    // If it looks like a match pattern already, keep it.
    if (/^wss?:\/\/.+\*\/$/.test(raw) || /^wss?:\/\/.+\/\*$/.test(raw) || /^wss?:\/\/.+\/\*$/.test(raw)) {
      return raw;
    }
    return null;
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  return `${url.protocol}//${url.host}/*`;
}

function parseGatewayAllowedOrigins(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const origins = [];
  for (const line of lines) {
    const normalized = normalizeGatewayOriginLine(line);
    if (normalized && !origins.includes(normalized)) {
      origins.push(normalized);
    }
  }
  return origins;
}

async function requestOriginPermissions(origins) {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) return { ok: false, error: "permissions API not available" };

  const toRequest = [];
  for (const origin of origins) {
    try {
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (!has) toRequest.push(origin);
    } catch {
      toRequest.push(origin);
    }
  }

  if (!toRequest.length) return { ok: true, requested: 0 };

  const granted = await chrome.permissions.request({ origins: toRequest });
  return granted ? { ok: true, requested: toRequest.length } : { ok: false, error: "Permission request denied" };
}

function setSpeechTestStatus(text) {
  if (!speechTestStatus) return;
  speechTestStatus.textContent = text || "";
}

function setMicMeter(rms) {
  // Map typical RMS range (~0.0-0.2) to a 0-100% bar.
  const normalized = Math.max(0, Math.min(1, (rms || 0) / 0.2));
  micMeterFill.style.width = `${Math.round(normalized * 100)}%`;
}

function setMicTestStatus(text) {
  micTestStatus.textContent = text || "";
}

function renderMicOptions(devices = [], selectedId = "") {
  micSelect.innerHTML = "";

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Default microphone";
  micSelect.appendChild(defaultOpt);

  devices.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`;
    micSelect.appendChild(opt);
  });

  micSelect.value = selectedId || "";
}

async function refreshMicrophones() {
  setMicTestStatus("Loading devices…");

  if (!navigator.mediaDevices?.enumerateDevices) {
    setMicTestStatus("enumerateDevices() not available.");
    return;
  }

  const all = await navigator.mediaDevices.enumerateDevices();
  const devices = all
    .filter((d) => d.kind === "audioinput")
    .map((d) => ({ deviceId: d.deviceId, label: d.label }));

  const data = await chrome.storage.local.get(DEFAULTS);
  renderMicOptions(devices, data.inputDeviceId);
  setMicTestStatus("");
}

async function startMicTest() {
  if (micTestActive) return;
  micTestActive = true;

  setMicTestStatus("Requesting microphone permission…");

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    micTestActive = false;
    const msg = error instanceof Error ? error.message : String(error);
    setMicTestStatus(`Mic permission failed: ${msg}`);
    return;
  }

  setMicTestStatus("Mic test running…");

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);

  const interval = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      sum += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sum / buffer.length);
    setMicMeter(rms);
  }, 80);

  // Stop after ~5 seconds.
  setTimeout(() => {
    clearInterval(interval);
    stream.getTracks().forEach((t) => t.stop());
    audioContext.close();
    setMicMeter(0);
    setMicTestStatus("Mic test finished.");
    micTestActive = false;
  }, 5000);
}

function syncEventLogUi() {
  const debugOn = Boolean(logDebugInput.checked);
  logDebugGatewayEventsInput.disabled = !debugOn;
  logDebugGatewayHeartbeatsInput.disabled = !debugOn;
  logDebugTranscriptTextInput.disabled = !debugOn;
  logDebugGatewayResPayloadInput.disabled = !debugOn;

  const infoOn = Boolean(logInfoInput.checked);
  logInfoConnectInput.disabled = !infoOn;
  logInfoAssistantInput.disabled = !infoOn;
  logInfoSpeechInput.disabled = !infoOn;
}

function resolveTtsProvider(data) {
  // New setting: ttsProvider
  if (data?.ttsProvider === "elevenlabs" || data?.ttsProvider === "default") {
    return data.ttsProvider;
  }
  // Back-compat: old useElevenLabs boolean
  if (data?.useElevenLabs === true) return "elevenlabs";
  return "default";
}

function syncTtsUi() {
  const provider = String(ttsProviderSelect?.value || "default");
  const isEleven = provider === "elevenlabs";

  if (elevenlabsSettings) {
    elevenlabsSettings.style.display = isEleven ? "block" : "none";
  }

  if (elevenlabsKeyInput) elevenlabsKeyInput.disabled = !isEleven;
  if (elevenlabsVoiceInput) elevenlabsVoiceInput.disabled = !isEleven;
}

async function loadSettings() {
  const data = await chrome.storage.local.get(DEFAULTS);
  gatewayUrlInput.value = data.gatewayUrl;
  gatewayTokenInput.value = data.gatewayToken;

  // Migration:
  // - New: gatewayAdditionalOrigins
  // - Old: gatewayAllowedOrigins (used to include the gateway origin + extras)
  const additional = Array.isArray(data.gatewayAdditionalOrigins)
    ? data.gatewayAdditionalOrigins
    : (Array.isArray(data.gatewayAllowedOrigins)
      ? data.gatewayAllowedOrigins.filter((o) => !String(o).startsWith("ws://127.0.0.1:18789"))
      : DEFAULTS.gatewayAdditionalOrigins);

  if (gatewayOriginsInput) {
    gatewayOriginsInput.value = (additional && additional.length ? additional : []).join("\n");
  }
  renderHeaders(data.gatewayHeaders);
  dryRunInput.checked = data.dryRun;
  pushToTalkInput.checked = data.pushToTalk;

  sessionKeyInput.value = data.sessionKey || "main";

  loadSessionHistoryInput.checked = data.loadSessionHistory !== false;
  sessionHistoryLimitInput.value = data.sessionHistoryLimit || 200;

  maxLogEntriesInput.value = data.maxLogEntries;
  maxChatMessagesInput.value = data.maxChatMessages;

  logDebugInput.checked = data.logDebug;
  logDebugGatewayEventsInput.checked = data.logDebugGatewayEventNames;
  logDebugGatewayHeartbeatsInput.checked = data.logDebugGatewayHeartbeats;
  logDebugTranscriptTextInput.checked = data.logDebugTranscriptText;
  logDebugGatewayResPayloadInput.checked = data.logDebugGatewayResPayload;

  logInfoInput.checked = data.logInfo;
  logInfoConnectInput.checked = data.logInfoConnect;
  logInfoAssistantInput.checked = data.logInfoAssistant;
  logInfoSpeechInput.checked = data.logInfoSpeech;

  syncEventLogUi();

  sttLangInput.value = data.sttLang;

  const provider = resolveTtsProvider(data);
  if (ttsProviderSelect) ttsProviderSelect.value = provider;

  elevenlabsKeyInput.value = data.elevenlabsKey;
  elevenlabsVoiceInput.value = data.elevenlabsVoice;
  syncTtsUi();

  // Populate mic selector (may need permission before labels appear).
  renderMicOptions([], data.inputDeviceId);
  refreshMicrophones();
}

async function saveSettings() {
  const gatewayHeaders = Array.from(headersList.querySelectorAll(".header-row"))
    .map((row) => {
      const name = row.querySelector(".header-name")?.value.trim() || "";
      const value = row.querySelector(".header-value")?.value.trim() || "";
      return { name, value };
    })
    .filter((header) => header.name);

  const maxLogEntries = Math.max(10, Math.min(2000, Number(maxLogEntriesInput.value) || DEFAULTS.maxLogEntries));
  const maxChatMessages = Math.max(1, Math.min(500, Number(maxChatMessagesInput.value) || DEFAULTS.maxChatMessages));

  const sessionHistoryLimit = Math.max(10, Math.min(2000, Number(sessionHistoryLimitInput.value) || DEFAULTS.sessionHistoryLimit));

  const ttsProvider = String(ttsProviderSelect?.value || "default");
  const useElevenLabs = ttsProvider === "elevenlabs";

  const gatewayUrl = gatewayUrlInput.value.trim() || DEFAULTS.gatewayUrl;

  const gatewayOrigin = normalizeGatewayOriginLine(gatewayUrl);
  if (!gatewayOrigin) {
    showStatus("Invalid Gateway URL.");
    return;
  }

  const gatewayAdditionalOrigins = parseGatewayAllowedOrigins(gatewayOriginsInput?.value);
  const allOrigins = [gatewayOrigin, ...gatewayAdditionalOrigins.filter((o) => o !== gatewayOrigin)];

  const settings = {
    gatewayUrl,
    gatewayToken: gatewayTokenInput.value.trim(),
    gatewayHeaders,
    gatewayAdditionalOrigins,
    dryRun: dryRunInput.checked,
    pushToTalk: pushToTalkInput.checked,

    sessionKey: (sessionKeyInput.value || "main").trim() || "main",

    loadSessionHistory: Boolean(loadSessionHistoryInput.checked),
    sessionHistoryLimit,

    maxLogEntries,
    maxChatMessages,

    logDebug: logDebugInput.checked,
    logDebugGatewayEventNames: logDebugInput.checked ? logDebugGatewayEventsInput.checked : false,
    logDebugGatewayHeartbeats: logDebugInput.checked ? logDebugGatewayHeartbeatsInput.checked : false,
    logDebugTranscriptText: logDebugInput.checked ? logDebugTranscriptTextInput.checked : false,
    logDebugGatewayResPayload: logDebugInput.checked ? logDebugGatewayResPayloadInput.checked : false,

    logInfo: logInfoInput.checked,
    logInfoConnect: logInfoInput.checked ? logInfoConnectInput.checked : false,
    logInfoAssistant: logInfoInput.checked ? logInfoAssistantInput.checked : false,
    logInfoSpeech: logInfoInput.checked ? logInfoSpeechInput.checked : false,

    sttLang: sttLangInput.value.trim() || DEFAULTS.sttLang,
    inputDeviceId: micSelect.value || "",

    ttsProvider,
    useElevenLabs, // back-compat for existing code paths
    elevenlabsKey: useElevenLabs ? elevenlabsKeyInput.value.trim() : "",
    elevenlabsVoice: useElevenLabs ? elevenlabsVoiceInput.value.trim() : ""
  };

  if (useElevenLabs) {
    if (!settings.elevenlabsKey || !settings.elevenlabsVoice) {
      showStatus("Missing ElevenLabs settings.");
      return;
    }
  }

  // Request missing permissions before saving (Chrome will prompt the user).
  const permResult = await requestOriginPermissions(allOrigins);
  if (!permResult.ok) {
    showStatus(permResult.error || "Permission request denied.");
    return;
  }

  await chrome.storage.local.set(settings);
  showStatus("Saved.");

  chrome.runtime.sendMessage({ type: "options.updated" });
}

logDebugInput.addEventListener("change", () => {
  if (!logDebugInput.checked) {
    logDebugGatewayEventsInput.checked = false;
    logDebugGatewayHeartbeatsInput.checked = false;
    logDebugTranscriptTextInput.checked = false;
    logDebugGatewayResPayloadInput.checked = false;
  }
  syncEventLogUi();
});

logInfoInput.addEventListener("change", () => {
  if (!logInfoInput.checked) {
    logInfoConnectInput.checked = false;
    logInfoAssistantInput.checked = false;
    logInfoSpeechInput.checked = false;
  }
  syncEventLogUi();
});

ttsProviderSelect?.addEventListener("change", () => {
  syncTtsUi();
});

saveButton.addEventListener("click", () => {
  saveSettings();
});

addHeaderButton.addEventListener("click", () => {
  headersList.append(createHeaderRow());
});

refreshMicsButton.addEventListener("click", () => {
  refreshMicrophones();
});

micTestButton.addEventListener("click", () => {
  startMicTest();
});

speechTestButton?.addEventListener("click", () => {
  const text = String(speechTestText?.value || "").trim();
  if (!text) {
    setSpeechTestStatus("Text is empty.");
    return;
  }

  // If ElevenLabs is enabled, enforce required settings for the test.
  if (String(ttsProviderSelect?.value || "default") === "elevenlabs") {
    const key = String(elevenlabsKeyInput?.value || "").trim();
    const voice = String(elevenlabsVoiceInput?.value || "").trim();
    if (!key || !voice) {
      setSpeechTestStatus("Missing ElevenLabs settings.");
      return;
    }
  }

  setSpeechTestStatus("Playing…");

  chrome.runtime.sendMessage({ type: "options.testSpeech", payload: { text } }, (res) => {
    if (res && res.ok) {
      setSpeechTestStatus("Finished.");
      return;
    }
    if (res?.error && String(res.error).includes("ElevenLabs request failed")) {
      setSpeechTestStatus("ElevenLabs request failed");
      return;
    }
    setSpeechTestStatus(res?.error || "Failed to play.");
  });
});

loadSettings();
