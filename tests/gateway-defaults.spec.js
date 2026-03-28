import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayDefaultsModuleUrl = pathToFileURL(
  path.join(__dirname, "..", "shared", "gateway-defaults.mjs"),
).href;

async function importGatewayDefaults() {
  return import(`${gatewayDefaultsModuleUrl}?t=${Date.now()}`);
}

test.describe("Gateway defaults", () => {
  test("prefers the local OpenClaw gateway and ships without a bundled token", async () => {
    const module = await importGatewayDefaults();

    expect(module.LOCAL_GATEWAY_URL).toBe("ws://127.0.0.1:18789");
    expect(module.DEFAULT_GATEWAY_TOKEN).toBe("");
    expect(module.LEGACY_REMOTE_GATEWAY_URL).toBe("ws://180.76.244.18:18789");
    expect(module.LEGACY_REMOTE_GATEWAY_TOKEN).toBe(
      "ETA7CNNm080PRdPyQHsVAGctSl7Dy1hzO3MufGJ3ntA",
    );
  });

  test("migrates the legacy bundled remote gateway settings back to local defaults", async () => {
    const module = await importGatewayDefaults();

    const result = module.migrateLegacyGatewaySettings({
      gatewayUrl: module.LEGACY_REMOTE_GATEWAY_URL,
      gatewayToken: module.LEGACY_REMOTE_GATEWAY_TOKEN,
      deviceToken: "stale-device-token",
      gatewayHeaders: [],
      dryRun: false,
    });

    expect(result.didMigrate).toBe(true);
    expect(result.settings.gatewayUrl).toBe(module.LOCAL_GATEWAY_URL);
    expect(result.settings.gatewayToken).toBe(module.DEFAULT_GATEWAY_TOKEN);
    expect(result.settings.deviceToken).toBe("");
  });

  test("preserves user-specified remote gateway settings", async () => {
    const module = await importGatewayDefaults();

    const result = module.migrateLegacyGatewaySettings({
      gatewayUrl: "wss://gateway.example.com",
      gatewayToken: "custom-token",
      gatewayHeaders: [{ name: "x-test", value: "1" }],
    });

    expect(result.didMigrate).toBe(false);
    expect(result.settings.gatewayUrl).toBe("wss://gateway.example.com");
    expect(result.settings.gatewayToken).toBe("custom-token");
    expect(result.settings.gatewayHeaders).toEqual([{ name: "x-test", value: "1" }]);
  });
});
