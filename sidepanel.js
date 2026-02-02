import { VadDetector, computeRms } from "./shared/vad.js";
import { createSpeechRecognitionAdapter } from "./shared/stt.js";

const connectToggle = document.getElementById("connect-toggle");
const talkToggle = document.getElementById("talk-toggle");
const speakingToggle = document.getElementById("speaking-toggle");
const statusText = document.getElementById("status-text");
const micIndicator = document.getElementById("mic-indicator");
const connectionText = document.getElementById("connection-text");
const modeText = document.getElementById("mode-text");
const sessionSelect = document.getElementById("session-select");
const sessionDelete = document.getElementById("session-delete");
const settingsButton = document.getElementById("settings");
const chatList = document.getElementById("chat-list");
const chatCount = document.getElementById("chat-count");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const logList = document.getElementById("log-list");
const logCount = document.getElementById("log-count");

let currentState = "disconnected";
let lastState = null;

// Audio + VAD + STT
let mediaStream = null;
let audioContext = null;
let analyser = null;
let vadDetector = null;
let vadInterval = null;
let recognitionAdapter = null;
let lastSpeaking = false;

// Push-to-talk flow
let pttActive = false;

const stateLabels = {
  disconnected: "Disconnected",
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  error: "Error"
};

function renderSessions(state) {
  if (!sessionSelect) return;

  const selected = state?.sessionKey || "main";
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];

  if (sessionDelete) {
    // Don't allow deleting the main session.
    sessionDelete.disabled = selected === "main";
  }

  // Always include "main".
  const items = [{ key: "main", label: "main" }, ...sessions.map((s) => ({
    key: s.key,
    label: s.derivedTitle || s.displayName || s.label || s.key
  }))];

  // Deduplicate by key.
  const seen = new Set();
  const deduped = items.filter((it) => {
    if (!it.key || seen.has(it.key)) return false;
    seen.add(it.key);
    return true;
  });

  sessionSelect.innerHTML = "";
  deduped.forEach((it) => {
    const opt = document.createElement("option");
    opt.value = it.key;
    opt.textContent = it.label;
    sessionSelect.appendChild(opt);
  });

  sessionSelect.value = selected;
}

function updateUI(state) {
  lastState = state;
  currentState = state.status || currentState;
  statusText.textContent = stateLabels[currentState] || currentState;

  const connected = Boolean(state.gatewayConnected);
  connectToggle.classList.toggle("connected", connected);
  connectToggle.textContent = connected ? "Disconnect" : "Connect";

  // Talk label depends on mode.
  const isPtt = Boolean(state.pushToTalk);
  if (isPtt) {
    talkToggle.textContent = connected ? "Hold to talk" : "Talk";
  } else {
    talkToggle.textContent = state.talkEnabled ? "Stop" : "Talk";
  }

  // Talk is disabled unless connected (except when already running).
  talkToggle.disabled = !connected && !state.talkEnabled;
  talkToggle.classList.toggle("active", state.talkEnabled);

  speakingToggle.checked = Boolean(state.speakingEnabled);

  micIndicator.classList.toggle("listening", state.status === "listening");
  micIndicator.classList.toggle("speaking", state.status === "speaking");
  micIndicator.classList.toggle("active", state.talkEnabled);

  connectionText.textContent = `Gateway: ${state.gatewayUrl || "Not set"}`;
  modeText.textContent = `Mode: ${state.dryRun ? "Dry run" : "Live"}`;
  renderSessions(state);
  renderChat(state.chat || []);
  renderLogs(state.logs || []);

  // Text prompt input is enabled only when gateway is connected (or dry-run).
  const canSendText = Boolean(state.dryRun) || Boolean(state.gatewayConnected);
  if (chatInput) chatInput.disabled = !canSendText;
  if (chatSend) chatSend.disabled = !canSendText;
}

