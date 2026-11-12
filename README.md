# video-learning

独立本地视频学习系统。`video-learning` 是项目总名称；当前包含单视频深度拉片 `deep-analyze-single`、单视频内容分析 `content-analyze-single` 和账号级内容分析 `content-analyze-account`。

## Quick Start

```bash
bun install
./scripts/install_adapters.sh
cp .env.example .env.local
bun test

# 导入本地视频或授权录屏
bun run src/cli.ts ingest /path/to/video.mp4 --platform local

# 深度拉片：没有 OPENAI_API_KEY 时仍会用本地 ffmpeg/ffprobe 生成镜头证据
bun run src/cli.ts deep-analyze-single <video_id>

# 输出复拍级报告
bun run src/cli.ts deep-report-single <video_id> --format full

# 内容分析：只读取语音转写/字幕，不切镜、不抽关键帧、不分析画面
bun run src/cli.ts content-analyze-single <video_id>
bun run src/cli.ts content-report-single <video_id> --format full

# 账号作品发现：枚举抖音账号主页作品清单，并默认逐条采集本地视频资产；不转写、不分析
bun run src/cli.ts content-discover-account <account_url> --platform douyin --out reports/<account>-discovery.json
bun run src/cli.ts content-discover-account-result <discovery_id> --out reports/<account>-discovery.json

# 账号级内容分析：传入同一作者的多条本地视频 id，自动补跑缺失的 single 内容分析；任一视频缺少转写证据会失败
bun run src/cli.ts content-analyze-account <video_id_1> <video_id_2>
bun run src/cli.ts content-report-account <account_analysis_id> --format full

# 稳定交付：把数据库/素材放项目本地持久工作区，把 Markdown 报告写入 reports/
PROJECT_HOME="$PWD"
VL_HOME="$PROJECT_HOME/.video-learning-data"
bun run src/cli.ts deep-analyze-single <video_id> --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite"
bun run src/cli.ts deep-report-single <video_id> --format full --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite" --out "$PROJECT_HOME/reports/<video_id>-deep-full.md"
bun run src/cli.ts content-analyze-single <video_id> --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite"
bun run src/cli.ts content-report-single <video_id> --format full --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite" --out "$PROJECT_HOME/reports/<video_id>-content-full.md"
bun run src/cli.ts content-discover-account <account_url> --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite" --out "$PROJECT_HOME/reports/<account>-discovery.json"
bun run src/cli.ts content-analyze-account <video_id_1> <video_id_2> --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite"
bun run src/cli.ts content-report-account <account_analysis_id> --format full --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite" --out "$PROJECT_HOME/reports/<account_analysis_id>-account-full.md"

# 启动 MCP stdio server
bun run src/cli.ts mcp
```

默认数据目录：`~/.video-learning/`。

## 安装到 Codex，跨项目使用

本项目提供本地 stdio MCP。安装一次后，本机其他项目的新 Codex 会话可直接调用视频采集、转写内容分析、拉片、账号内容策略、对比、复拍与视频记忆检索，无须切回本目录。

```bash
# 在本项目执行，要求 Python 3.11+、Bun、Codex CLI 和已安装的项目依赖
bun run mcp:install

# 按全局配置从其他目录启动 MCP，验证握手、工具列表和资料库读取
bun run mcp:check
```

