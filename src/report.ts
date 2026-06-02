import type { VideoLearningStore } from "./storage.ts";
import type { ReportFormat, ShotRecord, TranscriptSegmentRecord } from "./types.ts";
import { timeRange } from "./time.ts";

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fixed(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.0";
}

function transcriptNear(transcript: TranscriptSegmentRecord[], startSec: number, endSec: number): string {
  const text = transcript
    .filter(segment => segment.endSec >= startSec && segment.startSec <= endSec)
    .map(segment => segment.text)
    .join(" ")
    .trim();
  return text || "未检测到对应口播；复拍时按画面目的补一句直接口播。";
}

function firstHook(shots: ShotRecord[], transcript: TranscriptSegmentRecord[]): string {
  const hookShots = shots.filter(shot => shot.startSec < 3);
  const evidence = hookShots.length > 0 ? hookShots : shots.slice(0, 1);
  return evidence.map(shot => {
    const words = transcriptNear(transcript, shot.startSec, Math.min(shot.endSec, 3));
    return `- ${timeRange(shot.startSec, Math.min(shot.endSec, 3))} ${shot.visualSummary || "开场画面"}；口播/字幕证据：“${shot.subtitles || words}”。作用：${shot.purpose || "用痛点、反差或承诺让观众继续看"}`;
  }).join("\n") || "- 缺少镜头证据；需要重新抽帧或导入可读视频。";
}

function structureSummary(durationSec: number | null): string {
  const duration = durationSec ?? 0;
  const openEnd = Math.min(duration || 30, 15);
  const midEnd = Math.max(openEnd, duration * 0.7);
  return [
    `- 开场：0-${fixed(openEnd, 0)} 秒，必须交代痛点、结果承诺或冲突。`,
    `- 承接：${fixed(openEnd, 0)}-${fixed(midEnd, 0)} 秒，用示范、解释、对比或案例保持信息密度。`,
    `- 高潮：约 ${fixed(midEnd, 0)} 秒后，集中展示最强画面、结论或转折。`,
    "- 收尾：复述收益，给出行动指令或下一步观看理由。",
  ].join("\n");
}

