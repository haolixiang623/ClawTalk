const DEVICE_IDENTITY_STORAGE_KEY = "gatewayDeviceIdentityV1";
const TEXT_ENCODER = new TextEncoder();

function getSubtleCrypto(subtle) {
  const resolved = subtle || globalThis.crypto?.subtle;
  if (!resolved) {
    throw new Error("WebCrypto is unavailable; device identity requires a secure context.");
  }
  return resolved;
}

function normalizeDeviceMetadataForAuth(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function bufferToUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("Expected ArrayBuffer-compatible data.");
}

function base64UrlEncode(value) {
  const bytes = bufferToUint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hexEncode(value) {
  return Array.from(bufferToUint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStoredDeviceIdentity(value) {
  return (
    isPlainObject(value) &&
    value.version === 1 &&
    value.algorithm === "Ed25519" &&
    typeof value.deviceId === "string" &&
    typeof value.publicKeyRaw === "string" &&
    isPlainObject(value.privateKeyJwk)
  );
}

function getDefaultStorageAdapter() {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage?.get || !storage?.set) return null;

  return {
    async get(key) {
      const result = await storage.get({ [key]: null });
      return result?.[key] ?? null;
    },
    async set(key, value) {
      await storage.set({ [key]: value });
    },
  };
}

export function buildDeviceAuthPayloadV3(params) {
  const scopes = Array.isArray(params.scopes) ? params.scopes.join(",") : "";
  const token = params.token ?? "";

  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily),
  ].join("|");
}

export async function deriveDeviceIdFromPublicKeyRaw(publicKeyRaw, { subtle } = {}) {
  const resolvedSubtle = getSubtleCrypto(subtle);
  const publicKeyBytes = typeof publicKeyRaw === "string"
    ? base64UrlDecode(publicKeyRaw)
    : bufferToUint8Array(publicKeyRaw);
  const digest = await resolvedSubtle.digest("SHA-256", publicKeyBytes);
  return hexEncode(digest);
}

export async function createDeviceIdentityRecord({ subtle } = {}) {
  const resolvedSubtle = getSubtleCrypto(subtle);

  let keyPair;
  try {
    keyPair = await resolvedSubtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to generate Ed25519 device identity: ${message}`);
  }

  const publicKeyRaw = await resolvedSubtle.exportKey("raw", keyPair.publicKey);
  const privateKeyJwk = await resolvedSubtle.exportKey("jwk", keyPair.privateKey);
  const deviceId = await deriveDeviceIdFromPublicKeyRaw(publicKeyRaw, {
    subtle: resolvedSubtle,
  });

  return {
    version: 1,
    algorithm: "Ed25519",
    deviceId,
    publicKeyRaw: base64UrlEncode(publicKeyRaw),
    privateKeyJwk,
  };
}

export async function loadOrCreateDeviceIdentity({
  storage = getDefaultStorageAdapter(),
  subtle,
} = {}) {
  const resolvedSubtle = getSubtleCrypto(subtle);
  if (!storage?.get || !storage?.set) {
    throw new Error("Extension storage is unavailable; cannot persist device identity.");
  }

  const existing = await storage.get(DEVICE_IDENTITY_STORAGE_KEY);
  if (isStoredDeviceIdentity(existing)) {
    const derivedId = await deriveDeviceIdFromPublicKeyRaw(existing.publicKeyRaw, {
      subtle: resolvedSubtle,
    });

    if (derivedId === existing.deviceId) {
      return existing;
    }

    const migrated = {
      ...existing,
      deviceId: derivedId,
    };
    await storage.set(DEVICE_IDENTITY_STORAGE_KEY, migrated);
    return migrated;
  }

  const identity = await createDeviceIdentityRecord({ subtle: resolvedSubtle });
  await storage.set(DEVICE_IDENTITY_STORAGE_KEY, identity);
  return identity;
}

export async function signDevicePayload(privateKeyJwk, payload, { subtle } = {}) {
  const resolvedSubtle = getSubtleCrypto(subtle);
  const privateKey = await resolvedSubtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await resolvedSubtle.sign(
    "Ed25519",
    privateKey,
    TEXT_ENCODER.encode(String(payload)),
  );
  return base64UrlEncode(signature);
}

export async function createConnectDeviceProof({
  identity,
  client,
  role,
  scopes,
  authToken,
  connectNonce,
  signedAtMs = Date.now(),
  subtle,
  storage,
}) {
  const resolvedIdentity = identity || await loadOrCreateDeviceIdentity({ storage, subtle });
  const nonce = typeof connectNonce === "string" ? connectNonce.trim() : "";
  if (!nonce) {
    throw new Error("Gateway connect challenge missing nonce.");
  }

  const payload = buildDeviceAuthPayloadV3({
    deviceId: resolvedIdentity.deviceId,
    clientId: client.id,
    clientMode: client.mode,
    role,
    scopes,
    signedAtMs,
    token: authToken ?? "",
    nonce,
    platform: client.platform,
    deviceFamily: client.deviceFamily,
  });

  const signature = await signDevicePayload(resolvedIdentity.privateKeyJwk, payload, {
    subtle,
  });

  return {
    id: resolvedIdentity.deviceId,
    publicKey: resolvedIdentity.publicKeyRaw,
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}
