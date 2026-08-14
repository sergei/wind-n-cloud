/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_MANIFEST_URL?: string;
  readonly VITE_MEDIA_BASE_URL?: string;
  readonly VITE_DATA_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
