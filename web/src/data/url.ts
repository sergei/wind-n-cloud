export function resolveRelativeUrl(baseUrl: string, maybeRelativeUrl: string): string {
  return new URL(maybeRelativeUrl, baseUrl).toString();
}

export function getManifestUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("manifest");

  if (fromQuery) {
    return fromQuery;
  }

  const fromEnv = import.meta.env.VITE_DEFAULT_MANIFEST_URL as string | undefined;

  if (fromEnv) {
    return fromEnv;
  }

  return "/manifest.json";
}
