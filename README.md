# Famtube

A private, YouTube-style video app for your family, built as an **iPhone-first PWA**. Upload videos from your phone, watch them anywhere, like and comment. Everything stays on your own server.

## What it does
- **Home feed** of family videos with thumbnails, durations, view counts
- **Watch page**: inline playback (`playsinline`), resume where you left off, like, share, comments, "Up next"
- **Add** a video straight from the camera roll, with upload progress
- **Search**, **profile pages** per person, and a **You** tab with your videos and likes
- **Family code + your name** to sign in (no emails or passwords to forget)
- iPhone `.mov`/HEVC uploads are converted to H.264 MP4 with ffmpeg so they play on every device
- Dark/light mode, safe-area aware, installable on the Home Screen

## Run it
```bash
FAMILY_PIN=1234 npm start      # http://localhost:3000, needs Node 18+, ffmpeg recommended
```
Or with Docker / ZimaOS: edit `FAMILY_PIN` in `docker-compose.yml`, then `docker compose up -d`. Data lives in the `/data` volume.

| Variable | Default | Meaning |
|---|---|---|
| `FAMILY_PIN` | `1234` | Code everyone types to get in. **Change it.** |
| `MAX_UPLOAD_MB` | `4096` | Largest single upload |
| `DATA_DIR` | `./data` | Where videos and the database are kept |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so rate limiting sees real IPs |

## Put it on iPhones
1. Open the app's address in **Safari**.
2. Share button → **Add to Home Screen**.

iPhones need **HTTPS** for the PWA to install and for the service worker. Away from home, put the server behind HTTPS with a Cloudflare Tunnel, Tailscale (Serve/Funnel), or a reverse proxy, and set `TRUST_PROXY=1`.

## Notes
- The first person to sign in is the admin and can remove anyone's videos or comments.
- Anyone with the family code can sign in as any name. It is built for trust inside a family, not the public internet.
- Tests: `npm test`.
