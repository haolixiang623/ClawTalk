import { expect, test } from "@playwright/test";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(
  path.join(__dirname, "..", "shared", "gateway-probe.mjs"),
).href;

async function importGatewayProbe() {
  return import(`${moduleUrl}?t=${Date.now()}`);
}

test.describe("Gateway probe", () => {
  test("reports pairing-required as a failed connection test", async () => {
    const module = await importGatewayProbe();

    const result = await module.probeGatewayConnection({
      url: "ws://127.0.0.1:18789",
      token: "token-a",
      deviceToken: "",
      createClient: ({ onState }) => ({
        async connect() {
          onState("socket_open", { url: "ws://127.0.0.1:18789" });
          onState("pairing_required", { requestId: "req-123", reason: "not-paired" });
          throw new Error("pairing required");
        },
        close() {},
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("pairing_required");
    expect(result.hint).toContain("req-123");
  });

  test("surfaces diagnostic hints for failed handshake probes", async () => {
    const module = await importGatewayProbe();

    const result = await module.probeGatewayConnection({
      url: "ws://127.0.0.1:18789",
      token: "token-a",
      deviceToken: "",
      createClient: ({ onState }) => ({
        async connect() {
          onState("socket_diagnostic", { hint: "Gateway token mismatch." });
          throw new Error("connect failed");
        },
        close() {},
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("connect_failed");
    expect(result.hint).toContain("Gateway token mismatch");
  });

  test("only reports success after the authenticated connect flow resolves", async () => {
    const module = await importGatewayProbe();

    const result = await module.probeGatewayConnection({
      url: "ws://127.0.0.1:18789",
      token: "token-a",
      deviceToken: "",
      createClient: ({ onState }) => ({
        async connect() {
          onState("socket_open", { url: "ws://127.0.0.1:18789" });
          onState("device_token_issued", { deviceToken: "device-token-1" });
        },
        close() {},
      }),
    });

    expect(result.success).toBe(true);
    expect(result.deviceToken).toBe("device-token-1");
  });
});
