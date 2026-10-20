const DEFAULT_MANIFEST_URL = "/manifest.json";

function getEnvString(name: string): string | undefined {
  const value = import.meta.env[name as keyof ImportMetaEnv];

  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toAbsoluteBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return window.location.href;
  }

  return new URL(baseUrl, window.location.href).toString();
}

export function resolveRelativeUrl(baseUrl: string | undefined, maybeRelativeUrl: string): string {
  return new URL(maybeRelativeUrl, toAbsoluteBaseUrl(baseUrl)).toString();
}

export function getManifestUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("manifest");

  if (fromQuery) {
    return fromQuery;
  }

  return getEnvString("VITE_DEFAULT_MANIFEST_URL") ?? DEFAULT_MANIFEST_URL;
}

export type SharedViewState = {
  raceTimeMs?: number;
  historyDurationMinutes?: number;
  expandedVideo?: "camera" | "satellite" | null;
};

export function getSharedViewState(): SharedViewState {
  const params = new URLSearchParams(window.location.search);
  const state: SharedViewState = {};

  const time = params.get("t");
  if (time) {
    const raceTimeMs = Date.parse(time);
    if (Number.isFinite(raceTimeMs)) {
      state.raceTimeMs = raceTimeMs;
    }
  }

  const history = Number(params.get("history"));
  if (Number.isFinite(history) && history > 0) {
    state.historyDurationMinutes = history;
  }

  const view = params.get("view");
  if (view === "camera" || view === "satellite") {
    state.expandedVideo = view;
  }

  return state;
}

export function buildShareUrl(state: Required<SharedViewState>): string {
  const url = new URL(window.location.href);
  const raceTime = new Date(Math.floor((state.raceTimeMs ?? 0) / 1000) * 1000);

  url.searchParams.set("t", raceTime.toISOString().replace(".000Z", "Z"));
  url.searchParams.set("history", String(state.historyDurationMinutes));

  if (state.expandedVideo) {
    url.searchParams.set("view", state.expandedVideo);
  } else {
    url.searchParams.delete("view");
  }

  return url.toString();
}

export function getMediaBaseUrl(): string | undefined {
  return getEnvString("VITE_MEDIA_BASE_URL");
}

export function getDataBaseUrl(): string | undefined {
  return getEnvString("VITE_DATA_BASE_URL");
}
