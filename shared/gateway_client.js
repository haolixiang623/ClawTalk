import { createConnectDeviceProof } from "./device-identity.mjs";

export class GatewayClient {
  constructor({ url, token, deviceToken, debugEvents, onEvent, onState }) {
    this.url = url;
    this.token = token;
    this.deviceToken = deviceToken;
    this.debugEvents = debugEvents;
    this.onEvent = onEvent;
    this.onState = onState;
    this.ws = null;
    this.nextId = 1;
    this.connected = false;
    this.pending = new Map(); // id -> { resolve, reject, timeoutId }
    this._connectionStartTime = 0;
  }

  /**
   * Test if we can reach the host without establishing a full WebSocket connection.
   * Returns { ok, error } where error may include permission hints.
   */
  async diagnoseConnection() {
    const urlObj = new URL(this.url);
    const host = urlObj.host;
    const port = urlObj.port || (urlObj.protocol === "wss:" ? "443" : "80");

    return new Promise((resolve) => {
      // Attempt a quick fetch to see if the host is reachable.
      // This works for HTTP servers; for pure WebSocket servers it may fail but helps diagnose.
      const testUrl = `${urlObj.protocol === "wss:" ? "https" : "http"}://${host}/`;
      fetch(testUrl, { method: "HEAD", mode: "no-cors", cache: "no-store" })
        .then(() => resolve({ ok: true }))
        .catch((fetchErr) => {
          // Distinguish permission errors from network errors.
          const msg = fetchErr.message || "";
          if (msg.includes("Permission denied") || msg.includes("No permission") || msg.includes("Extension context")) {
            resolve({
              ok: false,
              error: "permission_denied",
              hint: `Extension does not have permission to connect to ${this.url}. Please add this origin in the extension settings.`
            });
          } else if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("net::")) {
            resolve({
              ok: false,
              error: "network_unreachable",
              hint: `Cannot reach ${host}:${port}. Check if the server is running and accessible.`
            });
          } else {
            resolve({ ok: false, error: "unknown", hint: msg });
          }
        });
    });
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      this._connectionStartTime = Date.now();

      // Provide diagnostic callback for permission issues.
      const provideDiagnostics = (errorHint) => {
        this.onState?.("socket_diagnostic", { url: this.url, hint: errorHint });
      };

      this.ws = new WebSocket(this.url);

      // Track when open completes to detect slow connections.
      const openTimeout = setTimeout(() => {
        if (!this.connected) {
          provideDiagnostics("Connection is taking longer than expected. Check your network or firewall settings.");
        }
      }, 5000);

      this.ws.addEventListener("open", () => {
        clearTimeout(openTimeout);
        this.onState?.("socket_open", { url: this.url });
      });

      this.ws.addEventListener("message", (event) => {
        this.handleMessage(event.data, () => {
          if (!settled) {
            settled = true;
            const elapsed = Date.now() - this._connectionStartTime;
            this.onState?.("socket_connected", { url: this.url, elapsedMs: elapsed });
            resolve();
          }
        });
      });

      this.ws.addEventListener("close", (event) => {
        clearTimeout(openTimeout);
        this.connected = false;

        const detail = {
          url: this.url,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean
        };

        this.onState?.("socket_closed", detail);

        // Provide helpful hints for common close codes.
        let hint = null;
        if (event.code === 1006) {
          hint = "Connection closed abnormally (code 1006). This usually means:\n" +
                 "1. The lobster service on the server is not running or has crashed\n" +
                 "2. The extension does not have permission to connect to this origin\n" +
                 "3. A firewall or proxy is blocking WebSocket connections\n\n" +
                 "Try: Check if the lobster service is running on the server, or go to Settings > Gateway URL and save to grant permissions.";
        } else if (event.code === 1008) {
          hint = "Connection rejected by server (code 1008). Check your token or server configuration.";
        } else if (event.code === 1001) {
          hint = "Server is going away. The gateway may have been shut down.";
        } else if (event.code === 1011) {
          hint = "Server encountered an unexpected condition. Check server logs.";
        }

        if (hint) {
          provideDiagnostics(hint);
        }

        // If the socket closes before we complete the connect handshake,
        // reject so the caller can log a meaningful error and retry.
        if (!settled && !this.connected) {
          settled = true;
          const errorMsg = hint
            ? `WebSocket closed before connect.ok (code=${event.code}, reason=${event.reason || "<none>"})\n\nHint: ${hint}`
            : `WebSocket closed before connect.ok (code=${event.code}, reason=${event.reason || "<none>"})`;
          reject(new Error(errorMsg));
        }
      });

