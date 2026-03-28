import { expect, test } from "@playwright/test";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deviceIdentityModulePath = path.join(__dirname, "..", "shared", "device-identity.mjs");

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeBase64Url(input) {
  const normalized = String(input).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64");
}

function createMemoryStorage() {
  const store = new Map();

  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

test.describe("Extension device identity", () => {
  test("persists a stable device identity across loads", async () => {
    const {
      loadOrCreateDeviceIdentity,
    } = await import(pathToFileURL(deviceIdentityModulePath).href);
    const storage = createMemoryStorage();

    const first = await loadOrCreateDeviceIdentity({
      storage,
      subtle: crypto.webcrypto.subtle,
    });
    const second = await loadOrCreateDeviceIdentity({
      storage,
      subtle: crypto.webcrypto.subtle,
    });

    expect(first.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
  });

  test("signs the v3 connect payload with the stored Ed25519 device key", async () => {
    const {
      buildDeviceAuthPayloadV3,
      createConnectDeviceProof,
      createDeviceIdentityRecord,
    } = await import(pathToFileURL(deviceIdentityModulePath).href);
    const identity = await createDeviceIdentityRecord({
      subtle: crypto.webcrypto.subtle,
    });
    const connectNonce = "nonce-123";
    const signedAtMs = 1774494634768;
    const client = {
      id: "webchat",
      mode: "webchat",
      platform: "chrome",
    };
    const scopes = ["operator.read", "operator.write"];

    const device = await createConnectDeviceProof({
      identity,
      client,
      role: "operator",
      scopes,
      authToken: "gateway-token",
      connectNonce,
      signedAtMs,
      subtle: crypto.webcrypto.subtle,
    });

    expect(device).toEqual({
      id: identity.deviceId,
      publicKey: identity.publicKeyRaw,
      signature: expect.any(String),
      signedAt: signedAtMs,
      nonce: connectNonce,
    });

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role: "operator",
      scopes,
      signedAtMs,
      token: "gateway-token",
      nonce: connectNonce,
      platform: client.platform,
      deviceFamily: "",
    });

    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        ED25519_SPKI_PREFIX,
        decodeBase64Url(device.publicKey),
      ]),
      type: "spki",
      format: "der",
    });

    const verified = crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      decodeBase64Url(device.signature),
    );

    expect(verified).toBe(true);
  });
});
