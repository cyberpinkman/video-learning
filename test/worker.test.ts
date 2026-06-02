import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "video-learning-worker-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

test("python worker probes video, extracts keyframes, and emits shot evidence", async () => {
  const videoPath = join(workdir, "synthetic.mp4");
  const outDir = join(workdir, "artifacts");
  const ffmpeg = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=6:size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=mono:sample_rate=16000",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await ffmpeg.exited).toBe(0);

  const worker = Bun.spawn({
    cmd: ["python3", "scripts/video_worker.py", "analyze", videoPath, "--out-dir", outDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(worker.stdout).text();
  const stderr = await new Response(worker.stderr).text();
  expect(await worker.exited, stderr).toBe(0);
  const result = JSON.parse(stdout);

  expect(result.durationSec).toBeGreaterThan(5);
  expect(result.shots.length).toBeGreaterThan(0);
  expect(existsSync(result.shots[0].keyframePath)).toBe(true);
});

test("python worker does not invent visual attributes without model evidence", async () => {
  const videoPath = join(workdir, "synthetic-no-inference.mp4");
  const outDir = join(workdir, "artifacts-no-inference");
  const ffmpeg = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=3:size=320x180:rate=24",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await ffmpeg.exited).toBe(0);

  const worker = Bun.spawn({
    cmd: ["python3", "scripts/video_worker.py", "analyze", videoPath, "--out-dir", outDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(worker.stdout).text();
  const stderr = await new Response(worker.stderr).text();
  expect(await worker.exited, stderr).toBe(0);
  const result = JSON.parse(stdout);

  expect(result.shots[0].shotSize).toBe("");
  expect(result.shots[0].cameraMotion).toBe("");
  expect(result.shots[0].composition).toBe("");
  expect(result.shots[0].visualSummary).toContain("证据不足");
});

test("python worker imports sidecar VTT subtitles as transcript evidence", async () => {
  const videoPath = join(workdir, "with-subtitles.mp4");
  const vttPath = join(workdir, "with-subtitles.vtt");
  const outDir = join(workdir, "artifacts-vtt");
  const ffmpeg = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=3:size=320x180:rate=24",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await ffmpeg.exited).toBe(0);
  writeFileSync(vttPath, "WEBVTT\n\n00:00.000 --> 00:02.000\n前三秒直接说清楚承诺\n");

  const worker = Bun.spawn({
    cmd: ["python3", "scripts/video_worker.py", "analyze", videoPath, "--out-dir", outDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(worker.stdout).text();
  const stderr = await new Response(worker.stderr).text();
  expect(await worker.exited, stderr).toBe(0);
  const result = JSON.parse(stdout);

  expect(result.transcript).toHaveLength(1);
  expect(result.transcript[0].text).toBe("前三秒直接说清楚承诺");
  expect(result.transcript[0].wordsPerMinute).toBeGreaterThan(0);
});

test("python worker can transcribe audio with built-in faster-whisper", async () => {
  const videoPath = join(workdir, "with-speech.mp4");
  const outDir = join(workdir, "artifacts-stt");
  const fakePythonPath = join(workdir, "fake-pythonpath");
  const fakeModule = join(fakePythonPath, "faster_whisper.py");
  await Bun.write(fakeModule, `
class Segment:
    def __init__(self, start, end, text):
        self.start = start
        self.end = end
        self.text = text

class WhisperModel:
    def __init__(self, model_size, device="cpu", compute_type="int8"):
        self.model_size = model_size

    def transcribe(self, audio_path, language=None, vad_filter=True):
        return [Segment(0.25, 1.4, "真实 STT 已接入")], {"language": "zh"}
`);

  const ffmpeg = Bun.spawn({
    cmd: [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=320x180:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=2:sample_rate=16000",
      "-shortest",
      "-pix_fmt",
      "yuv420p",
      videoPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await ffmpeg.exited).toBe(0);

  const worker = Bun.spawn({
    cmd: ["python3", "scripts/video_worker.py", "analyze", videoPath, "--out-dir", outDir],
    env: {
      ...process.env,
      PYTHONPATH: fakePythonPath,
      VIDEO_LEARNING_STT_ENGINE: "faster-whisper",
      VIDEO_LEARNING_STT_MODEL: "tiny",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(worker.stdout).text();
  const stderr = await new Response(worker.stderr).text();
  expect(await worker.exited, stderr).toBe(0);
  const result = JSON.parse(stdout);

  expect(result.transcript).toHaveLength(1);
  expect(result.transcript[0].startSec).toBe(0.25);
  expect(result.transcript[0].endSec).toBe(1.4);
  expect(result.transcript[0].text).toBe("真实 STT 已接入");
  expect(result.transcript[0].wordsPerMinute).toBeGreaterThan(0);
});