安装器写入 `${CODEX_HOME:-~/.codex}/config.toml` 中的 `mcp_servers.video-learning`，并把配套技能安装到该 Codex home 的 `skills/video-learning/`。安装前会备份配置，保留其他服务器和设置。全局配置方式见 [Codex MCP 官方说明](https://developers.openai.com/codex/mcp)。

安装默认复用**本项目 `.video-learning-data/video-learning.sqlite`**，不合并或替换 `~/.video-learning/` 的另一份资料库。服务采用绝对 Bun/项目/数据路径，固定工作目录，禁止 Bun 自动读取调用方的 `.env`；项目自己的 `.env`、`.env.local` 仍由现有配置加载器读取。凭据不会复制到 Codex 配置或调用方项目。素材和转写留在共享资料库，报告可保存到当前调用项目的绝对路径。

可指定其他共享目录或已有数据库：

```bash
python3 scripts/install_codex_mcp.py --workspace /absolute/library --db /absolute/library/video-learning.sqlite
```

安装后新建 Codex 会话；若工具尚未加载，重启 Codex。可以直接说：

- “用 video-learning 分析这个视频的口播结构：<链接>。”
- “用 video-learning 检索之前分析过的 <作者/标题关键词>。”
- “只列出这个抖音账号的作品，不下载：<账号主页>。”
- “用 video-learning 拉片这个本地视频，把报告保存到当前项目的 reports 目录。”

也可用 `$video-learning` 显式调用配套技能。先调用 `get_video_learning_status` 可查看实际库路径、视频数量、可执行程序、文本模型配置和采集 adapter。状态工具不检测平台登录或远程服务连通性。首次登录仍按下文平台登录说明完成；配置中的登录态可继续复用。

MCP 的 `ingest_video_file.path` 和三个报告接口的 `output_path` 必须是绝对路径。完整报告或逐字稿推荐传 `output_path`：写入完整 Markdown 后返回文件路径与字节数；省略时返回报告正文。`content_discover_account` 默认逐条下载作品，仅列清单必须传 `acquire_assets: false`。

安装默认启动超时为 30 秒、工具调用超时为 3600 秒，可通过 `--startup-timeout` / `--tool-timeout` 调整。账号全量下载或长视频转写可能超过该时间；超时不代表没有发生写入，应先检查已有结果。此安装依赖当前项目目录、`.venv` 与 Bun；搬移项目后重新运行安装器。检查命令仅验证本地 MCP 和资料库，不代表所有平台采集与云模型已端到端验证。

卸载连接：`codex mcp remove video-learning`；如不再需要配套技能，可移除 Codex home 中的 `skills/video-learning/`。两者均无需删除共享视频资料。

交付规则：

- `/tmp` 只允许用于一次性 smoke test，不作为报告、数据库或可审阅产物的保存位置。
- 可复查产物必须放在稳定路径：数据库/下载/关键帧放 `.video-learning-data/` 或 `~/.video-learning/`，Markdown 报告放 `reports/`。
- `deep-report-single --out <path>`、`content-report-single --out <path>` 和 `content-report-account --out <path>` 会把可读 Markdown 写到指定文件。
- 报告命令不会再为不存在的 `--db` 路径静默创建空库；缺失数据库会直接失败。
- 报告命令默认不会把超长 Markdown 直接输出到 stdout；超过 `VIDEO_LEARNING_CLI_MAX_STDOUT_BYTES` 时必须使用 `--out <path>`，避免 Codex/终端读取大量 transcript/report。

## Tools

MCP 工具：

- `get_video_learning_status()`
- `acquire_video(url, platform?, strategy?)`
- `ingest_video_file(path, platform?, source_url?)`
- `deep_analyze_single(video_id, depth?)`
- `get_deep_analyze_single_report(video_id, format?, output_path?)`
- `content_analyze_single(video_id)`
- `get_content_analyze_single_report(video_id, format?, output_path?)`
- `content_discover_account(account_url, platform?, acquire_assets?)`
- `get_content_discover_account_result(discovery_id, include_items?)`
- `content_analyze_account(video_ids[])`
- `get_content_analyze_account_report(account_analysis_id, format?, output_path?)`
- `compare_videos(target_id, reference_ids[])`
- `search_video_memory(query, filters?)`
- `make_recreation_plan(video_id, constraints?)`

## Acquisition

采集层是插件式 fallback。`yt-dlp` 和浏览器媒体适配器提供内置入口；其他可选适配器需要显式配置，未配置时记录为 `skipped`，表示没有执行。

- YouTube：`yt-dlp`
- TikTok：默认 `yt-dlp`；可配置 `VIDEO_LEARNING_TIKTOK_API_CMD`
- 抖音：内置 `playwright-media-sniffer`，复用 read-later 的 Playwright 嗅探思路；可配置 `VIDEO_LEARNING_DOUYIN_API_CMD` 或 `VIDEO_LEARNING_MEDIACRAWLER_CMD` 作为后备
- 小红书：内置 `playwright-media-sniffer`；可配置 `VIDEO_LEARNING_MEDIACRAWLER_CMD` 或 `VIDEO_LEARNING_RES_DOWNLOADER_CMD` 作为后备
- 微信视频号：内置 `playwright-media-sniffer`；可配置 `VIDEO_LEARNING_RES_DOWNLOADER_CMD` 或 `VIDEO_LEARNING_WX_CHANNELS_CMD` 作为后备；仍保留授权录屏/本地文件导入

采集日志会脱敏 URL、cookie、token、Authorization、代理地址。

查看本机 adapter 状态：

```bash
bun run src/cli.ts adapters
```

`./scripts/install_adapters.sh` 可重复运行，会安装项目本地 Python 依赖到 `.venv/`，包括 `yt-dlp`、Python Playwright、TikTokApi、douyin-tiktok-scraper、PySceneDetect/OpenCV、faster-whisper 和 OpenAI SDK，并安装 Playwright Chromium。系统会优先解析项目本地 `.venv/bin/yt-dlp` 和 `scripts/adapters/browser_media_download.py`，所以不要求全局安装 `yt-dlp`。

内置强抓取 wrapper：

```bash
.venv/bin/python scripts/adapters/browser_media_download.py "<URL>"
```

该 wrapper 会用 Chromium 打开页面，增量观察播放器与网络候选，在就绪截止时间内等待可见播放器的媒体。元数据在媒体就绪后读取；不再固定睡眠后点击任意坐标。下载使用每次调用独立的文件路径，失败不会删除以前成功的资产，最后输出 acquisition 可读的 JSON。需要登录态时可指定浏览器 profile：

```bash
export VIDEO_LEARNING_BROWSER_PROFILE_DIR="$HOME/.video-learning/browser-profile"
```

每次调用自动保存独立 `diagnostics/<run_id>/diagnostics.json`，包含阶段、耗时、页面/播放器摘要、候选计数、网络状态和恢复记录；不保存 Cookie、带签名的 URL 查询参数或原始 HTML。配置 `VIDEO_LEARNING_BROWSER_DEBUG_DIR` 可改变诊断根目录并额外保存截图。截图可能含账户界面，应留在本机。`VIDEO_LEARNING_BROWSER_READY_TIMEOUT_MS` 控制首次媒体就绪预算（默认 25 秒，限制 1–60 秒）。主文档或媒体网络失败、导航超时最多再进行一次导航恢复，额外预算不超过 10 秒；仅有原因未知的空候选，以及明确的播放登录门槛、验证挑战、不可用提示，都不会自动重试。

失败结果的 `attempts[].error` 保留 `code`、`phase`、`retryable`、`diagnostics_path` 和 `next_actions`；成功 attempt 也保留诊断路径。这些信息同样进入数据库及账号作品批量获取的失败摘要。MCP 在采集失败时同时返回 `isError: true`，不丢失结构化证据。`no_media_candidates` 表示原因尚不明确，不能解释成视频已删除或账号过期；常驻“登录”按钮也不等于播放被登录门槛拦截。

`get_video_learning_status` 返回实际 `project_root`、`cli_path`、`workspace_dir`、`db_path`、本地依赖和适配器配置，以及 `acquisition_diagnostics_version`。这些状态不证明平台登录或网络连通性。需要 CLI 诊断时，使用返回的绝对入口和同一资料库，保留既有配置。

遇到失败应先读取本次诊断，核对运行时已尝试的恢复和真正可用的备用渠道；`skipped` 不算已尝试，抖音 `strategy: strong` 也不会凭空增加渠道。只有新证据支持时才追加一次外层获取，或核对同一作品的官方镜像。整条视频的内容评价须建立在完整媒体及覆盖全程口播的转写/字幕上；尚未取得正文时，交付实际阻塞和所需协助，不以标题评价代替。

浏览器脚本在每次采集时重新启动，修改后下次调用即生效。已经运行的 MCP 进程不会热加载 TypeScript：重连或新建会话后，`get_video_learning_status.acquisition_diagnostics_version` 应为 `1`。

账号作品发现：

```bash
.venv/bin/python scripts/adapters/douyin_account_discover.py "https://v.douyin.com/..."
```

`content-discover-account` 第一版只支持抖音账号主页。它先读取账号页、作品数和作品列表；发现全量成功后，默认逐条调用采集层把作品下载/导入为本地 `videos` 和 `original_video` assets，返回 `video_ids`、`acquired_count` 和 `asset_failed_count`。这个阶段不运行 STT，也不调用 GLM/MiniMax/OpenAI。发现器只计入抖音作品接口返回的真实作品，不把账号页 SEO/推荐链接当成作品。首页作品数可读时采用严格全量策略：例如页面显示 60 条但只能枚举到 21 条，会保存 `partial` discovery 并让命令失败；错误信息会包含 `discovery_id`，可用 `content-discover-account-result <discovery_id> --out <path>` 取回已发现的部分清单。只想导出作品清单、不下载素材时，加 `--no-acquire`。

抖音账号作品分页接口需要有效登录态。默认 headless 模式如果没有 `sid_guard/sessionid` 等登录 cookie，会保存 `failed` discovery，诊断里标记 `authRequired: true`，不会把空结果或 SEO 链接误报为部分样本。首次使用可用可见浏览器扫码登录，登录态会保存在独立 profile 中：

```bash
bun --env-file=.env.local run src/cli.ts content-discover-account "https://v.douyin.com/..." \
  --login \
  --profile "$HOME/.video-learning/browser-profiles/douyin" \
  --out reports/account-discovery.json
```

扫码登录成功后，后续命令复用同一个 `--profile` 即可 headless 枚举全量作品：

```bash
bun --env-file=.env.local run src/cli.ts content-discover-account "https://v.douyin.com/..." \
  --profile "$HOME/.video-learning/browser-profiles/douyin" \
  --out reports/account-discovery.json
```

如内置 Playwright 发现器无法拿到全量，可配置专用账号作品 wrapper：

```bash
export VIDEO_LEARNING_DOUYIN_ACCOUNT_DISCOVER_CMD="/absolute/path/to/douyin_account_wrapper"
```

该 wrapper 最后一个参数会收到账号 URL，最后一行 stdout 必须是 JSON，例如：

```json
{"platform":"douyin","accountUrl":"https://www.douyin.com/user/...","accountId":"sec_user_id","author":"作者","expectedCount":60,"items":[{"platformVideoId":"123","url":"https://www.douyin.com/video/123","type":"video","description":"标题","author":"作者","durationSec":60}]}
```

复杂平台仍需要你提供可输出 JSON 的 wrapper 命令，因为这些项目的登录态、Cookie、代理和下载路径因账号环境而异。wrapper 最后一个参数会收到 URL，最后一行 stdout 必须是 JSON，例如：

```json
{"path":"/absolute/path/video.mp4","title":"标题","author":"作者","durationSec":360}
```

可配置的 wrapper 环境变量：

```bash
export VIDEO_LEARNING_DOUYIN_API_CMD=".venv/bin/python scripts/adapters/your_douyin_wrapper.py"
export VIDEO_LEARNING_MEDIACRAWLER_CMD="/absolute/path/to/mediacrawler_wrapper"
export VIDEO_LEARNING_RES_DOWNLOADER_CMD="/absolute/path/to/res_downloader_wrapper"
export VIDEO_LEARNING_WX_CHANNELS_CMD="/absolute/path/to/wx_channels_wrapper"
```

项目相对路径会被规范化为绝对路径，避免采集任务在数据工作目录运行时找不到脚本。

### 微信视频号登录态

视频号短链常见失败是媒体 CDN 返回 `401 Unauthorized`。这时需要给内置 `playwright-media-sniffer` 一个已登录的 Chromium profile。

1. 编辑 `.env.local`：

```bash
open -e .env.local
```

至少填写：

```bash
VIDEO_LEARNING_BROWSER_PROFILE_DIR=$HOME/.video-learning/browser-profiles/wechat-channels
```

2. 打开登录浏览器：

```bash
cd /path/to/video-learning
.venv/bin/python scripts/adapters/open_browser_profile.py "https://weixin.qq.com/sph/AQBR0NrBjx" --profile-dir "$HOME/.video-learning/browser-profiles/wechat-channels"
```

在打开的 Chromium 窗口里扫码/确认登录，并播放目标视频一次。完成后回到终端按 Enter 关闭浏览器。

3. 重试采集：

```bash
cd /path/to/video-learning
bun run src/cli.ts acquire "https://weixin.qq.com/sph/AQBR0NrBjx" --platform wechat_channels --strategy strong
```

如果登录 profile 后仍然是 `401 Unauthorized`，说明网页 Cookie 仍不足以直接下载 CDN 资源，需要配置专用本地代理/嗅探工具 wrapper，例如：

```bash
VIDEO_LEARNING_WX_CHANNELS_CMD=/absolute/path/to/wx_channels_wrapper
```

wrapper 最后一个参数会收到 URL，最后一行 stdout 必须输出：

```json
{"path":"/absolute/path/video.mp4","title":"标题","durationSec":123}
```

## Analysis

本地 worker 位于 `scripts/video_worker.py`。基础处理只依赖 `ffmpeg`/`ffprobe`；真实 STT 使用项目 `.venv` 里的 `faster-whisper`。

- 探测时长
- 抽取音频
- 尝试基于 scene change 切镜
- 失败时按时长启发式分段
- 抽关键帧
- 读取同名 `.srt` / `.vtt` 字幕作为转写 fallback
- 无字幕时默认使用 `faster-whisper` 做本地 STT；静音音轨会跳过，避免无意义加载模型
- 可通过 `VIDEO_LEARNING_STT_CMD` 接入外部 STT 命令；命令最后一个参数会收到抽取出的音频路径，stdout 需要返回 JSON segments

STT 配置：

```bash
# 默认值；可省略
export VIDEO_LEARNING_STT_ENGINE=faster-whisper

# 首次使用会下载模型。tiny/base/small/medium 按速度和准确率取舍，默认 small
export VIDEO_LEARNING_STT_MODEL=small

# Apple Silicon/CPU 默认用 cpu + int8；有明确 GPU 环境再改
export VIDEO_LEARNING_STT_DEVICE=cpu
export VIDEO_LEARNING_STT_COMPUTE_TYPE=int8

# 已知语言时建议固定，中文可用 zh；不设置则自动识别
export VIDEO_LEARNING_STT_LANGUAGE=zh

# 完全关闭本地 STT
export VIDEO_LEARNING_STT_ENGINE=off

# 覆盖 worker Python；默认优先使用项目 .venv/bin/python
export VIDEO_LEARNING_PYTHON=/absolute/path/to/python
```

如果设置云端视觉模型，`deep-analyze-single` 会对关键帧做 VLM 增强。没有视觉模型或转写证据时，报告会明确标注“证据不足”，不会编造景别、构图、运镜或口播内容。

DashScope / Qwen3.6-Plus：

```bash
export VIDEO_LEARNING_VISION_PROVIDER=dashscope
export DASHSCOPE_API_KEY=sk-xxx
export VIDEO_LEARNING_VISION_MODEL=qwen3.6-plus

# 默认北京地域 OpenAI-compatible endpoint；国际站可改为 dashscope-intl
export DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

OpenAI：

```bash
export VIDEO_LEARNING_VISION_PROVIDER=openai
export OPENAI_API_KEY=sk-xxx
export VIDEO_LEARNING_VISION_MODEL=gpt-4.1-mini
```

内容分析文本模型：

```bash
# 可选。未设置时会优先使用 GLM/MiniMax key，然后复用视觉 provider/model 和对应 API key；无 key 时使用本地低置信度整理
export VIDEO_LEARNING_TEXT_PROVIDER=openai
export VIDEO_LEARNING_TEXT_MODEL=gpt-4.1-mini

# 或使用 DashScope
export VIDEO_LEARNING_TEXT_PROVIDER=dashscope
export VIDEO_LEARNING_TEXT_MODEL=qwen3.6-plus

# GLM primary + MiniMax fallback；这条路径不会调用 OpenAI API
export VIDEO_LEARNING_TEXT_PROVIDER=glm
export VIDEO_LEARNING_TEXT_FALLBACK_PROVIDER=minimax
export GLM_API_KEY=your-glm-or-zai-key
export GLM_BASE_URL=https://api.z.ai/api/paas/v4
export VIDEO_LEARNING_GLM_MODEL=glm-5.1
export MINIMAX_API_KEY=your-minimax-key
export MINIMAX_BASE_URL=https://api.minimax.io/v1
export VIDEO_LEARNING_MINIMAX_MODEL=MiniMax-M2.7-highspeed

# MiniMax 中国区 token-plan 可改用：
export MINIMAX_CN_API_KEY=your-minimax-cn-key
export MINIMAX_BASE_URL=https://api.minimaxi.com/v1

# 完全关闭文本模型增强
export VIDEO_LEARNING_TEXT_PROVIDER=off
```

通用限制：

```bash
# 默认每次最多分析 12 张关键帧；设为 all 可覆盖全部关键帧
export VIDEO_LEARNING_CLOUD_FRAME_LIMIT=12

# 默认每批提交 8 张关键帧，降低长视频单次请求过大导致失败的概率
export VIDEO_LEARNING_CLOUD_BATCH_SIZE=8

# 默认单个云视觉请求 120 秒超时，失败批次会跳过并记录 stderr
export VIDEO_LEARNING_CLOUD_REQUEST_TIMEOUT_MS=120000

# 报告命令无 --out 时的 stdout 安全上限；超限会失败并提示使用 --out
export VIDEO_LEARNING_CLI_MAX_STDOUT_BYTES=12000
```

## Output Standard

报告规范见 [`docs/report-standard.md`](docs/report-standard.md)。真实分析报告默认输出到 `reports/`，该目录下生成的 Markdown 报告不会提交到 Git；只提交报告规范和目录说明。

深度拉片报告必须包含：

- 前 3 秒 hook 拆解
- 全片结构
- 逐镜头表
- 节奏指标
- 复拍方案
- 风险提示

禁止只输出泛泛总结。

内容分析报告必须只引用转写时间段，包含主题、受众、内容 hook、内容结构、核心论点、关键表达、关键词、可复用内容框架和风险提示；不得包含景别、运镜、逐镜头表或复拍镜头清单。

账号级内容分析报告必须只引用传入视频的 single 内容分析和转写证据，包含账号定位、目标受众、内容支柱、hook 模式、论点结构、关键词、代表视频、可复用模板、机会点和风险提示；任一视频缺少非空转写证据时直接失败；每条账号级策略结论都必须附带参与视频 id 和 transcript 时间段；不做账号主页抓取、自动下载或跨账号对比。
