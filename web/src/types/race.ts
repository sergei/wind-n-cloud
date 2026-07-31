export type VideoSegment = {
  id: string;
  startTime: string;
  endTime: string;
  startTimeMs: number;
  endTimeMs: number;
  videoUrl: string;
};

export type RaceManifest = {
  schemaVersion: number;
  raceId: string;
  displayName: string;
  timezone: string;
  startTime: string;
  endTime: string;
  startTimeMs: number;
  endTimeMs: number;
  defaults: {
    windHistoryDurationMinutes: number;
    availableWindHistoryDurationsMinutes: number[];
  };
  data: {
    windSamplesUrl: string;
    windSampleCount: number;
    fields: string[];
  };
  videoSegments: VideoSegment[];
};

export type WindSamplesColumnar = {
  schemaVersion: number;
  format: "columnar";
  count: number;
  time: string[];
  timeMs: number[];
  twd: Array<number | null>;
  tws: Array<number | null>;
  heading?: Array<number | null>;
  sog?: Array<number | null>;
  cog?: Array<number | null>;
  awa?: Array<number | null>;
  aws?: Array<number | null>;
  twa?: Array<number | null>;
};

export type WindSampleAtTime = {
  timeMs: number;
  twd: number | null;
  tws: number | null;
  heading: number | null;
};
