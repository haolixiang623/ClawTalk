export const LOCAL_GATEWAY_URL = "ws://127.0.0.1:18789";
export const DEFAULT_GATEWAY_TOKEN = "";

export const LEGACY_REMOTE_GATEWAY_URL = "ws://180.76.244.18:18789";
export const LEGACY_REMOTE_GATEWAY_TOKEN =
  "ETA7CNNm080PRdPyQHsVAGctSl7Dy1hzO3MufGJ3ntA";

export const DEFAULT_GATEWAY_SETTINGS = Object.freeze({
  gatewayUrl: LOCAL_GATEWAY_URL,
  gatewayToken: DEFAULT_GATEWAY_TOKEN,
});

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isLoopbackGatewayUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export function migrateLegacyGatewaySettings(rawSettings = {}) {
  const settings = { ...rawSettings };
  const gatewayUrl = normalizeString(settings.gatewayUrl);
  const gatewayToken = normalizeString(settings.gatewayToken);

  const matchesLegacyBundledDefaults =
    gatewayUrl === LEGACY_REMOTE_GATEWAY_URL &&
    gatewayToken === LEGACY_REMOTE_GATEWAY_TOKEN;

  if (!matchesLegacyBundledDefaults) {
    return { didMigrate: false, settings };
  }

  return {
    didMigrate: true,
    settings: {
      ...settings,
      ...DEFAULT_GATEWAY_SETTINGS,
      deviceToken: "",
    },
  };
}
