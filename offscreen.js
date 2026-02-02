import { createTtsController } from "./shared/tts.js";
import { DEFAULT_SETTINGS } from "./shared/state.js";

let settings = { ...DEFAULT_SETTINGS };
let ttsController;
let isPlaying = false;

function sendMessage(type, payload) {
  chrome.runtime.sendMessage({ type, payload });
}

function ensureTts() {
  if (!ttsController) {
    ttsController = createTtsController(settings);
  }
}

function stopPlayback() {
  isPlaying = false;
  ttsController?.stop();
}

async function playTts(text, requestId) {
  ensureTts();
  isPlaying = true;
  try {
    await ttsController.speak(text);
    sendMessage("tts.complete", { requestId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendMessage("tts.error", { requestId, error: msg });
  } finally {
    isPlaying = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "offscreen.playTts") {
    const text = message.payload?.text;
    const requestId = message.payload?.requestId;
    playTts(text, requestId);
    return;
  }

  if (message.type === "offscreen.stopTts") {
    stopPlayback();
    return;
  }

  if (message.type === "offscreen.updateSettings") {
    settings = { ...settings, ...message.payload };
    ttsController?.updateSettings(settings);
    return;
  }

  if (message.type === "offscreen.ping") {
    sendResponse?.({ ok: true, isPlaying });
    return;
  }
});
