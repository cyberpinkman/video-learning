import type { VideoLearningStore } from "./storage.ts";
import type { ContentAnalysisContent, ContentReportFormat, TranscriptSegmentRecord } from "./types.ts";
import { localContentAnalysis } from "./content.ts";
import { timeRange } from "./time.ts";

function transcriptTable(transcript: TranscriptSegmentRecord[]): string {
  if (transcript.length === 0) return "| 时间 | 说话人 | 内容 |\n| --- | --- | --- |\n| 无证据 | - | 未检测到语音转写或字幕。 |";
  return [
    "| 时间 | 说话人 | 内容 |",
    "| --- | --- | --- |",
    ...transcript.map(segment => `| ${timeRange(segment.startSec, segment.endSec)} | ${segment.speaker ?? "S1"} | ${segment.text.replace(/\n/g, "<br>")} |`),
  ].join("\n");
}

function lines(values: string[]): string {
  return values.length > 0 ? values.map(value => `- ${value}`).join("\n") : "- 无足够转写证据。";
}

function structure(content: ContentAnalysisContent): string {
  if (content.structure.length === 0) return "| 时间 | 内容模块 | 证据 |\n| --- | --- | --- |\n| 无证据 | 未检测到可分析内容 | - |";
  return [
    "| 时间 | 内容模块 | 证据 |",
    "| --- | --- | --- |",
    ...content.structure.map(item => {
      const range = typeof item.startSec === "number" && typeof item.endSec === "number" ? timeRange(item.startSec, item.endSec) : "见证据";
      return `| ${range} | ${item.summary.replace(/\n/g, "<br>")} | ${item.evidence.replace(/\n/g, "<br>")} |`;
    }),
  ].join("\n");
}

function evidenceStatus(provider: string, model: string, transcript: TranscriptSegmentRecord[], content: ContentAnalysisContent): string {
  return [
    `- 转写证据：${transcript.length > 0 ? `已保存 ${transcript.length} 段时间戳转写。` : "证据不足，未检测到转写。"} `,
    `- 文本模型：${provider === "local" ? "模型增强不可用，使用本地低置信度整理。" : `${provider}/${model}`}`,
    `- 置信度：${content.confidence}`,
    ...content.evidenceNotes.map(note => `- 证据说明：${note}`),
  ].join("\n");
}

export function generateContentReport(store: VideoLearningStore, videoId: string, format: ContentReportFormat): string {
  const video = store.getVideo(videoId);
  if (!video) throw new Error(`Video not found: ${videoId}`);
  const transcript = store.listTranscript(videoId);
  const analysis = store.getLatestContentAnalysis(videoId);
  const content = analysis?.contentJson ?? localContentAnalysis(transcript);
  const provider = analysis?.provider ?? "local";
  const model = analysis?.model ?? "fallback";

  if (format === "transcript") {
    return [
      `# ${video.title} - 内容转写`,
      "",
      `平台：${video.platform}  作者：${video.author ?? "未知"}  时长：${video.durationSec ? `${video.durationSec.toFixed(1)} 秒` : "未知"}`,
      "",
      "## 证据状态",
      evidenceStatus(provider, model, transcript, content),
      "",
      "## 逐段转写",
      transcriptTable(transcript),
    ].join("\n");
  }

  const briefSections = [
    `# ${video.title} - 内容分析`,
    "",
    `平台：${video.platform}  作者：${video.author ?? "未知"}  时长：${video.durationSec ? `${video.durationSec.toFixed(1)} 秒` : "未知"}`,
    "",
    "## 证据状态",
    evidenceStatus(provider, model, transcript, content),
    "",
    "## 内容 Hook",
    content.hook || "无足够转写证据。",
    "",
    "## 核心内容",
    lines(content.arguments),
    "",
    "## 可复用内容框架",
    content.reusableFramework || "无足够转写证据。",
    "",
    "## 风险提示",
    lines(content.risks),
  ];

  if (format === "brief") return briefSections.join("\n");

  return [
    ...briefSections,
    "",
    "## 主题与受众",
    `- 主题：${content.topic || "未知"}`,
    `- 目标受众：${content.audience || "未知"}`,
    "",
    "## 内容结构",
    structure(content),
    "",
    "## 关键表达",
    lines(content.quotes),
    "",
    "## 关键词",
    content.keywords.length > 0 ? content.keywords.join("、") : "无足够转写证据。",
    "",
    "## 逐段转写",
    transcriptTable(transcript),
    "",
    "## 质量自检",
    "- 本报告只使用语音转写/字幕证据。",
    "- 未分析画面、拍摄方式、构图或视觉字幕。",
    "- 机器转写和文本模型结论需要人工复核后用于发布或生产。",
  ].join("\n");
}
