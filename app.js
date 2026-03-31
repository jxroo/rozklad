const STOPS_API_URL = "https://www.zditm.szczecin.pl/api/v1/stops";
const DISPLAY_API_BASE_URL = "https://www.zditm.szczecin.pl/api/v1/displays/";
const TARGET_STOP_NAMES = ["Starkiewicza", "Brama Portowa", "Plac Kosciuszki"];
const GROUP_ORDER = ["Starkiewicza", "Brama Portowa", "Plac Kościuszki"];
const MAX_ROWS_PER_GROUP = 10;
const REFRESH_INTERVAL_MS = 30_000;

const state = {
  stopGroups: [],
  platforms: new Map(),
  isRefreshing: false,
  retryAt: null,
  abortController: null,
  refreshTimerId: null,
  tickTimerId: null,
};

const elements = {
  clock: document.getElementById("clock"),
  stopsGrid: document.getElementById("stops-grid"),
  sectionTemplate: document.getElementById("section-template"),
  rowTemplate: document.getElementById("row-template"),
};

document.addEventListener("DOMContentLoaded", () => {
  startClock();
  void bootstrap();
});

async function bootstrap() {
  try {
    await resolveStops();
    seedPlatformState();
    renderBoard();
    await refreshDisplays();
  } catch {
    renderBoard(true);
  }
}