      this.ws.addEventListener("error", () => {
        const elapsed = Date.now() - this._connectionStartTime;
        // Chrome extensions often surface network errors as generic "WebSocket error".
        // Provide a contextual hint if it happened quickly (likely permission).
        if (elapsed < 500) {
          provideDiagnostics(
            "WebSocket error occurred immediately (likely permission denied).\n" +
            `Extension must have permission to access: ${this.url}\n\n` +
            "Go to extension Settings > Gateway URL and save to request permission."
          );
        } else {
          provideDiagnostics(
            `WebSocket error after ${elapsed}ms. Server may be unreachable or rejected the connection.`
          );
        }

        this.onState?.("socket_error", { url: this.url, elapsedMs: elapsed });
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket error"));
        }
      });
    });
  }

  close() {
    // Reject any pending requests.
    for (const [, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("WebSocket closed"));
    }
    this.pending.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(method, params) {
    const id = String((this.nextId += 1));
    // OpenClaw Gateway expects explicit frame types.
    // Requests: {type:"req", id:"…", method:"…", params:{…}}
    const payload = { type: "req", id, method, params };
    this.ws?.send(JSON.stringify(payload));
    return id;
  }

  request(method, params, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = this.send(method, params);
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
    });
  }

  sendChat(text, sessionKey = "main") {
    // The Gateway requires strict chat.send params.
    // See control-ui: chat.send { sessionKey, message, idempotencyKey, deliver? }
    const idempotencyKey = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
      ? globalThis.crypto.randomUUID()
      : String(Date.now()) + "-" + Math.random().toString(16).slice(2);

    return this.request("chat.send", {
      sessionKey,
      message: String(text || ""),
      idempotencyKey,
      // We receive assistant replies via gateway events, not via direct deliver.
      deliver: false
    });
  }

  handleMessage(raw, connectResolve) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      return;
    }

    const eventName = message.event || message.method;
    const frameType = message.type;

    if ((eventName || frameType) && this.debugEvents) {
      this.onEvent?.({ type: "debug", name: eventName || frameType });
    }

    if (eventName === "connect.challenge") {
      // Gateway sends the challenge in the event payload (e.g. {nonce, ts}).
      // Accept a few possible shapes for compatibility.
      const challenge =
        message.data?.challenge ||
        message.params?.challenge ||
        message.payload ||
        message.challenge;
      this.sendConnect(challenge).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.onState?.("socket_diagnostic", {
          url: this.url,
          hint: `Device auth setup failed: ${message}`,
        });
        this.ws?.close(1008, "device auth setup failed");
      });
      return;
    }

    if (frameType === "res") {
      const pending = this.pending.get(String(message.id));
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pending.delete(String(message.id));
        pending.resolve(message);
      }

      // Connect response is a "res" frame with payload {type:"hello-ok", protocol:3, ...}
      if (message.ok && message.payload?.type === "hello-ok") {
        this.connected = true;
        const issuedDeviceToken = message.payload?.auth?.deviceToken;
        if (issuedDeviceToken) {
          this.onState?.("device_token_issued", {
            deviceToken: issuedDeviceToken,
            role: message.payload?.auth?.role,
            scopes: message.payload?.auth?.scopes,
          });
        }
        connectResolve?.();
        return;
      }
    }

    if (frameType === "event" && eventName) {
      // Different gateway builds use different fields (payload/data/params).
      const eventPayload = message.payload ?? message.data ?? message.params ?? message;
      this.onEvent?.({ type: "event", name: eventName, payload: eventPayload });
      return;
    }

    // Fallback: emit whatever we got.
    this.onEvent?.({ type: "event", name: eventName || frameType || "message", payload: message });
  }

  async sendConnect(challenge) {
    const auth = this.deviceToken ? { deviceToken: this.deviceToken } : { token: this.token };
    const role = "operator";
    const scopes = ["operator.read", "operator.write"];
    const client = {
      // Use a known/expected client id.
      id: "webchat",
      version: "0.1.56",
      platform: "chrome",
      mode: "webchat"
    };
    const signatureToken = auth.deviceToken || auth.token || null;
    const connectNonce =
      challenge?.nonce ||
      challenge?.payload?.nonce ||
      challenge?.data?.nonce ||
      null;
    const device = await createConnectDeviceProof({
      client,
      role,
      scopes,
      authToken: signatureToken,
      connectNonce,
    });

    // NOTE: Gateway is strict about connect params. Keep this minimal and schema-compliant.
    // chat.send requires operator.write, and the Gateway only preserves scopes for
    // browser clients that prove a stable device identity during connect.
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client,
      role,
      scopes,
      device,
      // caps must exist even when empty.
      caps: [],
      auth,
      locale: navigator?.language || "en-US",
      userAgent: navigator?.userAgent || "chrome-extension"
    };

    const response = await this.request("connect", params, { timeoutMs: 10000 });
    if (!response?.ok) {
      const details = response?.error?.details || {};
      if (details.code === "PAIRING_REQUIRED") {
        this.onState?.("pairing_required", {
          requestId: details.requestId,
          reason: details.reason,
        });
      }

      const error = new Error(response?.error?.message || "Gateway connect failed.");
      error.gatewayCode = response?.error?.code;
      error.gatewayDetails = details;
      throw error;
    }
    return response;
  }
}
