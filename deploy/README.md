# Kiosk deployment

This repo now contains:

- `server.py` - local buffer, snapshot writer, static file server, health endpoints
- `scripts/start-kiosk.sh` - Chromium kiosk launcher
- `deploy/systemd/zditm-board.service` - local board service
- `deploy/systemd/zditm-kiosk.service` - kiosk browser service

Install flow on the target Linux kiosk:

1. Copy the repo to the final path.
2. Adjust `User`, `Group`, `DISPLAY`, `XAUTHORITY`, and paths in both service files if needed.
3. Copy the units into `/etc/systemd/system/`.
4. Run `sudo systemctl daemon-reload`.
5. Enable the services:
   - `sudo systemctl enable --now zditm-board.service`
   - `sudo systemctl enable --now zditm-kiosk.service`
6. Check health:
   - `curl http://127.0.0.1:8080/health/live`
   - `curl http://127.0.0.1:8080/health/ready`
