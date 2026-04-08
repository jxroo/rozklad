const GROUP_ORDER = ["Starkiewicza", "Osiedle Polonia", "Dunikowskiego", "Plac Szyrockiego"];
const BOARD_API_URL = "/api/board";
const BOARD_CACHE_KEY = "zditm-board-cache-v1";
const MAX_ROWS_PER_GROUP = 10;
const FRONTEND_REFRESH_INTERVAL_MS = 15_000;
const WATCHDOG_TIMEOUT_MS = 180_000;
const HARD_RELOAD_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_500;

const state = {
  currentBoard: null,
  lastSuccessAt: null,
  pollTimerId: null,
  watchdogTimerId: null,
  hardReloadTimerId: null,
};

const elements = {
  board: document.getElementById("board"),
  clock: document.getElementById("clock"),
  stopsGrid: document.getElementById("stops-grid"),
  sectionTemplate: document.getElementById("section-template"),
  rowTemplate: document.getElementById("row-template"),
};

document.addEventListener("DOMContentLoaded", () => {
  startClock();
  installFrontendGuards();
  registerServiceWorker();
  void bootstrap();
});

async function bootstrap() {
  const cachedBoard = loadCachedBoard();

  if (cachedBoard) {
    state.currentBoard = cachedBoard;
    renderBoard(cachedBoard);
  } else {
    renderBoard();
  }

  await refreshBoard();
  scheduleBoardRefresh(FRONTEND_REFRESH_INTERVAL_MS);
  scheduleHardReload();
}

async function refreshBoard() {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(BOARD_API_URL, {
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Local API returned ${response.status}.`);
    }

    const payload = await response.json();
    validateBoardPayload(payload);

    state.currentBoard = payload;
    state.lastSuccessAt = Date.now();
    saveCachedBoard(payload);
    renderBoard(payload);
  } catch {
    const fallbackBoard = state.currentBoard ?? loadCachedBoard();
    if (fallbackBoard) {
      renderBoard({
        ...fallbackBoard,
        stale: true,
      });
    } else {
      renderBoard();
    }
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function renderBoard(boardPayload = null) {
  const payload = boardPayload ?? buildFallbackBoard();
  const groups = Array.isArray(payload.groups) ? payload.groups : buildFallbackBoard().groups;

  elements.board.dataset.stale = payload.stale ? "true" : "false";
  elements.stopsGrid.replaceChildren();

  for (const group of groups) {
    const sectionNode = elements.sectionTemplate.content.firstElementChild.cloneNode(true);
    sectionNode.querySelector(".stop-section__title").textContent = group.name;

    const rowsContainer = sectionNode.querySelector(".stop-section__rows");
    const rows = normalizeRows(group.rows);

    for (const row of rows) {
      rowsContainer.appendChild(buildRow(row));
    }

    elements.stopsGrid.appendChild(sectionNode);
  }
}

function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return Array.from({ length: MAX_ROWS_PER_GROUP }, (_, index) => ({
      lineNumber: "—",
      direction: index === 0 ? "Brak odjazdów" : "",
      displayTime: "—",
      isEmpty: true,
    }));
  }

  const normalized = rows.slice(0, MAX_ROWS_PER_GROUP).map((row) => ({
    lineNumber: typeof row.lineNumber === "string" ? row.lineNumber : "—",
    direction: typeof row.direction === "string" ? row.direction : "",
    displayTime: typeof row.displayTime === "string" ? row.displayTime : "—",
    isEmpty: Boolean(row.isEmpty),
  }));

  while (normalized.length < MAX_ROWS_PER_GROUP) {
    normalized.push({
      lineNumber: "—",
      direction: "",
      displayTime: "—",
      isEmpty: true,
    });
  }

  return normalized;
}

function buildRow(row) {
  const rowNode = elements.rowTemplate.content.firstElementChild.cloneNode(true);
  rowNode.classList.toggle("is-empty", row.isEmpty);
  rowNode.querySelector(".departure-row__line").textContent = row.lineNumber;
  rowNode.querySelector(".departure-row__direction").textContent = row.direction;
  rowNode.querySelector(".departure-row__time").textContent = row.displayTime;
  return rowNode;
}

function buildFallbackBoard() {
  return {
    stale: true,
    groups: GROUP_ORDER.map((name) => ({
      name,
      rows: [],
    })),
  };
}

function validateBoardPayload(payload) {
  if (!payload || !Array.isArray(payload.groups)) {
    throw new Error("Invalid board payload.");
  }
}

function saveCachedBoard(payload) {
  try {
    window.localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage failures and keep the app rendering from memory.
  }
}

function loadCachedBoard() {
  try {
    const raw = window.localStorage.getItem(BOARD_CACHE_KEY);
    if (!raw) {
      return null;
    }

    const payload = JSON.parse(raw);
    validateBoardPayload(payload);
    return payload;
  } catch {
    return null;
  }
}

function scheduleBoardRefresh(delay) {
  if (state.pollTimerId) {
    window.clearTimeout(state.pollTimerId);
  }

  state.pollTimerId = window.setTimeout(async () => {
    await refreshBoard();
    scheduleBoardRefresh(FRONTEND_REFRESH_INTERVAL_MS);
  }, delay);
}

function scheduleHardReload() {
  if (state.hardReloadTimerId) {
    window.clearTimeout(state.hardReloadTimerId);
  }

  state.hardReloadTimerId = window.setTimeout(() => {
    window.location.reload();
  }, HARD_RELOAD_INTERVAL_MS);
}

function installFrontendGuards() {
  window.addEventListener("error", () => {
    scheduleCrashReload();
  });

  window.addEventListener("unhandledrejection", () => {
    scheduleCrashReload();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshBoard();
    }
  });

  state.watchdogTimerId = window.setInterval(() => {
    if (!state.lastSuccessAt) {
      return;
    }

    if (Date.now() - state.lastSuccessAt > WATCHDOG_TIMEOUT_MS) {
      window.location.reload();
    }
  }, 30_000);
}

function scheduleCrashReload() {
  window.setTimeout(() => {
    window.location.reload();
  }, 1_000);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Ignore registration errors; the app still works without the shell cache.
    });
  });
}

function startClock() {
  renderClock();
  window.setInterval(() => {
    renderClock();
  }, 1_000);
}

function renderClock() {
  elements.clock.textContent = new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(Date.now());
}
