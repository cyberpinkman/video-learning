#!/usr/bin/env python3
import argparse
import json
import math
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path


def run(cmd):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def ffprobe_duration(video_path):
    proc = run([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        video_path,
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ffprobe failed")
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def scene_times(video_path):
    proc = run([
        "ffmpeg",
        "-hide_banner",
        "-i",
        video_path,
        "-filter:v",
        "select='gt(scene,0.35)',showinfo",
        "-f",
        "null",
        "-",
    ])
    text = proc.stderr
    times = []
    for match in re.finditer(r"pts_time:([0-9.]+)", text):
        try:
            value = float(match.group(1))
            if value > 0.2:
                times.append(value)
        except ValueError:
            pass
    deduped = []
    for value in sorted(times):
        if not deduped or value - deduped[-1] > 1.0:
            deduped.append(value)
    return deduped


def heuristic_boundaries(duration, max_segments):
    if duration <= 0:
        return [0.0, 5.0]
    segment = 4.0 if duration <= 60 else 6.0
    count = min(max(1, math.ceil(duration / segment)), max_segments)
    boundaries = [0.0]
    for i in range(1, count):
        boundaries.append(round(duration * i / count, 3))
    boundaries.append(duration)
    return boundaries


def boundaries_from_scenes(duration, scenes, max_segments):
    usable = [time for time in scenes if 0 < time < duration]
    if len(usable) < 2:
        return heuristic_boundaries(duration, max_segments)
    boundaries = [0.0] + usable + [duration]
    compact = [boundaries[0]]
    for value in boundaries[1:]:
        if value - compact[-1] >= 0.75:
            compact.append(value)
    if compact[-1] < duration:
        compact.append(duration)
    if len(compact) - 1 > max_segments:
        return heuristic_boundaries(duration, max_segments)
    return compact


def extract_keyframe(video_path, output_path, at_sec):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    proc = run([
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{max(0, at_sec):.3f}",
        "-i",
        video_path,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(output_path),
    ])
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"keyframe extraction failed at {at_sec}")


def extract_audio(video_path, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    proc = run([
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-y",
        str(output_path),
    ])
    return proc.returncode == 0


def audio_has_signal(audio_path):
    proc = run([
        "ffmpeg",
        "-hide_banner",
        "-i",
        str(audio_path),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
    ])
    text = proc.stderr
    match = re.search(r"mean_volume:\s*(-?inf|-?\d+(?:\.\d+)?) dB", text)
    if not match:
        return True
    value = match.group(1)
    if value == "-inf":
        return False
    try:
        return float(value) > -55
    except ValueError:
        return True


def analyze(video_path, out_dir, max_shots):
    duration = ffprobe_duration(video_path)
    out = Path(out_dir)
    keyframes_dir = out / "keyframes"
    audio_path = out / "audio.wav"
    audio_ok = extract_audio(video_path, audio_path)
    boundaries = boundaries_from_scenes(duration, scene_times(video_path), max_shots)
    shots = []
    for index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        midpoint = start + max(0.1, (end - start) / 2)
        keyframe = keyframes_dir / f"shot_{index + 1:04d}.jpg"
        extract_keyframe(video_path, keyframe, min(midpoint, max(0, duration - 0.05)))
        shots.append({
            "startSec": round(start, 3),
            "endSec": round(end, 3),
            "keyframePath": str(keyframe),
            "visualSummary": "证据不足：仅完成关键帧抽取，尚未经过视觉模型分析。",
            "shotSize": "",
            "cameraMotion": "",
            "composition": "",
            "subtitles": "",
            "audioRole": "待转写/待识别",
            "purpose": "承接信息、维持节奏或提供视觉证据",
        })
    assets = []
    if audio_ok:
        assets.append({
            "kind": "audio",
            "path": str(audio_path),
            "mimeType": "audio/wav",
            "metadata": {"sampleRate": 16000},
        })
    for shot in shots:
        assets.append({
            "kind": "keyframe",
            "path": shot["keyframePath"],
            "mimeType": "image/jpeg",
            "metadata": {"startSec": shot["startSec"], "endSec": shot["endSec"]},
        })
    transcript = []
    sidecar_srt = Path(video_path).with_suffix(".srt")
    sidecar_vtt = Path(video_path).with_suffix(".vtt")
    if sidecar_srt.exists():
        transcript = parse_srt(sidecar_srt)
    elif sidecar_vtt.exists():
        transcript = parse_vtt(sidecar_vtt)
    elif audio_ok:
        transcript = transcribe_audio(audio_path)
    return {
        "durationSec": duration,
        "assets": assets,
        "shots": shots,
        "transcript": transcript,
    }


def parse_timestamp(value):
    hours, minutes, rest = value.split(":")
    seconds, millis = rest.split(",")
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def parse_srt(path):
    text = path.read_text(encoding="utf-8", errors="ignore")
    blocks = re.split(r"\n\s*\n", text.strip())
    segments = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 2:
            continue
        time_line = next((line for line in lines if "-->" in line), "")
        if not time_line:
            continue
        start_raw, end_raw = [part.strip() for part in time_line.split("-->", 1)]
        content = " ".join(line for line in lines if line != time_line and not line.isdigit())
        if not content:
            continue
        start = parse_timestamp(start_raw)
        end = parse_timestamp(end_raw.split()[0])
        words = re.findall(r"\w+", content)
        minutes = max((end - start) / 60, 0.01)
        segments.append({
            "startSec": start,
            "endSec": end,
            "speaker": "S1",
            "text": content,
            "wordsPerMinute": len(words) / minutes,
            "keywords": words[:8],
        })
    return segments


def parse_vtt(path):
    text = path.read_text(encoding="utf-8", errors="ignore")
    text = re.sub(r"^WEBVTT.*?\n", "", text, flags=re.S)
    blocks = re.split(r"\n\s*\n", text.strip())
    segments = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        time_line = next((line for line in lines if "-->" in line), "")
        if not time_line:
            continue
        start_raw, end_raw = [part.strip() for part in time_line.split("-->", 1)]
        content = " ".join(line for line in lines if line != time_line and not line.startswith("NOTE"))
        if not content:
            continue
        start = parse_vtt_timestamp(start_raw)
        end = parse_vtt_timestamp(end_raw.split()[0])
        words = re.findall(r"\w+", content)
        minutes = max((end - start) / 60, 0.01)
        segments.append({
            "startSec": start,
            "endSec": end,
            "speaker": "S1",
            "text": content,
            "wordsPerMinute": len(words) / minutes,
            "keywords": words[:8],
        })
    return segments


def parse_vtt_timestamp(value):
    parts = value.replace(",", ".").split(":")
    if len(parts) == 2:
        minutes, rest = parts
        hours = 0
    else:
        hours, minutes, rest = parts
    if "." in rest:
        seconds, millis = rest.split(".", 1)
        fraction = float("0." + re.sub(r"\D", "", millis))
    else:
        seconds = rest
        fraction = 0
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + fraction


def transcript_segment(start, end, text, speaker="S1"):
    content = str(text).strip()
    words = re.findall(r"\w+", content)
    if not words:
        words = re.findall(r"[\u4e00-\u9fff]", content)
    minutes = max((float(end) - float(start)) / 60, 0.01)
    return {
        "startSec": float(start),
        "endSec": float(end),
        "speaker": speaker,
        "text": content,
        "wordsPerMinute": len(words) / minutes,
        "keywords": words[:8],
    }


def normalize_transcript_segments(segments):
    out = []
    for item in segments:
        if not item.get("text"):
            continue
        out.append(transcript_segment(
            item.get("startSec", item.get("start", 0)),
            item.get("endSec", item.get("end", 0)),
            item.get("text", ""),
            item.get("speaker", "S1"),
        ))
        if item.get("wordsPerMinute") is not None:
            out[-1]["wordsPerMinute"] = item.get("wordsPerMinute")
        if item.get("keywords") is not None:
            out[-1]["keywords"] = item.get("keywords")
    return out


def transcribe_audio(audio_path):
    cmd_segments = transcribe_with_optional_command(audio_path)
    if cmd_segments:
        return cmd_segments
    engine = os.environ.get("VIDEO_LEARNING_STT_ENGINE", "faster-whisper").strip().lower()
    if engine in {"", "off", "none", "false", "0"}:
        return []
    if engine in {"faster-whisper", "faster_whisper", "local", "auto"}:
        if not audio_has_signal(audio_path):
            return []
        return transcribe_with_faster_whisper(audio_path)
    return []


def transcribe_with_optional_command(audio_path):
    cmd_template = os.environ.get("VIDEO_LEARNING_STT_CMD")
    if not cmd_template:
        return []
    proc = run(shlex.split(cmd_template) + [str(audio_path)])
    if proc.returncode != 0:
        return []
    text = proc.stdout.strip()
    if not text:
        return []
    try:
        parsed = json.loads(text)
        segments = parsed.get("segments", parsed) if isinstance(parsed, dict) else parsed
        if isinstance(segments, list):
            return normalize_transcript_segments(segments)
    except Exception:
        pass
    return []


def transcribe_with_faster_whisper(audio_path):
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(f"[stt] faster-whisper unavailable: {exc}", file=sys.stderr)
        return []
    model_size = os.environ.get("VIDEO_LEARNING_STT_MODEL", "small")
    device = os.environ.get("VIDEO_LEARNING_STT_DEVICE", "cpu")
    compute_type = os.environ.get("VIDEO_LEARNING_STT_COMPUTE_TYPE", "int8")
    language = os.environ.get("VIDEO_LEARNING_STT_LANGUAGE") or None
    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        segments, _info = model.transcribe(str(audio_path), language=language, vad_filter=True)
        out = []
        for segment in segments:
            text = getattr(segment, "text", "").strip()
            if not text:
                continue
            out.append(transcript_segment(
                getattr(segment, "start", 0),
                getattr(segment, "end", 0),
                text,
            ))
        return out
    except Exception as exc:
        print(f"[stt] faster-whisper failed: {exc}", file=sys.stderr)
        return []


def main(argv):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    analyze_parser = sub.add_parser("analyze")
    analyze_parser.add_argument("video_path")
    analyze_parser.add_argument("--out-dir", required=True)
    analyze_parser.add_argument("--max-shots", type=int, default=120)
    args = parser.parse_args(argv)
    if args.command == "analyze":
        print(json.dumps(analyze(args.video_path, args.out_dir, args.max_shots), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