function renderChat(chat) {
  chatList.innerHTML = "";
  chatCount.textContent = `${chat.length}`;

  if (!chat.length) {
    const empty = document.createElement("div");
    empty.className = "chat-entry";
    empty.textContent = "No chat yet.";
    chatList.appendChild(empty);
    return;
  }

  chat.forEach((entry) => {
    const row = document.createElement("div");
    const pending = entry && entry.final === false;
    const role = entry?.role || "assistant";

    row.className = ["chat-entry", role, pending ? "pending" : ""].filter(Boolean).join(" ");

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatTime(entry.timestamp);

    const status = document.createElement("span");
    status.className = "chat-status";
    status.textContent = pending ? "…" : "";

    const who = document.createElement("span");
    who.className = "chat-who";
    who.textContent = role === "user" ? "You" : role === "assistant" ? "Assistant" : role;

    const message = document.createElement("span");
    message.className = "message";
    message.textContent = entry.text || "";

    row.append(time, status, who, message);
    chatList.appendChild(row);
  });

  chatList.scrollTop = chatList.scrollHeight;
}

function renderLogs(logs) {
  logList.innerHTML = "";
  logCount.textContent = `${logs.length}`;
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "log-entry";
    empty.textContent = "No logs yet.";
    logList.appendChild(empty);
    return;
  }

  logs.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `log-entry ${entry.level || "info"}`;

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatTime(entry.timestamp);

    const level = document.createElement("span");
    level.className = "level";
    level.textContent = entry.level || "info";

    const message = document.createElement("span");
    message.className = "message";
    message.textContent = entry.message || "";

    row.append(time, level, message);
    logList.appendChild(row);
  });
  logList.scrollTop = logList.scrollHeight;
}

function formatTime(timestamp) {
  if (!timestamp) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString();
}

function send(type, payload) {
  chrome.runtime.sendMessage({ type, payload });
}

function buildAudioConstraints(state) {
  const id = state?.inputDeviceId || "";
  if (!id) return { audio: true };
  return { audio: { deviceId: { exact: id } } };
}

async function ensureAudio(state) {
  if (audioContext) return;

  mediaStream = await navigator.mediaDevices.getUserMedia(buildAudioConstraints(state));
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  vadDetector = new VadDetector(state?.vad || { threshold: 0.02, hangoverMs: 700, minSpeechMs: 250 });
  recognitionAdapter = createSpeechRecognitionAdapter({ lang: state?.sttLang || "it-IT" });
}

function teardownAudio() {
  if (vadInterval) {
    clearInterval(vadInterval);
    vadInterval = null;
  }
  lastSpeaking = false;
  pttActive = false;

  recognitionAdapter?.abort?.();

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  analyser = null;
  vadDetector = null;
  recognitionAdapter = null;
}

function startRecognition() {
  if (!recognitionAdapter) return;
  recognitionAdapter.start(
    (transcript) => {
      if (transcript) {
        send("speech.transcript", { text: transcript });
      }
    },
    (err) => {
      send("speech.error", err || {});
    }
  );
}

function stopRecognition() {
  recognitionAdapter?.stop?.();
}

function startHandsFreeLoop(state) {
  if (!analyser || !vadDetector) return;

  const buffer = new Float32Array(analyser.fftSize);
  vadInterval = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    const rms = computeRms(buffer);
    const now = performance.now();
    const result = vadDetector.processRms(rms, now);

    if (result.event === "voice" && !lastSpeaking) {
      lastSpeaking = true;
      send("speech.start");

      // Interrupt TTS if user speaks while assistant is speaking.
      if (lastState?.status === "speaking" && lastState?.speakingEnabled) {
        send("speech.interrupt");
      }

      startRecognition();
    }

    if (result.event === "speech_end" && lastSpeaking) {
      lastSpeaking = false;
      stopRecognition();
      send("speech.end");
    }
  }, 50);
}

async function startTalkRuntime(state) {
  await ensureAudio(state);

  if (state.pushToTalk) {
    // In PTT mode, audio/STT starts on press.
    return;
  }

  // Hands-free mode: run VAD loop.
  startHandsFreeLoop(state);
}

function stopTalkRuntime() {
  teardownAudio();
}

// Respond to global state updates: start/stop runtime when talkEnabled changes.
function applyRuntimeFromState(state) {
  if (!state) return;

  if (state.talkEnabled) {
    startTalkRuntime(state).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      send("speech.error", { error: "audio-start-failed", message: msg });
    });
  } else {
    stopTalkRuntime();
  }
}

function requestState() {
  chrome.runtime.sendMessage({ type: "panel.getState" }, (response) => {
    if (response) {
      updateUI(response);
      applyRuntimeFromState(response);
    }
  });
}