function shotTable(shots: ShotRecord[]): string {
  if (shots.length === 0) return "| 时间 | 画面 | 景别 | 运镜 | 字幕/声音 | 作用 |\n| --- | --- | --- | --- | --- | --- |\n| 无证据 | 需要重新处理视频 | - | - | - | - |";
  const rows = shots.map(shot => {
    const sound = [shot.subtitles, shot.audioRole].filter(Boolean).join(" / ") || "无字幕或未识别声音角色";
    return `| ${timeRange(shot.startSec, shot.endSec)} | ${shot.visualSummary || "关键帧待分析"} | ${shot.shotSize || "未判定"} | ${shot.cameraMotion || "未判定"} | ${sound} | ${shot.purpose || "承接叙事"} |`;
  });
  return ["| 时间 | 画面 | 景别 | 运镜 | 字幕/声音 | 作用 |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function metrics(shots: ShotRecord[], transcript: TranscriptSegmentRecord[], durationSec: number | null): string {
  const durations = shots.map(shot => Math.max(0, shot.endSec - shot.startSec));
  const totalDuration = durationSec ?? durations.reduce((sum, value) => sum + value, 0);
  const subtitleChars = shots.reduce((sum, shot) => sum + shot.subtitles.length, 0);
  const wpm = avg(transcript.map(segment => segment.wordsPerMinute ?? 0).filter(Boolean));
  const brollCount = shots.filter(shot => /b-roll|示范|空镜|素材|特写/i.test(`${shot.visualSummary} ${shot.purpose}`)).length;
  return [
    `- 镜头数：${shots.length}`,
    `- 平均镜头时长：${fixed(avg(durations), 2)} 秒`,
    `- 字幕密度：${fixed(totalDuration > 0 ? subtitleChars / (totalDuration / 60) : 0, 1)} 字/分钟`,
    `- 口播速度：${fixed(wpm, 0)} 词/分钟`,
    `- B-roll 比例：${fixed(shots.length > 0 ? (brollCount / shots.length) * 100 : 0, 1)}%`,
  ].join("\n");
}

function evidenceStatus(shots: ShotRecord[], transcript: TranscriptSegmentRecord[]): string {
  const visualInsufficient = shots.length === 0 || shots.some(shot => shot.visualSummary.includes("证据不足"));
  const transcriptInsufficient = transcript.length === 0;
  const lines = [
    `- 视觉证据：${visualInsufficient ? "证据不足，仅有关键帧/时间戳；需要云端视觉模型或人工复核补全景别、构图、运镜。" : "已包含镜头级视觉描述。"}`,
    `- 口播证据：${transcriptInsufficient ? "证据不足，未检测到字幕或转写；口播速度、字幕密度和音频角色不可完全判定。" : "已包含时间戳转写片段。"}`,
  ];
  return lines.join("\n");
}

function recreationPlan(shots: ShotRecord[]): string {
  const sequence = shots.slice(0, 12).map((shot, index) => {
    if (shot.visualSummary.includes("证据不足") || (!shot.shotSize && !shot.cameraMotion && !shot.composition)) {
      return `${index + 1}. ${timeRange(shot.startSec, shot.endSec)} 先补充视觉分析或人工复核；当前只能确认该时间段有关键帧，不能判定景别、运镜、构图。`;
    }
    return `${index + 1}. ${timeRange(shot.startSec, shot.endSec)} 复拍：${shot.shotSize || "同景别"}，${shot.cameraMotion || "稳定拍摄"}，${shot.composition || "主体清晰"}；画面任务：${shot.visualSummary || shot.purpose || "复现该镜头的信息功能"}`;
  });
  return [
    "### 脚本",
    "- 第一句直接给痛点或结果承诺，不铺垫背景。",
    "- 每个论点只服务一个画面动作：错误示范、正确示范、结果对比或关键结论。",
    "- 结尾给观众一个明确动作：收藏、照做、看下一条或评论关键词。",
    "",
    "### 镜头清单",
    ...(sequence.length > 0 ? sequence : ["1. 先补充可读视频证据，再生成镜头清单。"]),
    "",
    "### 场景/道具/光线",
    "- 场景只保留和主题相关的道具，背景避免抢主体。",
    "- 主光放在主体前侧 30-45 度；手机拍摄优先锁曝光和白平衡。",
    "- 道具按镜头顺序摆放，减少拍摄中断。",
    "",
    "### 拍摄顺序",
    "- 先拍所有口播主镜头，再按 shot list 补 B-roll 和特写。",
    "- 同一机位连续拍完，最后补转场和手部动作。",
    "",
    "### 剪辑步骤",
    "- 先按口播剪出骨架，再插入 B-roll 覆盖解释段。",
    "- 前 3 秒保留最强字幕和画面变化，删除寒暄。",
    "- 每个镜头只保留一个信息点；字幕按短句断行。",
  ].join("\n");
}

function risks(): string {
  return [
    "- 可以借鉴：结构节奏、镜头功能、字幕密度、信息展开方式。",
    "- 不宜照搬：原作者文案、独特口头禅、商标、音乐、完整构图组合。",
    "- 必须重拍：人物、场景、道具和案例要换成你的真实素材。",
    "- 如果目标视频包含受版权保护的音乐或素材，复拍时替换为自有或授权素材。",
  ].join("\n");
}

export function generateRecreationReport(store: VideoLearningStore, videoId: string, format: ReportFormat): string {
  const video = store.getVideo(videoId);
  if (!video) throw new Error(`Video not found: ${videoId}`);
  const shots = store.listShots(videoId);
  const transcript = store.listTranscript(videoId);

  if (format === "shot_list") {
    return [`# ${video.title} - Shot List`, "", shotTable(shots)].join("\n");
  }

  if (format === "edit_brief") {
    return [
      `# ${video.title} - 剪辑简报`,
      "",
      "## 节奏指标",
      metrics(shots, transcript, video.durationSec),
      "",
      "## 逐镜头表",
      shotTable(shots),
    ].join("\n");
  }

  if (format === "shooting_brief") {
    return [
      `# ${video.title} - 拍摄简报`,
      "",
      "## 证据状态",
      evidenceStatus(shots, transcript),
      "",
      "## 前 3 秒 Hook 拆解",
      firstHook(shots, transcript),
      "",
      "## 逐镜头表",
      shotTable(shots),
      "",
      "## 复拍方案",
      recreationPlan(shots),
      "",
      "## 风险提示",
      risks(),
    ].join("\n");
  }

  const sections = [
    `# ${video.title}`,
    "",
    `平台：${video.platform}  作者：${video.author ?? "未知"}  时长：${video.durationSec ? `${fixed(video.durationSec, 1)} 秒` : "未知"}`,
    "",
    "## 证据状态",
    evidenceStatus(shots, transcript),
    "",
    "## 前 3 秒 Hook 拆解",
    firstHook(shots, transcript),
    "",
    "## 全片结构",
    structureSummary(video.durationSec),
    "",
    "## 逐镜头表",
    shotTable(shots),
    "",
    "## 节奏指标",
    metrics(shots, transcript, video.durationSec),
    "",
    "## 复拍方案",
    recreationPlan(shots),
    "",
    "## 风险提示",
    risks(),
  ];
  return sections.join("\n");
}
