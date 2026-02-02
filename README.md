# ClawTalk (Chrome Extension)

A small Chrome side panel that turns **OpenClaw Gateway** into a lightweight “talk to my assistant” experience.

The idea is simple: keep a panel open, press **Talk**, speak naturally, and get the assistant’s reply back—optionally spoken aloud. It’s meant to feel closer to a walkie‑talkie / hands‑free voice loop than a traditional chat tab.

## Why this exists

I wanted something that:

- lives **inside the browser** (no extra desktop app)
- works with an existing OpenClaw deployment (local or remote)
- doesn’t require keeping a heavy UI open
- is resilient (no reconnect storms, bounded memory, minimal protocol params)

In practice it’s a “voice remote control” for an OpenClaw session: you can reuse the context you already have in your webchat / Control UI by pointing the extension at the same session key.

## What it does

- Connects to an OpenClaw Gateway over WebSocket.
- Sends your utterances via `chat.send` to a chosen `sessionKey`.
- Streams assistant replies into the **CHAT** panel.
- (Optional) Speaks assistant replies using TTS.

## Features

- **Side panel UI** (MV3) with Connect / Talk controls, status (“Idle”, “Listening”, “Thinking”, “Speaking”).
- **Text chat input** under CHAT (type + Enter/Send).
- **Speech loop**:
  - VAD-based hands‑free mode
  - push‑to‑talk mode (hold Talk to speak)
- **TTS providers**:
  - Default: browser `SpeechSynthesis`
  - Optional: **ElevenLabs** (selectable in Settings)
- **Safety/robustness**:
  - minimal, schema‑compliant gateway connect params
  - circuit breaker for policy violations (prevents infinite reconnect loops)
  - bounded in‑memory buffers to avoid Chrome performance degradation
- **Debug controls** (fine-grained) to keep logs useful without spamming.

## Installation (developer mode)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the repository folder (`ClawTalk/`)

Then open the side panel:
- click the extension icon → open **Side panel** (or from the Extensions menu)

## Configuration

Open **Settings** from the side panel.

### Gateway

- **Gateway URL**
  - default: `ws://127.0.0.1:18789`
- **Gateway Token (or Device Token)**
  - stored in `chrome.storage.local`
  - not printed in logs
- **Gateway Headers (optional)**
  - useful for upstream auth (e.g. Cloudflare Access)

### Session

- **Session key**
  - default: `main`
  - use the same key you use in OpenClaw webchat/Control UI if you want shared context

### Speech

- **Language (STT default)**
  - used as the default language hint

### Text-to-speech

- **Provider**
  - `Default (SpeechSynthesis)` → no external requests
  - `ElevenLabs` → requires API key + Voice ID

There’s also a **Test speech** button in Settings to validate TTS without starting the Talk loop.

## How to use

1. Press **Connect**
2. Press **Talk**
3. Speak, then pause
4. The transcript is sent to the gateway (`chat.send`)
5. The assistant reply appears in CHAT
6. If **Speaking** is enabled, the reply is spoken

Tip: if you disable **Speaking** while audio is playing, playback should stop immediately.

## Permissions (what/why)

- `microphone` — capture speech for the Talk loop
- `storage` — persist settings
- `offscreen` — background audio capture/playback
- `sidePanel` — host the UI in the side panel
- `declarativeNetRequest` — apply configured headers to gateway requests
- `notifications` (optional) — reserved for future user-visible errors

Host permissions:
- default: `ws://127.0.0.1:18789/*`
- ElevenLabs: `https://api.elevenlabs.io/*`

Remote gateways:
- the origin of **Gateway URL** is always included automatically
- add any extra origins to **Settings → Additional Gateway permissions**
- Chrome will prompt you to grant the requested origins

## Project layout

```
manifest.json
service_worker.js          # background + gateway client + state machine
sidepanel.html/.js/.css    # UI
options.html/.js           # settings
offscreen.html/.js         # audio playback + TTS engine
icons/                     # extension icons
shared/
  gateway_client.js
  state.js
  stt.js
  tts.js
  vad.js
```

## Notes / limitations

- This repo focuses on a practical “voice loop” UX, not on being a full chat client.
- TTS quality depends on the selected provider and your system voices.
- ElevenLabs usage depends on your plan/voice type (some voices require a paid plan).

## Contributing

Issues and PRs are welcome. If you change behavior or UI, please include a short note in the PR describing how to test it.