let sessionsRefreshInFlight = false;
let lastSessionsRefreshAtMs = 0;
let lastGatewayConnected = false;

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "state.update") {
    updateUI(message.payload);
    applyRuntimeFromState(message.payload);

    const connected = Boolean(message.payload?.gatewayConnected);

    // Refresh session list on connect, and then occasionally (throttled).
    if (connected && (!lastGatewayConnected || shouldRefreshSessions())) {
      refreshSessions();
    }

    lastGatewayConnected = connected;
  }
});

connectToggle.addEventListener("click", () => {
  send("panel.toggleConnect");
});

// Talk button behavior depends on push-to-talk.
function onTalkPress() {
  if (!lastState) return;
  if (!lastState.gatewayConnected && !lastState.dryRun) return;
  if (!lastState.pushToTalk) return;
  if (pttActive) return;

  pttActive = true;
  send("panel.setTalkEnabled", { enabled: true });

  // Start audio and recognition immediately.
  ensureAudio(lastState)
    .then(() => {
      send("speech.start");
      startRecognition();
    })
    .catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      send("speech.error", { error: "audio-start-failed", message: msg });
    });
}

function onTalkRelease() {
  if (!lastState) return;
  if (!lastState.pushToTalk) return;
  if (!pttActive) return;

  pttActive = false;

  stopRecognition();
  send("speech.end");

  // Give recognition a moment to emit its final result.
  setTimeout(() => {
    send("panel.setTalkEnabled", { enabled: false });
  }, 200);
}

// Pointer events for press-and-hold.
talkToggle.addEventListener("pointerdown", (e) => {
  if (lastState?.pushToTalk) {
    e.preventDefault();
    onTalkPress();
  }
});

talkToggle.addEventListener("pointerup", (e) => {
  if (lastState?.pushToTalk) {
    e.preventDefault();
    onTalkRelease();
  }
});

talkToggle.addEventListener("pointercancel", () => {
  if (lastState?.pushToTalk) {
    onTalkRelease();
  }
});

talkToggle.addEventListener("click", () => {
  // In hands-free mode, it's a toggle.
  if (!lastState?.pushToTalk) {
    send("panel.toggleTalk");
  }
});

speakingToggle.addEventListener("change", () => {
  send("panel.setSpeaking", { enabled: speakingToggle.checked });
});

settingsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

sessionSelect?.addEventListener("change", () => {
  send("panel.setSessionKey", { sessionKey: sessionSelect.value });
});

sessionDelete?.addEventListener("click", () => {
  const key = sessionSelect?.value || "";
  if (!key || key === "main") return;

  const ok = confirm("Are you sure?");
  if (!ok) return;

  sessionDelete.disabled = true;
  chrome.runtime.sendMessage({ type: "panel.deleteSession", payload: { key } }, (res) => {
    // service_worker will broadcast updated state
    sessionDelete.disabled = false;
    if (res && res.ok) {
      // nothing else
    } else if (res && res.error) {
      // show error in logs
      send("panel.logError", { message: res.error });
    }
  });
});

function submitChatInput() {
  const text = String(chatInput?.value || "").trim();
  if (!text) return;

  // Optimistic clear.
  if (chatInput) chatInput.value = "";

  chrome.runtime.sendMessage({ type: "panel.sendTextPrompt", payload: { text } }, (res) => {
    if (res && res.ok) return;
    const error = res?.error || "Failed to send.";
    send("panel.logError", { message: error });
  });
}

chatSend?.addEventListener("click", submitChatInput);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitChatInput();
  }
});

function shouldRefreshSessions() {
  const now = Date.now();
  // Every 30s max.
  return now - lastSessionsRefreshAtMs > 30000;
}

function refreshSessions() {
  if (!lastState?.gatewayConnected) return;
  if (sessionsRefreshInFlight) return;
  if (!shouldRefreshSessions()) return;

  sessionsRefreshInFlight = true;
  lastSessionsRefreshAtMs = Date.now();

  chrome.runtime.sendMessage({ type: "panel.listSessions" }, () => {
    // service_worker will broadcast state; we should NOT call requestState() here
    // or we can create a tight loop.
    sessionsRefreshInFlight = false;
  });
}

requestState();
