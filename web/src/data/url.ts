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

export function getMediaBaseUrl(): string | undefined {
  return getEnvString("VITE_MEDIA_BASE_URL");
}

export function getDataBaseUrl(): string | undefined {
  return getEnvString("VITE_DATA_BASE_URL");
}
