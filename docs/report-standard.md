# Video Learning Report Standard

This document defines the required output shape for analysis reports. It is safe to publish; real generated reports are local deliverables and should stay under `reports/`, which is ignored by Git.

## Storage rules

- Persist databases and generated assets under `.video-learning-data/` or `~/.video-learning/`.
- Persist readable Markdown reports under `reports/`.
- Never use `/tmp` as a delivery location.
- Never commit generated reports, downloaded videos, audio, subtitles, keyframes, SQLite databases, browser profiles, cookies, tokens, proxy addresses, or account identifiers.
- Reports may mention a public source URL, platform, title, author, and timestamps. They must not expose local secrets or authenticated request details.

## Required report sections

Every long-video report must include the sections below. The report may add domain-specific sections, but it must not omit these.

1. Metadata
   - Platform.
   - Source URL if public and safe to include.
   - Title.
   - Author.
   - Published date if available.
   - Duration.
   - Analysis timestamp.
   - Evidence status: visual, transcript, audio, model provider.
   - Confidence labels.

2. First 3 seconds hook
   - Timestamped shot-by-shot breakdown for the first 3 seconds.
   - Visible subject, action, framing, subtitle/audio evidence, and purpose.
   - A reusable hook formula.
   - A rewritten hook recommendation for a new production.

3. Full-video structure
   - Timeline modules with start/end timestamps.
   - Shot ranges per module.
   - Narrative function.
   - Practical shooting implication.
   - Confidence label per module.

4. Shot table
   - Timestamp.
   - Visual description.
   - Shot size.
   - Camera motion.
   - Subtitle/audio evidence.
   - Function in the edit.
   - Recreation instruction.
   - Evidence reference.

5. Rhythm metrics
   - Total shots.
   - Average shot duration.
   - Longest shot and warning if longer than 20 seconds.
   - Subtitle density if transcript is reliable.
   - Speech rate if transcript is reliable.
   - B-roll or POV ratio when measurable.
   - Any metric with weak evidence must be marked low confidence.

6. Production recreation plan
   - Rewritten concept.
   - Script skeleton.
   - Required cast.
   - Locations.
   - Props.
   - Wardrobe.
   - Lighting.
   - Shooting order by location.
   - Edit order.
   - Minimal low-cost version.

7. Risk and adaptation notes
   - What can be structurally copied.
   - What should only be borrowed.
   - What must be replaced.
   - Copyright, music, brand, product-claim, privacy, platform, and safety risks.

8. Evidence and quality self-check
   - List unsupported or low-confidence claims.
   - List missing evidence.
   - Confirm that every key conclusion maps to a timestamp, shot, or transcript segment.
   - Confirm that secrets and local authentication data are absent.

## Markdown formatting rules

- Escape multiline table cells with `<br>` instead of raw newlines.
- Keep shot-table rows valid Markdown tables.
- Use `HH:MM:SS.mmm` timestamps when possible.
- Use concise, executable language. Avoid generic praise such as "high quality", "strong style", or "good rhythm" unless followed by measurable evidence.
- Do not claim ASR output is accurate unless it has been reviewed. Use "transcript draft" when the transcript is machine-generated.
- Mark confidence as `high`, `medium`, `low`, or `unknown`.

## Confidence labels

- `high`: Directly supported by timestamps, visual descriptions, transcript, or measured metrics.
- `medium`: Reasonable inference from multiple evidence points, but not directly measured.
- `low`: Plausible but weakly supported, or dependent on machine-generated transcript/visual descriptions.
- `unknown`: Insufficient evidence.

## Report CLI examples

Generate a full report:

```bash
bun run src/cli.ts report <video_id> \
  --format full \
  --workspace .video-learning-data \
  --db .video-learning-data/video-learning.sqlite \
  --out reports/<video_id>-full.md
```

Generate a shooting brief:

```bash
bun run src/cli.ts report <video_id> \
  --format shooting_brief \
  --workspace .video-learning-data \
  --db .video-learning-data/video-learning.sqlite \
  --out reports/<video_id>-shooting-brief.md
```

Open-source repositories should commit this standard, not the generated reports.
