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
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;

      this.ws = new WebSocket(this.url);

      this.ws.addEventListener("open", () => {
        this.onState?.("socket_open", { url: this.url });
      });

      this.ws.addEventListener("message", (event) => {
        this.handleMessage(event.data, () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });

      this.ws.addEventListener("close", (event) => {
        this.connected = false;

        const detail = {
          url: this.url,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean
        };

        this.onState?.("socket_closed", detail);

        // If the socket closes before we complete the connect handshake,
        // reject so the caller can log a meaningful error and retry.
        if (!settled && !this.connected) {
          settled = true;
          reject(new Error(`WebSocket closed before connect.ok (code=${event.code}, reason=${event.reason || "<none>"})`));
        }
      });

      this.ws.addEventListener("error", () => {
        this.onState?.("socket_error", { url: this.url });
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

    return this.send("chat.send", {
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
      this.sendConnect(challenge);
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

  sendConnect(_challenge) {
    const auth = this.deviceToken ? { deviceToken: this.deviceToken } : { token: this.token };

    // NOTE: Gateway is strict about connect params. Keep this minimal and schema-compliant.
    // connect.params: { minProtocol, maxProtocol, client, caps, auth?, locale?, userAgent? }
    // Do NOT include role/scopes/challenge/etc.
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        // Use a known/expected client id.
        id: "webchat",
        version: "0.1.55",
        platform: "chrome",
        mode: "webchat"
      },
      // caps must exist even when empty.
      caps: [],
      auth,
      locale: navigator?.language || "en-US",
      userAgent: navigator?.userAgent || "chrome-extension"
    };

    this.send("connect", params);
  }
}
