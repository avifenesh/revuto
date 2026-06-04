export type UnitKind = 'service' | 'timer';

export interface ServiceStatus {
  id: string;
  label: string;
  kind: UnitKind;
  activeState: string;
  subState: string;
  mainPid: number | null;
  since: string | null;
  fragmentPath: string | null;
  unitFileState: string | null;
  nextElapse: string | null;
  lastTrigger: string | null;
}

export interface ModelStatus {
  role: 'review' | 'curator' | 'distill' | 'embedder';
  enabled: boolean;
  name: string;
  api: string;
  model: string;
  baseURL: string;
  auth: string;
  effectiveAuth: string;
  authDetail: string | null;
  reasoningEffort: string | null;
  awsRegion: string | null;
  apiKeyEnv: string | null;
  apiKeyAvailable: boolean | null;
  probe: {
    state: 'ok' | 'failed' | 'disabled' | 'unknown';
    kind: 'chat' | 'embedding' | 'none';
    checkedAt: string | null;
    ms: number | null;
    error: string | null;
    sharedRoles: string[];
  };
}

export interface ReviewerStatus {
  repo: string;
  paused: boolean;
  autoActivate: boolean;
  authorAllowlist: string[];
  botLogin: string | null;
  schedules: {
    review: string;
    learn: string;
    decay: string;
  };
}

export interface JobEvent {
  timestamp: string;
  job: 'review' | 'learn' | 'decay';
  repo: string;
  status: 'ok' | 'failed' | 'unknown';
  durationMs: number | null;
  result: Record<string, unknown> | null;
  summary: string;
  raw: string;
}

export interface LogLine {
  timestamp: string | null;
  level: 'info' | 'warn' | 'error';
  message: string;
  raw: string;
}

export interface ProcessStatus {
  pid: number;
  ageSeconds: number;
  cpu: number;
  memory: number;
  command: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  configError: string | null;
  configPath: string | null;
  vaultPath: string | null;
  workspaceDir: string | null;
  store: {
    backend: string;
    url: string | null;
    namespace: string | null;
  } | null;
  schedules: {
    review: string;
    learn: string;
    decay: string;
  } | null;
  limits: {
    maxSteps: number;
    maxOutputTokens: {
      review: number;
      curator: number;
      distill: number;
    };
    dailyReviews: number;
    dailyLearn: number;
    dailyTokens: number;
  } | null;
  counts: {
    servicesActive: number;
    servicesTotal: number;
    reviewers: number;
    pausedReviewers: number;
    recentJobs: number;
    recentFailures: number;
  };
  services: ServiceStatus[];
  models: ModelStatus[];
  reviewers: ReviewerStatus[];
  jobs: JobEvent[];
  logs: LogLine[];
  processes: ProcessStatus[];
}
