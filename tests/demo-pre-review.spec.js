import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(
  path.join(__dirname, "..", "shared", "demo-pre-review.mjs"),
).href;

async function importDemoModule() {
  return import(`${moduleUrl}?t=${Date.now()}`);
}

test.describe("Demo pre-review flow helpers", () => {
  test("builds a fixed prompt with extracted case and attachment data", async () => {
    const module = await importDemoModule();

    const prompt = module.buildDemoPreReviewPrompt({
      caseTitle: "示例待预审办件",
      caseNumber: "CASE-2026-0001",
      detailUrl: "http://127.0.0.1:4180/demo/review-detail.html?id=CASE-2026-0001",
      attachments: [
        {
          name: "营业执照.pdf",
          url: "http://127.0.0.1:4180/demo/files/license.pdf",
        },
        {
          name: "法人身份证.jpg",
          url: "http://127.0.0.1:4180/demo/files/id-card.jpg",
        },
      ],
      extractedAt: "2026-03-29T08:00:00.000Z",
    });

    expect(prompt).toContain("你正在处理一个预审办件 demo");
    expect(prompt).toContain("示例待预审办件");
    expect(prompt).toContain("CASE-2026-0001");
    expect(prompt).toContain("营业执照.pdf");
    expect(prompt).toContain("法人身份证.jpg");
  });

  test("normalizes attachment items and removes invalid rows", async () => {
    const module = await importDemoModule();

    const attachments = module.normalizeDemoAttachments([
      { name: "  营业执照.pdf  ", url: " http://127.0.0.1:4180/demo/files/license.pdf " },
      { name: "", url: "http://127.0.0.1:4180/demo/files/skip.pdf" },
      { name: "缺链接附件", url: "" },
    ]);

    expect(attachments).toEqual([
      {
        name: "营业执照.pdf",
        url: "http://127.0.0.1:4180/demo/files/license.pdf",
      },
    ]);
  });

  test("finds the latest assistant reply text from chat history messages", async () => {
    const module = await importDemoModule();

    const text = module.findLatestAssistantReplyText([
      {
        role: "user",
        content: [{ type: "text", text: "请分析附件" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "第一版分析结果" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "最终分析结果" }],
      },
    ]);

    expect(text).toBe("最终分析结果");
  });

  test("builds a result payload for the demo result page", async () => {
    const module = await importDemoModule();

    const payload = module.buildDemoPreReviewResultPayload({
      detail: {
        caseTitle: "建筑工程施工许可申请",
        caseNumber: "CASE-2026-0001",
        caseStatus: "待预审",
        detailUrl: "http://127.0.0.1:4180/demo/review-detail.html?id=CASE-2026-0001",
        attachments: [
          { name: "营业执照.pdf", url: "http://127.0.0.1:4180/demo/files/license.pdf" },
        ],
      },
      analysisText: "办件概览：材料齐全。",
      sessionKey: "demo-pre-review",
      source: "openclaw",
      generatedAt: "2026-03-29T09:00:00.000Z",
    });

    expect(payload.caseTitle).toBe("建筑工程施工许可申请");
    expect(payload.analysisText).toContain("材料齐全");
    expect(payload.sessionKey).toBe("demo-pre-review");
    expect(payload.source).toBe("openclaw");
    expect(payload.attachments).toHaveLength(1);
  });
});
