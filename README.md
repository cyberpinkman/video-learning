# video-learning

独立本地视频学习系统。目标是把长视频拆成可复拍的证据链：采集、转码、切镜、抽关键帧、转写、云端视觉增强、报告、MCP 工具和 Codex/Hermes skill。

不依赖、不读取、不集成 GBrain。

## Quick Start

```bash
bun install
./scripts/install_adapters.sh
cp .env.example .env.local
bun test

# 导入本地视频或授权录屏
bun run src/cli.ts ingest /path/to/video.mp4 --platform local

# 分析视频。没有 OPENAI_API_KEY 时仍会用本地 ffmpeg/ffprobe 生成镜头证据
bun run src/cli.ts analyze <video_id>

# 输出复拍级报告
bun run src/cli.ts report <video_id> --format full

# 稳定交付：把数据库/素材放项目本地持久工作区，把 Markdown 报告写入 reports/
PROJECT_HOME="$PWD"
VL_HOME="$PROJECT_HOME/.video-learning-data"
bun run src/cli.ts analyze <video_id> --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite"
bun run src/cli.ts report <video_id> --format full --workspace "$VL_HOME" --db "$VL_HOME/video-learning.sqlite" --out "$PROJECT_HOME/reports/<video_id>-full.md"

# 启动 MCP stdio server
bun run src/cli.ts mcp
```

默认数据目录：`~/.video-learning/`。

交付规则：

- `/tmp` 只允许用于一次性 smoke test，不作为报告、数据库或可审阅产物的保存位置。
- 可复查产物必须放在稳定路径：数据库/下载/关键帧放 `.video-learning-data/` 或 `~/.video-learning/`，Markdown 报告放 `reports/`。
- `report --out <path>` 会把可读 Markdown 写到指定文件。
- `report` 不会再为不存在的 `--db` 路径静默创建空库；缺失数据库会直接失败。

## Tools

MCP 工具：

- `acquire_video(url, platform?, strategy?)`
- `ingest_video_file(path, platform?, source_url?)`
- `analyze_video(video_id, depth?)`
- `get_video_report(video_id, format?)`
- `compare_videos(target_id, reference_ids[])`
- `search_video_memory(query, filters?)`
- `make_recreation_plan(video_id, constraints?)`

## Acquisition

采集层是插件式 fallback，不把强抓取写死进核心。只有 `yt-dlp` 路径默认可直接执行；其他平台 adapter 必须显式配置命令，否则会记录为 `skipped`，不会假装已支持。

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

该 wrapper 会用 Chromium 打开页面，从 `<video>`、页面脚本和网络响应中嗅探视频直链，下载到当前工作目录的 `downloads/`，最后输出 acquisition 可读的 JSON。需要登录态时可指定浏览器 profile：

```bash
export VIDEO_LEARNING_BROWSER_PROFILE_DIR="$HOME/.video-learning/browser-profile"
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

如果设置云端视觉模型，`analyze_video` 会对关键帧做 VLM 增强。没有视觉模型或转写证据时，报告会明确标注“证据不足”，不会编造景别、构图、运镜或口播内容。

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

通用限制：

```bash
# 默认每次最多分析 12 张关键帧；设为 all 可覆盖全部关键帧
export VIDEO_LEARNING_CLOUD_FRAME_LIMIT=12

# 默认每批提交 8 张关键帧，降低长视频单次请求过大导致失败的概率
export VIDEO_LEARNING_CLOUD_BATCH_SIZE=8

# 默认单个云视觉请求 120 秒超时，失败批次会跳过并记录 stderr
export VIDEO_LEARNING_CLOUD_REQUEST_TIMEOUT_MS=120000
```

## Output Standard

报告规范见 [`docs/report-standard.md`](docs/report-standard.md)。真实分析报告默认输出到 `reports/`，该目录下生成的 Markdown 报告不会提交到 Git；只提交报告规范和目录说明。

报告必须包含：

- 前 3 秒 hook 拆解
- 全片结构
- 逐镜头表
- 节奏指标
- 复拍方案
- 风险提示

禁止只输出泛泛总结。
