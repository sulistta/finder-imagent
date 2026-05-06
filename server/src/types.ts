export type MetadataColumnKey =
  | 'description'
  | 'category'
  | 'seoTitle'
  | 'seoDescription'
  | 'seoKeywords';

export interface ColumnMapping {
  sku: string;
  title: string;
  imageColumns: string[];
  metadataColumns?: Partial<Record<MetadataColumnKey, string>>;
}

export interface JobConfig {
  workbookId: string;
  sheetName: string;
  columnMapping: ColumnMapping;
  targetImageCount: number;
  writePolicy: 'fill-empty-only';
  limits?: {
    maxProducts?: number;
    maxCandidatesPerProduct?: number;
  };
}

export interface JobStatus {
  id: string;
  totals: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
  };
  currentStage: string;
  downloadable: boolean;
  state: 'queued' | 'running' | 'completed' | 'failed';
  error?: string;
}

export type JobActivityPhase =
  | 'product:start'
  | 'query:build'
  | 'ranking:search'
  | 'ranking:candidates'
  | 'visual:extract'
  | 'visual:evidence'
  | 'visual:validate'
  | 'metadata:generate'
  | 'captcha'
  | 'product:complete'
  | 'product:failed';

export type JobActivityState =
  | 'start'
  | 'progress'
  | 'success'
  | 'rejected'
  | 'blocked'
  | 'unblocked'
  | 'error';

export interface JobActivityEvent {
  id: string;
  jobId: string;
  timestamp: string;
  apiKeyId: string;
  agentId: string;
  role: ModelAgentRole;
  product?: {
    sku: string;
    title: string;
  };
  phase: JobActivityPhase;
  state: JobActivityState;
  query?: string;
  candidate?: SearchCandidate;
  imageCount?: number;
  evidenceScore?: number;
  reason?: string;
  message?: string;
}

export interface AgentStatus {
  id: string;
  label: string;
  role: ModelAgentRole;
  model: string;
  apiKeyId: string;
  apiKeyLabel: string;
  groupId: string;
  state: ModelAgentState;
  activeProduct: string | null;
  manualAction: {
    type: 'google-captcha';
    message: string;
    url: string;
  } | null;
  counts: {
    completed: number;
    failed: number;
  };
  lastError: string | null;
}

export type ModelAgentRole = 'query' | 'ranking' | 'visual' | 'metadata';

export type ModelAgentState = 'idle' | 'active' | 'blocked' | 'error';

export interface ProductResult {
  sku: string;
  status: 'completed' | 'failed' | 'skipped';
  images: string[];
  metadata: Partial<Record<MetadataColumnKey, string>>;
  sourceUrl?: string;
  validationReason: string;
  diagnostics: string[];
}

export interface WorkbookPreview {
  workbookId: string;
  sheets: Array<{
    name: string;
    headers: string[];
    samples: Record<string, string>[];
  }>;
}

export interface ApiKeyConfig {
  id: string;
  label: string;
  key: string;
}

export interface ModelConfig {
  baseUrl: string;
  query: string;
  ranking: string;
  visual: string;
  metadata: string;
}

export interface GoogleRuntimeConfig {
  delayMinMs: number;
  delayMaxMs: number;
  maxQueries: number;
  maxCandidatesPerQuery: number;
  pageAgentRankingTimeoutMs: number;
}

export interface ProductInput {
  rowNumber: number;
  sku: string;
  title: string;
  existingImages: string[];
  emptyMetadataFields: MetadataColumnKey[];
  category?: string;
}

export interface SearchCandidate {
  url: string;
  title: string;
  snippet: string;
  reason?: string;
}

export interface ExtractedPage {
  url: string;
  title: string;
  h1: string;
  metaDescription: string;
  jsonLdProducts: unknown[];
  text: string;
  images: string[];
}

export interface VisualValidation {
  approved: boolean;
  reason: string;
}
