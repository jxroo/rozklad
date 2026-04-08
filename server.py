from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
SNAPSHOT_PATH = DATA_DIR / "last-board.json"

STOPS_API_URL = "https://www.zditm.szczecin.pl/api/v1/stops"
DISPLAY_API_BASE_URL = "https://www.zditm.szczecin.pl/api/v1/displays/"
TARGET_STOP_NAMES = ["Starkiewicza", "Osiedle Polonia", "Dunikowskiego", "Plac Szyrockiego"]
GROUP_ORDER = ["Starkiewicza", "Osiedle Polonia", "Dunikowskiego", "Plac Szyrockiego"]

MAX_ROWS_PER_GROUP = 10
REFRESH_INTERVAL_SECONDS = 30
STOPS_REFRESH_INTERVAL_SECONDS = 6 * 60 * 60
REQUEST_TIMEOUT_SECONDS = 5
MAX_CONCURRENT_REQUESTS = 4
STALE_AFTER_SECONDS = 120

DEFAULT_HOST = os.environ.get("ZDITM_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("ZDITM_PORT", "8080"))

LOGGER = logging.getLogger("zditm-board")


def normalize_stop_name(name: str) -> str:
    return "".join(
        character
        for character in unicodedata_normalize("NFD", str(name))
        if not is_diacritic(character)
    )


def unicodedata_normalize(form: str, value: str) -> str:
    import unicodedata

    return unicodedata.normalize(form, value)


def is_diacritic(character: str) -> bool:
    import unicodedata

    return unicodedata.category(character) == "Mn"


def utc_iso(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def safe_json_dump(path: Path, payload: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
      json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, path)


@dataclass
class FetchResult:
    stop_number: str
    platform: dict[str, Any] | None = None
    retry_after_seconds: int | None = None
    error: str | None = None


class BoardState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.stop_groups: list[dict[str, Any]] = []
        self.platforms: dict[str, dict[str, Any]] = {}
        self.last_successful_refresh_at: float | None = None
        self.last_attempt_at: float | None = None
        self.loaded_from_snapshot = False

    def load_snapshot(self) -> None:
        if not SNAPSHOT_PATH.exists():
            return

        try:
            with SNAPSHOT_PATH.open("r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            LOGGER.warning("Cannot read snapshot: %s", exc)
            return

        stop_groups = payload.get("stopGroups")
        platforms = payload.get("platforms")
        last_refresh = payload.get("lastSuccessfulRefreshAt")
        if not isinstance(stop_groups, list) or not isinstance(platforms, dict):
            LOGGER.warning("Snapshot has invalid shape; ignoring it.")
            return

        with self.lock:
            self.stop_groups = stop_groups
            self.platforms = platforms
            self.last_successful_refresh_at = float(last_refresh) if isinstance(last_refresh, (int, float)) else None
            self.loaded_from_snapshot = True

    def set_stop_groups(self, stop_groups: list[dict[str, Any]]) -> None:
        with self.lock:
            previous_platforms = self.platforms
            next_platforms: dict[str, dict[str, Any]] = {}

            for group in stop_groups:
                for stop in group["stops"]:
                    next_platforms[stop["number"]] = previous_platforms.get(
                        stop["number"],
                        {
                            "departures": [],
                            "updatedAt": None,
                        },
                    )

            self.stop_groups = stop_groups
            self.platforms = next_platforms

    def get_stop_groups(self) -> list[dict[str, Any]]:
        with self.lock:
            return json.loads(json.dumps(self.stop_groups))

    def get_all_stops(self) -> list[dict[str, str]]:
        with self.lock:
            return [
                {"number": stop["number"], "name": group["name"]}
                for group in self.stop_groups
                for stop in group["stops"]
            ]

    def update_platform(self, stop_number: str, platform: dict[str, Any]) -> None:
        with self.lock:
            self.platforms[stop_number] = platform

    def mark_attempt(self) -> None:
        with self.lock:
            self.last_attempt_at = time.time()

    def mark_success(self) -> None:
        with self.lock:
            self.last_successful_refresh_at = time.time()
            self.loaded_from_snapshot = False

    def snapshot_payload(self) -> dict[str, Any]:
        with self.lock:
            return {
                "stopGroups": self.stop_groups,
                "platforms": self.platforms,
                "lastSuccessfulRefreshAt": self.last_successful_refresh_at,
            }

    def persist_snapshot(self) -> None:
        safe_json_dump(SNAPSHOT_PATH, self.snapshot_payload())

    def build_board_payload(self) -> dict[str, Any]:
        with self.lock:
            now = time.time()
            stale = (
                self.last_successful_refresh_at is None
                or (now - self.last_successful_refresh_at) > STALE_AFTER_SECONDS
            )

            groups = self.stop_groups or [{"name": name, "stops": []} for name in GROUP_ORDER]
            payload_groups = []

            for group in groups:
                departures: list[dict[str, Any]] = []
                for stop in group["stops"]:
                    platform = self.platforms.get(stop["number"], {})
                    departures.extend(platform.get("departures", []))

                departures.sort(
                    key=lambda item: (
                        item.get("sortMinutes", 10**9),
                        item.get("lineNumber", ""),
                        item.get("direction", ""),
                    )
                )

                rows = departures[:MAX_ROWS_PER_GROUP]
                if not rows:
                    rows = [
                        {
                            "lineNumber": "—",
                            "direction": "Brak odjazdów" if index == 0 else "",
                            "displayTime": "—",
                            "isEmpty": True,
                        }
                        for index in range(MAX_ROWS_PER_GROUP)
                    ]
                else:
                    rows = [
                        {
                            "lineNumber": row["lineNumber"],
                            "direction": row["direction"],
                            "displayTime": row["displayTime"],
                            "isEmpty": False,
                        }
                        for row in rows
                    ]
                    while len(rows) < MAX_ROWS_PER_GROUP:
                        rows.append(
                            {
                                "lineNumber": "—",
                                "direction": "",
                                "displayTime": "—",
                                "isEmpty": True,
                            }
                        )

                payload_groups.append(
                    {
                        "name": group["name"],
                        "rows": rows,
                    }
                )

            return {
                "generatedAt": utc_iso(now),
                "stale": stale,
                "staleSince": utc_iso(self.last_successful_refresh_at) if stale else None,
                "groups": payload_groups,
            }

    def is_ready(self) -> bool:
        with self.lock:
            return bool(self.stop_groups) and bool(self.platforms)


class BoardUpdater(threading.Thread):
    def __init__(self, state: BoardState) -> None:
        super().__init__(daemon=True, name="board-updater")
        self.state = state
        self.stop_event = threading.Event()
        self.next_stops_refresh_at = 0.0

    def run(self) -> None:
        while not self.stop_event.is_set():
            delay = REFRESH_INTERVAL_SECONDS

            try:
                now = time.time()
                if not self.state.get_stop_groups() or now >= self.next_stops_refresh_at:
                    resolved_groups = resolve_stop_groups()
                    if resolved_groups:
                        self.state.set_stop_groups(resolved_groups)
                        self.next_stops_refresh_at = now + STOPS_REFRESH_INTERVAL_SECONDS

                self.state.mark_attempt()
                refresh_delay = self.refresh_displays()
                delay = refresh_delay if refresh_delay is not None else REFRESH_INTERVAL_SECONDS
            except Exception:
                LOGGER.exception("Unexpected failure in update loop.")
                delay = 10

            self.stop_event.wait(delay)

    def stop(self) -> None:
        self.stop_event.set()

    def refresh_displays(self) -> int | None:
        stops = self.state.get_all_stops()
        if not stops:
            LOGGER.warning("No stops configured yet; skipping display refresh.")
            return 10

        any_success = False
        retry_after_seconds = 0

        with ThreadPoolExecutor(max_workers=min(MAX_CONCURRENT_REQUESTS, len(stops))) as executor:
            futures = {
                executor.submit(fetch_display, stop["number"]): stop["number"]
                for stop in stops
            }

            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception as exc:
                    LOGGER.warning("Display worker crashed: %s", exc)
                    continue

                if result.platform is not None:
                    any_success = True
                    self.state.update_platform(result.stop_number, result.platform)
                    continue

                if result.retry_after_seconds:
                    retry_after_seconds = max(retry_after_seconds, result.retry_after_seconds)
                    continue

                LOGGER.warning("Display %s failed: %s", result.stop_number, result.error)

        if any_success:
            self.state.mark_success()
            try:
                self.state.persist_snapshot()
            except OSError as exc:
                LOGGER.warning("Cannot persist board snapshot: %s", exc)

        return retry_after_seconds or None


def resolve_stop_groups() -> list[dict[str, Any]]:
    payload = fetch_json(STOPS_API_URL)
    grouped_map = {name: [] for name in GROUP_ORDER}

    for item in payload.get("data", []):
        normalized_name = normalize_stop_name(item.get("name", ""))
        target_name = next((name for name in TARGET_STOP_NAMES if name == normalized_name), None)
        if not target_name:
            continue

        display_name = denormalize_stop_name(target_name)
        grouped_map[display_name].append(
            {
                "number": str(item["number"]),
                "name": display_name,
            }
        )

    return [
        {
            "name": group_name,
            "stops": sorted(grouped_map.get(group_name, []), key=lambda stop: int(stop["number"])),
        }
        for group_name in GROUP_ORDER
    ]


def fetch_display(stop_number: str) -> FetchResult:
    url = f"{DISPLAY_API_BASE_URL}{stop_number}"
    try:
        payload = fetch_json(url)
    except urlerror.HTTPError as exc:
        if exc.code == HTTPStatus.TOO_MANY_REQUESTS:
            retry_after = parse_retry_after(exc.headers.get("Retry-After"))
            return FetchResult(stop_number=stop_number, retry_after_seconds=retry_after)
        return FetchResult(stop_number=stop_number, error=f"HTTP {exc.code}")
    except (urlerror.URLError, TimeoutError, OSError) as exc:
        return FetchResult(stop_number=stop_number, error=str(exc))

    measured_at = parse_timestamp(payload.get("updated_at")) or time.time()

    return FetchResult(
        stop_number=stop_number,
        platform={
            "departures": normalize_departures(payload.get("departures"), measured_at),
            "updatedAt": measured_at,
        },
    )


def fetch_json(url: str) -> dict[str, Any]:
    request = urlrequest.Request(
        url,
        headers={
            "User-Agent": "zditm-kiosk-board/1.0",
            "Accept": "application/json",
        },
    )

    with urlrequest.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return json.load(response)


def normalize_departures(departures: Any, measured_at: float) -> list[dict[str, Any]]:
    if not isinstance(departures, list):
        return []

    normalized = []
    for item in departures:
        row = normalize_departure(item, measured_at)
        if row is not None:
            normalized.append(row)
    return normalized


def normalize_departure(item: dict[str, Any], measured_at: float) -> dict[str, Any] | None:
    line_number = str(item.get("line_number", "?"))
    direction = str(item.get("direction", "Brak kierunku"))

    if isinstance(item.get("time_real"), int):
        minutes = max(0, item["time_real"])
        return {
            "lineNumber": line_number,
            "direction": direction,
            "displayTime": "teraz" if minutes == 0 else f"{minutes} min",
            "sortMinutes": minutes,
        }

    scheduled_time = item.get("time_scheduled")
    if isinstance(scheduled_time, str) and scheduled_time:
        return {
            "lineNumber": line_number,
            "direction": direction,
            "displayTime": scheduled_time,
            "sortMinutes": get_scheduled_minutes_until(scheduled_time, measured_at),
        }

    return None


def get_scheduled_minutes_until(time_string: str, measured_at: float) -> int:
    hour_value, minute_value = [int(value) for value in time_string.split(":", 1)]
    now = datetime.fromtimestamp(measured_at, tz=timezone.utc).astimezone()
    scheduled = now.replace(hour=hour_value, minute=minute_value, second=0, microsecond=0)
    if scheduled.timestamp() < now.timestamp():
        from datetime import timedelta

        scheduled = scheduled + timedelta(days=1)
    return max(0, round((scheduled.timestamp() - now.timestamp()) / 60))


def parse_timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_retry_after(value: str | None) -> int:
    if not value:
        return REFRESH_INTERVAL_SECONDS
    try:
        return max(1, int(value))
    except ValueError:
        return REFRESH_INTERVAL_SECONDS


def denormalize_stop_name(name: str) -> str:
    return next((item for item in GROUP_ORDER if normalize_stop_name(item) == name), name)


class BoardRequestHandler(SimpleHTTPRequestHandler):
    board_state: BoardState

    def __init__(self, *args: Any, directory: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def do_GET(self) -> None:
        if self.path == "/api/board":
            return self.send_json(HTTPStatus.OK, self.board_state.build_board_payload())
        if self.path == "/health/live":
            return self.send_json(HTTPStatus.OK, {"status": "ok"})
        if self.path == "/health/ready":
            status = HTTPStatus.OK if self.board_state.is_ready() else HTTPStatus.SERVICE_UNAVAILABLE
            return self.send_json(status, {"status": "ready" if status == HTTPStatus.OK else "booting"})
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), format % args)


def configure_logging() -> None:
    logging.basicConfig(
        level=os.environ.get("ZDITM_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main() -> None:
    configure_logging()

    board_state = BoardState()
    board_state.load_snapshot()

    BoardRequestHandler.board_state = board_state
    updater = BoardUpdater(board_state)
    updater.start()

    server = ThreadingHTTPServer((DEFAULT_HOST, DEFAULT_PORT), partial(BoardRequestHandler, directory=str(ROOT_DIR)))

    LOGGER.info("Serving board on http://%s:%s", DEFAULT_HOST, DEFAULT_PORT)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Stopping board server.")
    finally:
        updater.stop()
        updater.join(timeout=5)
        server.server_close()


if __name__ == "__main__":
    main()
