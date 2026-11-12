---
name: video-learning
description: |
  Analyze, deconstruct, compare, and recreate social videos using the local video-learning MCP tools. Use deep-analyze-single for shot-level recreation analysis, content-analyze-single for transcript-only single-video content analysis, and content-analyze-account for same-author multi-video strategy analysis.
---

# Video Learning

Use this skill when the user asks to analyze, deconstruct, imitate, recreate, or learn from a target video.

## Contract

- Use the `video-learning` MCP tools as the evidence source; do not produce a recreation analysis from memory alone.
- Default output language is Chinese.
- Every important claim must point to a timestamp, shot row, transcript segment, or stored report.
- The output must be directly usable for shooting and editing: script, shot list, scene/prop/light notes, shooting order, edit steps.
- Use only this project's MCP tools, local database, and timestamped evidence.

## Workflow

1. If the user gives a local file path or screen recording, call `ingest_video_file`.
2. If the user gives a URL, call `acquire_video` with the apparent platform. Check the returned status and video identity; if acquisition fails, follow the recovery workflow below before asking for another input.
3. For shot-level拉片/复拍 requests, call `deep_analyze_single` with `depth: "standard"` unless the user explicitly wants a very detailed breakdown; then use `depth: "deep"`.
4. Call `get_deep_analyze_single_report`:
   - `full` for complete analysis.
   - `shooting_brief` for a practical filming plan.
   - `shot_list` for a shot table.
   - `edit_brief` for editing rhythm and structure.
5. For transcript-only content requests, call `content_analyze_single`, then `get_content_analyze_single_report`:
   - `full` for content structure, arguments, reusable framework, and transcript evidence.
   - `brief` for a compact content summary.
   - `transcript` for timestamped transcript only.
6. For same-author multi-video account content strategy requests, call `content_analyze_account` with explicit `video_ids`, then `get_content_analyze_account_report`:
   - `full` for account positioning, content pillars, hook patterns, reusable templates, representative videos, and risks.
   - `brief` for compact account strategy summary.
7. For imitation or production requests, call `make_recreation_plan` with any user constraints such as budget, location, equipment, product, persona, or target platform.
8. For multiple references, use `compare_videos` after each video is deep-analyzed.

## Acquisition recovery and evidence

- Read `attempts` first. `skipped` means an adapter did not run. For a failed attempt, inspect `error.code`, `phase`, `retryable`, `diagnostics_path`, and `next_actions`, then read that invocation's diagnostic file. Successful attempts may also include `diagnostics_path`. An older string-only error calls for diagnosis; it does not prove the video is deleted, login is required, or the tool is unavailable.
- Use `get_video_learning_status` to locate the actual `project_root`, `cli_path`, `workspace_dir`, `db_path`, and configured adapters. This reports local configuration, not verified platform login or connectivity. Inspect the failed page/player state and network evidence: a persistent login button is not a playback login gate, and an empty candidate list leaves the cause unknown.
- The browser runtime uses bounded readiness waiting and at most one recovery navigation for evidenced network or navigation failures. Check its recovery history before taking another action. Add at most one outer acquisition only when new evidence supports it, such as a verified canonical URL for the same work or a resolved transient blocker. Do not loop under unchanged conditions; changing Douyin's `strategy` to `strong` alone does not add a retrieval route.
- If local CLI diagnosis is needed, use the absolute entrypoint returned by the status tool with the same workspace/database and existing configuration. Record temporary diagnostic options. Do not copy another project's environment, switch arbitrary accounts/profiles, run concurrent jobs against one browser profile, or expose credentials.
- Continue through relevant available routes, such as an authorized work page, an author's official mirror verified as the same work, or an already authorized recording/local file. Unconfigured fallback adapters do not count as attempted routes. A concrete login, verification challenge, or other user-action blocker should be handed back with the evidence and minimum required action; do not bypass it.
- For a whole-video summary or credibility assessment, obtain the complete media and check that transcript/subtitles cover its speech without truncation or missing passages. Add visual evidence where meaning depends on the images. Partial evidence supports only a partial answer. Titles, descriptions, comments, and search snippets may locate sources, but cannot replace the video's content or justify a whole-video score.
- If reasonable routes remain blocked, report what was attempted, the specific blocker, missing evidence, and minimum needed input. A later successful download does not by itself establish the original root cause or prove it was fixed.

## Output Bar

A good answer includes:

- 前 3 秒 hook 拆解。
- 全片结构：开场、承接、高潮、收尾。
- 逐镜头表 or a summarized shot list with timestamps.
- 节奏指标：镜头数、平均镜头时长、字幕密度、口播速度、B-roll 比例.
- 复拍方案：脚本、镜头清单、场景/道具/光线、拍摄顺序、剪辑步骤.
- 风险提示：可借鉴、不可照搬、需替换的素材或表达。

For content-analyze-single, a good answer includes:

- 主题、目标受众、内容 hook。
- 只基于 transcript 时间段的内容结构。
- 核心论点、关键表达、关键词、可复用内容框架。
- 明确标注模型增强状态和转写置信度。内容分析的 `confidence` 不是视频主张的事实正确率；事实核查须另行验证其证据及适用条件。
- 不包含景别、运镜、逐镜头表或复拍镜头清单。

For content-analyze-account, a good answer includes:

- 账号定位、目标受众、内容支柱。
- Hook 模式、论点结构、关键词和代表视频。
- 可复用内容模板、机会点和风险提示。
- 每个账号级结论都引用参与视频 id 和 transcript 时间段证据。
- 任一参与视频缺少非空转写证据时，不生成账号策略总结。
- 不做账号主页抓取、跨账号对比或视觉分析。

## Anti-Patterns

- Do not answer with generic praise like “节奏很好” or “风格很强” without timestamp evidence.
- Do not invent platform metadata, transcript text, or visual details that the tools did not produce.
- Do not expose cookies, tokens, proxy addresses, or account details from acquisition logs.
- Do not claim a platform URL was downloaded if `acquire_video` returned failure.
