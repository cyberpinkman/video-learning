# reports

Generated video reports are local deliverables and are intentionally ignored by Git.

Use this directory for real analysis outputs:

```bash
bun run src/cli.ts report <video_id> \
  --format full \
  --workspace .video-learning-data \
  --db .video-learning-data/video-learning.sqlite \
  --out reports/<video_id>-full.md
```

Do not commit reports containing private videos, account context, downloaded media paths, cookies, tokens, proxy addresses, or customer-specific production plans.

The report output standard is versioned in [`../docs/report-standard.md`](../docs/report-standard.md).
