import type { VideoLearningStore } from "./storage.ts";
import type { AccountContentAnalysisContent, AccountContentReportFormat } from "./types.ts";

function itemLabel(item: AccountContentAnalysisContent["contentPillars"][number], label: "claim" | "name" | "pattern" | "reason"): string {
  return item[label] || item.claim || item.name || item.pattern || item.reason || "";
}

function evidenceLine(item: AccountContentAnalysisContent["positioning"]): string {
  return [
    item.claim || "无足够证据。",
    "",
    `证据：${item.evidence || "-"}；视频：${item.videos.join(", ") || "-"}`,
  ].join("\n");
}

function evidenceBullets(items: AccountContentAnalysisContent["contentPillars"]): string {
  if (items.length === 0) return "- 无足够证据。";
  return items.map(item => `- ${itemLabel(item, "claim")}（证据：${item.evidence}；视频：${item.videos.join(", ")}）`).join("\n");
}

function evidenceItems(items: AccountContentAnalysisContent["contentPillars"], label: "name" | "pattern" | "reason"): string {
  if (items.length === 0) return "| 项目 | 证据 | 视频 |\n| --- | --- | --- |\n| 无证据 | - | - |";
  return [
    "| 项目 | 证据 | 视频 |",
    "| --- | --- | --- |",
    ...items.map(item => `| ${itemLabel(item, label).replace(/\n/g, "<br>")} | ${item.evidence.replace(/\n/g, "<br>")} | ${item.videos.join(", ")} |`),
  ].join("\n");
}

function representative(items: AccountContentAnalysisContent["representativeVideos"]): string {
  if (items.length === 0) return "| 视频 | 原因 | 证据 |\n| --- | --- | --- |\n| 无证据 | - | - |";
  return [
    "| 视频 | 原因 | 证据 |",
    "| --- | --- | --- |",
    ...items.map(item => `| ${item.videoId} | ${item.reason.replace(/\n/g, "<br>")} | ${item.evidence.replace(/\n/g, "<br>")} |`),
  ].join("\n");
}

export function generateAccountContentReport(store: VideoLearningStore, accountAnalysisId: string, format: AccountContentReportFormat): string {
  const analysis = store.getAccountContentAnalysis(accountAnalysisId);
  if (!analysis) throw new Error(`Account content analysis not found: ${accountAnalysisId}`);
  const content = analysis.contentJson;
  const header = [
    `# ${analysis.author} - 账号内容分析`,
    "",
    `视频数：${analysis.videoIds.length}  文本模型：${analysis.provider === "local" ? "模型增强不可用，使用本地低置信度聚合" : `${analysis.provider}/${analysis.model}`}  置信度：${content.confidence}`,
    "",
    "## 账号定位",
    evidenceLine(content.positioning),
    "",
    "## 目标受众",
    evidenceLine(content.audience),
    "",
    "## 内容支柱",
    evidenceItems(content.contentPillars, "name"),
    "",
    "## Hook 模式",
    evidenceItems(content.hookPatterns, "pattern"),
    "",
    "## 可复用内容模板",
    evidenceBullets(content.reusableTemplates),
    "",
    "## 关键风险",
    evidenceBullets(content.risks),
  ];
  if (format === "brief") return header.join("\n");
  return [
    ...header,
    "",
    "## 论点结构",
    evidenceItems(content.argumentPatterns, "pattern"),
    "",
    "## 高频关键词",
    evidenceBullets(content.keywords),
    "",
    "## 代表视频",
    representative(content.representativeVideos),
    "",
    "## 机会点",
    evidenceBullets(content.opportunities),
    "",
    "## 证据自检",
    `- 参与视频：${analysis.videoIds.join(", ")}`,
    `- 单视频内容分析：${analysis.singleAnalysisIds.join(", ")}`,
    ...content.evidenceNotes.map(note => `- ${note}`),
    "- 本报告只使用单视频内容分析和语音转写/字幕证据。",
    "- 未分析任何视觉或拍摄信息。",
  ].join("\n");
}
