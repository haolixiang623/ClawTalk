import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(
  path.join(__dirname, "..", "shared", "gateway-settings.mjs"),
).href;

async function importGatewaySettings() {
  return import(`${moduleUrl}?t=${Date.now()}`);
}

test.describe("Gateway settings persistence", () => {
  test("keeps the paired device token when gateway auth settings stay the same", async () => {
    const module = await importGatewaySettings();

    const result = module.mergeSettingsForSave(
      {
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "token-a",
        deviceToken: "paired-device-token",
      },
      {
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "token-a",
        sessionKey: "main",
      },
    );

    expect(result.deviceToken).toBe("paired-device-token");
  });

  test("clears the paired device token when the gateway URL changes", async () => {
    const module = await importGatewaySettings();

    const result = module.mergeSettingsForSave(
      {
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "token-a",
        deviceToken: "paired-device-token",
      },
      {
        gatewayUrl: "wss://gateway.example.com",
        gatewayToken: "token-a",
      },
    );

    expect(result.deviceToken).toBe("");
  });

  test("clears the paired device token when the gateway token changes", async () => {
    const module = await importGatewaySettings();

    const result = module.mergeSettingsForSave(
      {
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "token-a",
        deviceToken: "paired-device-token",
      },
      {
        gatewayUrl: "ws://127.0.0.1:18789",
        gatewayToken: "token-b",
      },
    );

    expect(result.deviceToken).toBe("");
  });
});
