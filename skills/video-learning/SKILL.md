---
name: video-learning
description: |
  Analyze, deconstruct, compare, and recreate long-form social videos using the local video-learning MCP tools. Use for requests about analyzing a target video, dissecting a viral video, imitating a video's shooting style, generating a shot list, or making a practical recreation plan for Douyin, WeChat Channels, Xiaohongshu, TikTok, YouTube, screen recordings, or local video files.
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
2. If the user gives a URL, call `acquire_video` with the apparent platform. If acquisition fails, ask for a local file or authorized screen recording.
3. Call `analyze_video` with `depth: "standard"` unless the user explicitly wants a very detailed breakdown; then use `depth: "deep"`.
4. Call `get_video_report`:
   - `full` for complete analysis.
   - `shooting_brief` for a practical filming plan.
   - `shot_list` for a shot table.
   - `edit_brief` for editing rhythm and structure.
5. For imitation or production requests, call `make_recreation_plan` with any user constraints such as budget, location, equipment, product, persona, or target platform.
6. For multiple references, use `compare_videos` after each video is analyzed.

## Output Bar

A good answer includes:

- 前 3 秒 hook 拆解。
- 全片结构：开场、承接、高潮、收尾。
- 逐镜头表 or a summarized shot list with timestamps.
- 节奏指标：镜头数、平均镜头时长、字幕密度、口播速度、B-roll 比例.
- 复拍方案：脚本、镜头清单、场景/道具/光线、拍摄顺序、剪辑步骤.
- 风险提示：可借鉴、不可照搬、需替换的素材或表达。

## Anti-Patterns

- Do not answer with generic praise like “节奏很好” or “风格很强” without timestamp evidence.
- Do not invent platform metadata, transcript text, or visual details that the tools did not produce.
- Do not expose cookies, tokens, proxy addresses, or account details from acquisition logs.
- Do not claim a platform URL was downloaded if `acquire_video` returned failure.
