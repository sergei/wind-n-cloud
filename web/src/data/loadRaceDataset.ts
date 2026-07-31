import type { RaceManifest, WindSamplesColumnar } from "../types/race";
import { resolveRelativeUrl } from "./url";

export type LoadedRaceDataset = {
  manifestUrl: string;
  manifest: RaceManifest;
  windSamples: WindSamplesColumnar;
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export async function loadRaceDataset(manifestUrl: string): Promise<LoadedRaceDataset> {
  const manifest = await fetchJson<RaceManifest>(manifestUrl);
  const windSamplesUrl = resolveRelativeUrl(manifestUrl, manifest.data.windSamplesUrl);
  const windSamples = await fetchJson<WindSamplesColumnar>(windSamplesUrl);

  return {
    manifestUrl,
    manifest,
    windSamples,
  };
}
