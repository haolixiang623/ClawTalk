import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayClientPath = path.join(__dirname, "..", "shared", "gateway_client.js");

test.describe("Gateway connect payload", () => {
  test("requests operator read/write scopes so chat.send is authorized", async () => {
    const content = fs.readFileSync(gatewayClientPath, "utf8");

    expect(content).toContain('const role = "operator"');
    expect(content).toContain('"operator.read"');
    expect(content).toContain('"operator.write"');
  });
});