async function resolveStops() {
  const response = await fetch(STOPS_API_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Lista przystanków odpowiedziała ${response.status}.`);
  }

  const payload = await response.json();
  const groupedMap = new Map();

  for (const stopName of GROUP_ORDER) {
    groupedMap.set(stopName, []);
  }

  for (const item of payload.data ?? []) {
    const normalizedName = normalizeStopName(item.name);
    const targetName = TARGET_STOP_NAMES.find((name) => name === normalizedName);
    if (!targetName) {
      continue;
    }

    const displayName = denormalizeStopName(targetName);
    groupedMap.get(displayName).push({
      number: String(item.number),
      name: displayName,
    });
  }

  state.stopGroups = GROUP_ORDER.map((groupName) => ({
    name: groupName,
    stops: (groupedMap.get(groupName) ?? []).sort((left, right) => Number(left.number) - Number(right.number)),
  }));
}

function seedPlatformState() {
  state.platforms = new Map();

  for (const group of state.stopGroups) {
    for (const stop of group.stops) {
      state.platforms.set(stop.number, {
        departures: [],
        updatedAt: null,
      });
    }
  }
}

async function refreshDisplays() {
  if (state.isRefreshing || !state.stopGroups.length) {
    return;
  }

  const now = Date.now();
  if (state.retryAt && now < state.retryAt) {
    scheduleNextRefresh(state.retryAt - now);
    return;
  }

  state.isRefreshing = true;
  state.abortController?.abort();
  state.abortController = new AbortController();

  const stops = state.stopGroups.flatMap((group) => group.stops);
  const responses = await Promise.allSettled(
    stops.map((stop) => fetchDisplay(stop, state.abortController.signal))
  );

  let nextRetryAt = null;

  for (let index = 0; index < responses.length; index += 1) {
    const stop = stops[index];
    const previous = state.platforms.get(stop.number) ?? { departures: [], updatedAt: null };
    const result = responses[index];

    if (result.status === "fulfilled") {
      if (result.value.retryAfterMs) {
        nextRetryAt = Math.max(nextRetryAt ?? 0, Date.now() + result.value.retryAfterMs);
        state.platforms.set(stop.number, previous);
      } else {
        state.platforms.set(stop.number, result.value.platform);
      }
      continue;
    }

    state.platforms.set(stop.number, previous);
  }

  state.isRefreshing = false;
  state.retryAt = nextRetryAt;
  renderBoard();
  scheduleNextRefresh(nextRetryAt ? Math.max(1_000, nextRetryAt - Date.now()) : REFRESH_INTERVAL_MS);
}

async function fetchDisplay(stop, signal) {
  const response = await fetch(`${DISPLAY_API_BASE_URL}${stop.number}`, {
    cache: "no-store",
    signal,
  });

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = Number.parseInt(retryAfterHeader ?? "30", 10);

    return {
      retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : REFRESH_INTERVAL_MS,
    };
  }

  if (!response.ok) {
    throw new Error(`Tablica ${stop.number} odpowiedziała ${response.status}.`);
  }

  const payload = await response.json();
  const measuredAt = payload.updated_at ? Date.parse(payload.updated_at) : Date.now();

  return {
    platform: {
      departures: normalizeDepartures(payload.departures, measuredAt),
      updatedAt: measuredAt,
    },
  };
}

function normalizeDepartures(departures, measuredAt) {
  if (!Array.isArray(departures) || departures.length === 0) {
    return [];
  }

  return departures
    .map((item) => normalizeDeparture(item, measuredAt))
    .filter(Boolean);
}

function normalizeDeparture(item, measuredAt) {
  const lineNumber = String(item.line_number ?? "?");
  const direction = String(item.direction ?? "Brak kierunku");

  if (Number.isFinite(item.time_real)) {
    const minutes = Math.max(0, item.time_real);

    return {
      lineNumber,
      direction,
      displayTime: `${minutes} min`,
      sortMinutes: minutes,
    };
  }

  if (typeof item.time_scheduled === "string" && item.time_scheduled) {
    return {
      lineNumber,
      direction,
      displayTime: item.time_scheduled,
      sortMinutes: getScheduledMinutesUntil(item.time_scheduled, measuredAt),
    };
  }

  return null;
}

function renderBoard(forceEmpty = false) {
  elements.stopsGrid.replaceChildren();

  const groups = state.stopGroups.length ? state.stopGroups : GROUP_ORDER.map((name) => ({ name, stops: [] }));

  for (const group of groups) {
    const sectionNode = elements.sectionTemplate.content.firstElementChild.cloneNode(true);
    sectionNode.querySelector(".stop-section__title").textContent = group.name;

    const rowsContainer = sectionNode.querySelector(".stop-section__rows");
    const departures = forceEmpty ? [] : buildGroupDepartures(group);
    const rows = buildRows(departures);

    for (const row of rows) {
      rowsContainer.appendChild(buildRow(row));
    }

    elements.stopsGrid.appendChild(sectionNode);
  }
}

function buildGroupDepartures(group) {
  const departures = [];

  for (const stop of group.stops) {
    const platform = state.platforms.get(stop.number);
    if (!platform?.departures?.length) {
      continue;
    }

    departures.push(...platform.departures);
  }

  departures.sort((left, right) => {
    return (
      left.sortMinutes - right.sortMinutes ||
      left.lineNumber.localeCompare(right.lineNumber, "pl") ||
      left.direction.localeCompare(right.direction, "pl")
    );
  });

  return departures.slice(0, MAX_ROWS_PER_GROUP);
}

function buildRows(departures) {
  if (!departures.length) {
    return Array.from({ length: MAX_ROWS_PER_GROUP }, (_, index) => ({
      lineNumber: "—",
      direction: index === 0 ? "Brak odjazdów" : "",
      displayTime: "—",
      isEmpty: true,
    }));
  }

  const rows = departures.map((departure) => ({
    ...departure,
    isEmpty: false,
  }));

  while (rows.length < MAX_ROWS_PER_GROUP) {
    rows.push({
      lineNumber: "—",
      direction: "",
      displayTime: "—",
      isEmpty: true,
    });
  }

  return rows;
}

function buildRow(row) {
  const rowNode = elements.rowTemplate.content.firstElementChild.cloneNode(true);
  rowNode.classList.toggle("is-empty", row.isEmpty);
  rowNode.querySelector(".departure-row__line").textContent = row.lineNumber;
  rowNode.querySelector(".departure-row__direction").textContent = row.direction;
  rowNode.querySelector(".departure-row__time").textContent = row.displayTime;
  return rowNode;
}

function scheduleNextRefresh(delay) {
  if (state.refreshTimerId) {
    window.clearTimeout(state.refreshTimerId);
  }

  state.refreshTimerId = window.setTimeout(() => {
    void refreshDisplays();
  }, delay);
}

function startClock() {
  renderClock();
  state.tickTimerId = window.setInterval(() => {
    renderClock();
  }, 1000);
}

function renderClock() {
  elements.clock.textContent = new Intl.DateTimeFormat("pl-PL", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(Date.now());
}

function normalizeStopName(name) {
  return String(name)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function denormalizeStopName(name) {
  return GROUP_ORDER.find((item) => normalizeStopName(item) === name) ?? name;
}

function getScheduledMinutesUntil(timeString, measuredAt) {
  const [hourValue, minuteValue] = timeString.split(":").map((value) => Number.parseInt(value, 10));
  const now = new Date(measuredAt);
  const scheduled = new Date(measuredAt);

  scheduled.setHours(hourValue, minuteValue, 0, 0);

  if (scheduled.getTime() < now.getTime()) {
    scheduled.setDate(scheduled.getDate() + 1);
  }

  return Math.max(0, Math.round((scheduled.getTime() - now.getTime()) / 60_000));
}
