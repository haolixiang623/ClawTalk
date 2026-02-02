# Security notes

This extension is a thin client: it does not run a server, but it does handle **microphone access** and **Gateway credentials**. This file documents what is stored, what is sent over the network, and what you should do to keep a setup safe.

## Credentials / tokens

- Gateway tokens (or device tokens) are stored in **Chrome extension local storage** (`chrome.storage.local`).
- Tokens are not intentionally printed in logs.
- If you are using a remote gateway, treat the token like a password.

### Recommended scopes (least privilege)

Use the smallest scope set that still allows the talk loop to work. In practice:

- `operator.read`
- `operator.write`

These are sufficient for `chat.send` and receiving chat events.

## Microphone

- The extension requests `microphone` permission because Talk mode captures audio.
- Audio is processed locally for VAD / STT integration.

## Network / data flow

- The extension connects to an OpenClaw Gateway via WebSocket.
- Transcripts are sent to the gateway as chat messages.

### Optional: ElevenLabs

If you select **ElevenLabs** as the TTS provider:

- The text of assistant replies is sent to ElevenLabs to synthesize speech.
- The ElevenLabs API key and voice ID are stored locally in extension storage.

If you do not want any third-party requests, keep the TTS provider set to **Default (SpeechSynthesis)**.

## Host permissions

- Default host permission is `ws://127.0.0.1:18789/*` (local gateway).
- If you configure a different Gateway URL, the extension may request permission for that specific origin.
- ElevenLabs requests require `https://api.elevenlabs.io/*`.

## Reporting

If you find a security issue, please open a GitHub issue with a minimal reproduction.
If the issue involves a leaked token or sensitive data, avoid posting the secret in the issue—describe the steps and redact credentials.
