import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayClientPath = path.join(__dirname, "..", "shared", "gateway_client.js");

test.describe("Gateway client device auth", () => {
  test("includes signed device metadata during connect", async () => {
    const content = fs.readFileSync(gatewayClientPath, "utf8");

    expect(content).toContain("createConnectDeviceProof");
    expect(content).toContain("const device = await createConnectDeviceProof");
    expect(content).toContain("connectNonce");
  });
});
