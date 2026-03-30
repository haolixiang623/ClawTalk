import { DEFAULT_GATEWAY_SETTINGS } from "./gateway-defaults.mjs";

export const TalkState = Object.freeze({
  DISCONNECTED: "disconnected",
  IDLE: "idle",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking",
  ERROR: "error"
});

export const DEFAULT_SETTINGS = Object.freeze({
  gatewayUrl: DEFAULT_GATEWAY_SETTINGS.gatewayUrl,
  gatewayToken: DEFAULT_GATEWAY_SETTINGS.gatewayToken,
  // Persisted after the first successful paired connect.
  deviceToken: "",
  gatewayHeaders: [],
  // Gateway permission model:
  // - gatewayUrl origin is always included automatically.
  // - gatewayAdditionalOrigins are extra ws/wss origins (match patterns) the user may add.
  gatewayAdditionalOrigins: [],
  dryRun: false,

  // Session routing
  // Which OpenClaw sessionKey to use for chat.send.
  sessionKey: "main",

  // Session history
  // Load recent messages from chat.history when connecting / switching sessions.
  loadSessionHistory: false,  // 禁用以避免权限错误
  // How many messages to request from chat.history.
  sessionHistoryLimit: 200,

  // Retention
  // How many log entries to keep in the sidepanel.
  maxLogEntries: 100,
  // How many assistant replies to keep in the CHAT window.
  maxChatMessages: 20,

  // Event log settings
  // Master switches gate the sub-options (sub-options are ignored when master is OFF).
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
  // If set, forces getUserMedia() to use a specific audio input device.
  // Empty string => default system microphone.
  inputDeviceId: "",
  // If enabled, assistant replies will be spoken via TTS.
  // If disabled, replies are only written to the log.
  speakingEnabled: false,
  // If enabled, Talk button becomes push-to-talk (hold to speak, release to send).
  // If disabled, Talk uses hands-free VAD loop.
  pushToTalk: false,
  // TTS provider
  // Which TTS backend to use.
  ttsProvider: "default", // "default" | "elevenlabs"
  elevenlabsKey: "",
  elevenlabsVoice: "",
  vad: {
    threshold: 0.02,
    hangoverMs: 700,
    minSpeechMs: 250
  }
});

export function buildState(settings) {
  return {
    // Gateway connection state is separate from the talk loop.
    gatewayConnected: false,
    connectEnabled: false,

    // Talk loop (mic/STT -> gateway -> reply) state.
    status: TalkState.DISCONNECTED,
    talkEnabled: false,
    demoPreReviewRunning: false,

    // Output mode.
    speakingEnabled: Boolean(settings.speakingEnabled),

    // Input mode.
    pushToTalk: Boolean(settings.pushToTalk),

    // Logging (exposed mainly for UI/debug).
    logDebug: Boolean(settings.logDebug),
    logDebugGatewayEventNames: Boolean(settings.logDebugGatewayEventNames),
    logDebugGatewayHeartbeats: Boolean(settings.logDebugGatewayHeartbeats),
    logDebugTranscriptText: Boolean(settings.logDebugTranscriptText),
    logDebugGatewayResPayload: Boolean(settings.logDebugGatewayResPayload),

    logInfo: Boolean(settings.logInfo),
    logInfoConnect: Boolean(settings.logInfoConnect),
    logInfoAssistant: Boolean(settings.logInfoAssistant),
    logInfoSpeech: Boolean(settings.logInfoSpeech),

    // Audio/STT config needed by sidepanel runtime.
    sttLang: settings.sttLang,
    inputDeviceId: settings.inputDeviceId,
    vad: settings.vad,

    // Session routing.
    sessionKey: settings.sessionKey,
    sessions: [],

    // Session history.
    loadSessionHistory: settings.loadSessionHistory !== false,
    sessionHistoryLimit: settings.sessionHistoryLimit,

    // Retention (also shown in UI).
    maxLogEntries: settings.maxLogEntries,
    maxChatMessages: settings.maxChatMessages,

    gatewayUrl: settings.gatewayUrl,
    dryRun: settings.dryRun,
    logs: [],
    chat: []
  };
}
