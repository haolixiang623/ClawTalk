function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export const DEMO_PRE_REVIEW_URL = "http://127.0.0.1:4180/demo/review-list.html";
export const DEMO_PRE_REVIEW_RESULT_URL = "http://127.0.0.1:4180/demo/review-result.html";
export const DEMO_PRE_REVIEW_SESSION_KEY = "demo-pre-review";
export const DEMO_PRE_REVIEW_RESULT_STORAGE_KEY = "demo-pre-review-result";

export const DEMO_PRE_REVIEW_SELECTORS = Object.freeze({
  firstPendingLink: "[data-demo-case-link]",
  detailRoot: "[data-demo-case-detail]",
  caseTitle: "[data-demo-case-title]",
  caseNumber: "[data-demo-case-number]",
  caseStatus: "[data-demo-case-status]",
  attachmentLink: "[data-demo-attachment-link]",
});

export function normalizeDemoAttachments(entries = []) {
  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry) => ({
      name: normalizeString(entry?.name),
      url: normalizeString(entry?.url),
    }))
    .filter((entry) => entry.name && entry.url);
}

export function buildDemoPreReviewSummary(detail = {}) {
  const caseTitle = normalizeString(detail.caseTitle) || "未命名办件";
  const caseNumber = normalizeString(detail.caseNumber) || "未知编号";
  const attachmentCount = normalizeDemoAttachments(detail.attachments).length;

  return `[Demo 预审首单] ${caseTitle} (${caseNumber})，附件 ${attachmentCount} 个`;
}

export function buildDemoPreReviewPrompt(detail = {}) {
  const caseTitle = normalizeString(detail.caseTitle) || "未命名办件";
  const caseNumber = normalizeString(detail.caseNumber) || "未知编号";
  const caseStatus = normalizeString(detail.caseStatus) || "待预审";
  const detailUrl = normalizeString(detail.detailUrl) || DEMO_PRE_REVIEW_URL;
  const extractedAt = normalizeString(detail.extractedAt) || new Date().toISOString();
  const attachments = normalizeDemoAttachments(detail.attachments);

  const attachmentLines = attachments.length
    ? attachments.map((attachment, index) => `${index + 1}. ${attachment.name} - ${attachment.url}`)
    : ["1. 无附件"];

  return [
    "你正在处理一个预审办件 demo，请按固定的“预审首单”技能方式完成分析。",
    "请基于下面的办件信息，给出结构化输出。",
    "",
    "输出要求：",
    "1. 办件概览：一句话概括办件内容。",
    "2. 附件检查：列出你认为需要重点核对的附件和原因。",
    "3. 预审建议：给出 3 条简明的下一步建议。",
    "4. 风险提醒：指出缺失信息、链接异常或需要人工确认的点。",
    "",
    `办件标题：${caseTitle}`,
    `办件编号：${caseNumber}`,
    `当前状态：${caseStatus}`,
    `详情地址：${detailUrl}`,
    `抓取时间：${extractedAt}`,
    "附件列表：",
    ...attachmentLines,
  ].join("\n");
}

export function extractPlainTextFromChatMessage(message) {
  if (!message) return "";

  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => {
      if (!part) return "";
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return normalizeString(part.text || part.value || part.content);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function findLatestAssistantReplyText(messages = []) {
  if (!Array.isArray(messages)) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (normalizeString(message?.role) !== "assistant") continue;

    const text = extractPlainTextFromChatMessage(message);
    if (text) return text;
  }

  return "";
}

export function buildDemoPreReviewMockAnalysis(detail = {}) {
  const attachments = normalizeDemoAttachments(detail.attachments);
  const attachmentNames = attachments.length
    ? attachments.map((item) => item.name).join("、")
    : "无";

  return [
    "办件概览：该办件为 demo 预审样例，材料入口已成功抓取。",
    `附件检查：当前抓取到 ${attachments.length} 个附件，分别为 ${attachmentNames}。建议优先核对营业资质、身份证明和审查证明。`,
    "预审建议：",
    "1. 先确认附件链接是否可访问、是否存在空文件。",
    "2. 核对申请主体与办件事项是否匹配。",
    "3. 将需要人工复核的点转入正式预审流程。",
    "风险提醒：这是 dry-run / fallback 结果，尚未等待真实 OpenClaw 分析完成。",
  ].join("\n");
}

export function buildDemoPreReviewResultPayload({
  detail = {},
  analysisText = "",
  sessionKey = DEMO_PRE_REVIEW_SESSION_KEY,
  source = "openclaw",
  generatedAt = "",
} = {}) {
  return {
    caseTitle: normalizeString(detail.caseTitle) || "未命名办件",
    caseNumber: normalizeString(detail.caseNumber) || "未知编号",
    caseStatus: normalizeString(detail.caseStatus) || "待预审",
    detailUrl: normalizeString(detail.detailUrl) || DEMO_PRE_REVIEW_URL,
    extractedAt: normalizeString(detail.extractedAt) || new Date().toISOString(),
    attachments: normalizeDemoAttachments(detail.attachments),
    analysisText: normalizeString(analysisText),
    sessionKey: normalizeString(sessionKey) || DEMO_PRE_REVIEW_SESSION_KEY,
    source: normalizeString(source) || "openclaw",
    generatedAt: normalizeString(generatedAt) || new Date().toISOString(),
  };
}
