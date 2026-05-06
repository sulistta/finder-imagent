import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import type { AiProvider } from './gemini.js';
import { GeminiAiProvider } from './gemini.js';
import type { SearchProvider } from './google.js';
import { GooglePlaywrightSearchProvider } from './google.js';
import type {
  AgentStatus,
  ApiKeyConfig,
  GoogleRuntimeConfig,
  JobConfig,
  JobStatus,
  ModelAgentRole,
  ModelConfig,
  ProductInput,
  ProductResult,
  SearchCandidate,
} from './types.js';
import {
  buildDeterministicQueries,
  getWorkbookInputPath,
  normalizeCheckpoint,
  readWorkbookSheet,
  selectTargetProducts,
  type WorkbookStore,
  writeResultsFillEmptyOnly,
} from './workbook.js';

export interface JobEvent {
  type: 'status' | 'agent' | 'product' | 'log';
  data: unknown;
}

export interface JobManagerOptions {
  store: WorkbookStore;
  apiKeys: ApiKeyConfig[];
  models: ModelConfig;
  googleHeadless: boolean;
  google: GoogleRuntimeConfig;
  aiFactory?: (apiKey: ApiKeyConfig) => AiProvider;
  searchProviderFactory?: () => SearchProvider;
  delayBetweenProducts?: (ms: number) => Promise<void>;
  randomDelayMs?: (minMs: number, maxMs: number) => number;
}

interface JobRecord {
  id: string;
  config: JobConfig;
  status: JobStatus;
  agents: AgentStatus[];
  emitter: EventEmitter;
  results: ProductResult[];
  jobDir: string;
  inputPath: string;
  outputPath: string;
}

interface ModelAgentGroup {
  id: string;
  apiKey: ApiKeyConfig;
  ai: AiProvider;
  search: SearchProvider;
  agents: Record<ModelAgentRole, AgentStatus>;
  activeRole: ModelAgentRole | null;
}

const MODEL_AGENT_ROLES: ModelAgentRole[] = ['query', 'ranking', 'visual', 'metadata'];

export class ImageFinderJobManager {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly options: JobManagerOptions) {}

  async startJob(config: JobConfig): Promise<{ status: JobStatus; agents: AgentStatus[] }> {
    validateJobConfig(config);
    if (this.options.apiKeys.length === 0) {
      throw new Error('No Google API keys configured. Add GOOGLE_API_KEYS or GOOGLE_API_KEY_1 to .env.');
    }
    requireConfiguredModels(this.options.models);

    const id = crypto.randomUUID();
    const jobDir = path.join(this.options.store.rootDir, 'jobs', id);
    fs.mkdirSync(jobDir, { recursive: true });
    const inputPath = getWorkbookInputPath(this.options.store, config.workbookId);
    const outputPath = path.join(jobDir, 'output.xlsx');
    fs.copyFileSync(inputPath, path.join(jobDir, 'input.xlsx'));

    const sheet = await readWorkbookSheet(inputPath, config.sheetName);
    const targets = selectTargetProducts(
      sheet,
      config.columnMapping,
      config.targetImageCount,
      config.limits?.maxProducts ?? 0,
    );

    const status: JobStatus = {
      id,
      totals: {
        total: targets.length,
        completed: 0,
        failed: 0,
        pending: targets.length,
      },
      currentStage: targets.length === 0 ? 'completed' : 'queued',
      downloadable: false,
      state: targets.length === 0 ? 'completed' : 'queued',
    };

    const agents = this.options.apiKeys.flatMap((apiKey) => createModelAgents(apiKey, this.options.models));

    const record: JobRecord = {
      id,
      config,
      status,
      agents,
      emitter: new EventEmitter(),
      results: [],
      jobDir,
      inputPath,
      outputPath,
    };
    this.jobs.set(id, record);
    writeCheckpoint(record);

    queueMicrotask(() => {
      void this.runJob(record, targets);
    });

    return { status, agents };
  }

  getJob(id: string): JobRecord | null {
    return this.jobs.get(id) ?? null;
  }

  subscribe(id: string, listener: (event: JobEvent) => void): () => void {
    const record = this.requireJob(id);
    const onEvent = (event: JobEvent) => listener(event);
    record.emitter.on('event', onEvent);
    listener({ type: 'status', data: record.status });
    for (const agent of record.agents) listener({ type: 'agent', data: agent });
    return () => record.emitter.off('event', onEvent);
  }

  getDownloadPath(id: string): string {
    const record = this.requireJob(id);
    if (!record.status.downloadable) {
      throw new Error('Job output is not ready for download');
    }
    return record.outputPath;
  }

  private async runJob(record: JobRecord, targets: ProductInput[]): Promise<void> {
    if (targets.length === 0) {
      await writeResultsFillEmptyOnly({
        inputPath: record.inputPath,
        outputPath: record.outputPath,
        sheetName: record.config.sheetName,
        mapping: record.config.columnMapping,
        results: [],
      });
      record.status.downloadable = true;
      emitStatus(record, 'completed', 'completed');
      return;
    }

    emitStatus(record, 'running', 'starting');
    const pending = [...targets];
    const groups = this.createModelAgentGroups(record);

    await Promise.all(groups.map((group) => this.runGroup(record, group, pending)));

    await writeResultsFillEmptyOnly({
      inputPath: record.inputPath,
      outputPath: record.outputPath,
      sheetName: record.config.sheetName,
      mapping: record.config.columnMapping,
      results: record.results,
    });
    record.status.downloadable = true;
    emitStatus(record, 'completed', 'completed');
    writeCheckpoint(record);
  }

  private createModelAgentGroups(record: JobRecord): ModelAgentGroup[] {
    return this.options.apiKeys.map((apiKey) => {
      const groupAgents = agentsForApiKey(record.agents, apiKey.id);
      const group: ModelAgentGroup = {
        id: apiKey.id,
        apiKey,
        ai: this.options.aiFactory?.(apiKey) ?? new GeminiAiProvider(apiKey, this.options.models),
        search:
          this.options.searchProviderFactory?.() ??
          new GooglePlaywrightSearchProvider({
            headless: this.options.googleHeadless,
            maxCandidatesPerQuery: this.options.google.maxCandidatesPerQuery,
            onManualAction: (action) => {
              const activeRole = group.activeRole ?? 'ranking';
              const activeAgent = group.agents[activeRole];
              if (action.active) {
                activeAgent.manualAction = {
                  type: 'google-captcha',
                  message: 'Resolva o CAPTCHA no navegador aberto para continuar.',
                  url: action.url,
                };
                activeAgent.state = 'blocked';
                emitAgent(record, activeAgent, 'captcha');
                return;
              }
              activeAgent.manualAction = null;
              if (group.activeRole === activeRole) activeAgent.state = 'active';
              emitAgent(record, activeAgent, activeRole);
            },
          }),
        agents: groupAgents,
        activeRole: null,
      };
      return group;
    });
  }

  private async runGroup(record: JobRecord, group: ModelAgentGroup, pending: ProductInput[]): Promise<void> {
    try {
      while (pending.length > 0) {
        const product = pending.shift();
        if (!product) break;
        await this.processProduct(record, group, product);
        if (pending.length > 0) {
          await (this.options.delayBetweenProducts ?? delay)(
            (this.options.randomDelayMs ?? randomInt)(this.options.google.delayMinMs, this.options.google.delayMaxMs),
          );
        }
      }
    } finally {
      await group.search.close();
    }
  }

  private async processProduct(record: JobRecord, group: ModelAgentGroup, product: ProductInput): Promise<void> {
    const productLabel = product.sku || product.title;
    let activeAgent = group.agents.query;
    const productDiagnostics: string[] = [];
    activateAgent(record, group, 'query', productLabel);

    try {
      const allowedQueries = buildDeterministicQueries(product).slice(0, this.options.google.maxQueries);
      const { queries, diagnostics } = await this.generateQueries(group, product, allowedQueries);
      productDiagnostics.push(`queries=${queries.length}`, ...diagnostics);
      completeAgentStage(record, group.agents.query);

      activeAgent = group.agents.ranking;
      activateAgent(record, group, 'ranking', productLabel);
      const limit = record.config.limits?.maxCandidatesPerProduct ?? 5;
      const { selected, diagnostics: rankingDiagnostics } = await this.selectRankedCandidates(group, product, queries, limit);
      productDiagnostics.push(...rankingDiagnostics);
      completeAgentStage(record, group.agents.ranking);

      activeAgent = group.agents.visual;
      const result = await this.validateCandidates(record, group, product, selected);

      activeAgent = group.agents.metadata;
      activateAgent(record, group, 'metadata', productLabel);
      const metadata = await group.ai.generateMetadata(product, result.page, product.emptyMetadataFields);
      completeAgentStage(record, group.agents.metadata);
      const productResult: ProductResult = {
        sku: product.sku,
        status: 'completed',
        images: result.page.images.slice(0, record.config.targetImageCount),
        metadata,
        sourceUrl: result.page.url,
        validationReason: result.reason,
        diagnostics: productDiagnostics,
      };
      record.results.push(productResult);
      record.status.totals.completed += 1;
      record.status.totals.pending -= 1;
      emitProduct(record, productResult);
      clearGroupAgents(record, group);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const productResult: ProductResult = {
        sku: product.sku,
        status: 'failed',
        images: [],
        metadata: {},
        validationReason: message,
        diagnostics: [...productDiagnostics, message],
      };
      record.results.push(productResult);
      activeAgent.counts.failed += 1;
      activeAgent.lastError = message;
      activeAgent.state = 'error';
      emitAgent(record, activeAgent, activeAgent.role);
      record.status.totals.failed += 1;
      record.status.totals.pending -= 1;
      emitProduct(record, productResult);
    } finally {
      writeCheckpoint(record);
    }
  }

  private async generateQueries(
    group: ModelAgentGroup,
    product: ProductInput,
    allowedQueries: string[],
  ): Promise<{ queries: string[]; diagnostics: string[] }> {
    if (allowedQueries.length === 0) {
      throw new Error('No deterministic Google queries could be built for the product.');
    }
    const generated = await group.ai.generateQueries(product, allowedQueries);
    const queries = generated.slice(0, this.options.google.maxQueries);
    if (queries.length === 0) {
      return {
        queries: allowedQueries.slice(0, this.options.google.maxQueries),
        diagnostics: ['queryModelNoAllowedOutput=true', `deterministicQueries=${allowedQueries.length}`],
      };
    }
    return {
      queries,
      diagnostics: [`queryModel=${generated.length}`],
    };
  }

  private async selectRankedCandidates(
    group: ModelAgentGroup,
    product: ProductInput,
    queries: string[],
    limit: number,
  ): Promise<{ selected: SearchCandidate[]; diagnostics: string[] }> {
    const selected: SearchCandidate[] = [];
    const selectedUrls = new Set<string>();
    let serpCandidates = 0;

    for (const query of queries) {
      const candidates = await group.search.searchQuery(product, query);
      serpCandidates += candidates.length;
      if (candidates.length === 0) continue;

      const ranked = await group.ai.selectCandidates(product, query, candidates);
      for (const candidate of ranked) {
        if (selectedUrls.has(candidate.url)) continue;
        selectedUrls.add(candidate.url);
        selected.push(candidate);
        if (selected.length >= limit) break;
      }
      if (selected.length >= limit) break;
    }

    if (selected.length === 0) {
      throw new Error('Ranking selected no Google candidates.');
    }
    return {
      selected,
      diagnostics: [`serpCandidates=${serpCandidates}`, `selectedCandidates=${selected.length}`],
    };
  }

  private async validateCandidates(
    record: JobRecord,
    group: ModelAgentGroup,
    product: ProductInput,
    candidates: SearchCandidate[],
  ) {
    activateAgent(record, group, 'visual', product.sku || product.title);
    let visualCompleted = false;
    for (const candidate of candidates) {
      const page = await group.search.extract(candidate);
      const validation = await group.ai.validateProduct(product, page);
      if (validation.approved && page.images.length > 0) {
        completeAgentStage(record, group.agents.visual);
        visualCompleted = true;
        return { page, reason: validation.reason };
      }
    }
    if (!visualCompleted) group.activeRole = 'visual';
    throw new Error('No candidate clearly matched the product.');
  }

  private requireJob(id: string): JobRecord {
    const record = this.jobs.get(id);
    if (!record) throw new Error('Job not found');
    return record;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(minMs: number, maxMs: number): number {
  const min = Math.min(minMs, maxMs);
  const max = Math.max(minMs, maxMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function validateJobConfig(config: JobConfig): void {
  if (config.writePolicy !== 'fill-empty-only') {
    throw new Error('Only fill-empty-only write policy is supported.');
  }
  if (!config.workbookId || !config.sheetName) {
    throw new Error('workbookId and sheetName are required.');
  }
  if (!config.columnMapping.sku || !config.columnMapping.title) {
    throw new Error('SKU and title column mappings are required.');
  }
  if (!Array.isArray(config.columnMapping.imageColumns) || config.columnMapping.imageColumns.length === 0) {
    throw new Error('At least one image column mapping is required.');
  }
  if (!Number.isInteger(config.targetImageCount) || config.targetImageCount <= 0) {
    throw new Error('targetImageCount must be a positive integer.');
  }
}

function requireConfiguredModels(models: ModelConfig): void {
  const required: Array<[keyof ModelConfig, string]> = [
    ['query', 'GEMINI_QUERY_MODEL'],
    ['ranking', 'GEMINI_RANKING_MODEL'],
    ['visual', 'GEMINI_VISUAL_MODEL'],
    ['metadata', 'GEMINI_METADATA_MODEL'],
  ];
  for (const [key, envName] of required) {
    if (!models[key]) throw new Error(`${envName} must be configured in .env`);
  }
}

function createModelAgents(apiKey: ApiKeyConfig, models: ModelConfig): AgentStatus[] {
  return MODEL_AGENT_ROLES.map((role) => ({
    id: `${apiKey.id}-${role}`,
    label: `${roleLabel(role)} (${apiKey.label})`,
    role,
    model: modelForRole(role, models),
    apiKeyId: apiKey.id,
    apiKeyLabel: apiKey.label,
    groupId: apiKey.id,
    state: 'idle',
    activeProduct: null,
    manualAction: null,
    counts: { completed: 0, failed: 0 },
    lastError: null,
  }));
}

function agentsForApiKey(agents: AgentStatus[], apiKeyId: string): Record<ModelAgentRole, AgentStatus> {
  const entries = MODEL_AGENT_ROLES.map((role) => {
    const agent = agents.find((candidate) => candidate.apiKeyId === apiKeyId && candidate.role === role);
    if (!agent) throw new Error(`Missing ${role} agent for ${apiKeyId}`);
    return [role, agent] as const;
  });
  return Object.fromEntries(entries) as Record<ModelAgentRole, AgentStatus>;
}

function activateAgent(
  record: JobRecord,
  group: ModelAgentGroup,
  role: ModelAgentRole,
  productLabel: string | null,
): void {
  for (const agent of Object.values(group.agents)) {
    if (agent.role === role) continue;
    if (agent.state !== 'error') agent.state = 'idle';
    agent.activeProduct = null;
    agent.manualAction = null;
    emitAgent(record, agent, role);
  }

  const agent = group.agents[role];
  agent.state = 'active';
  agent.activeProduct = productLabel;
  agent.manualAction = null;
  agent.lastError = null;
  group.activeRole = role;
  emitAgent(record, agent, role);
}

function completeAgentStage(record: JobRecord, agent: AgentStatus): void {
  agent.counts.completed += 1;
  agent.state = 'idle';
  agent.manualAction = null;
  emitAgent(record, agent, agent.role);
}

function clearGroupAgents(record: JobRecord, group: ModelAgentGroup): void {
  group.activeRole = null;
  for (const agent of Object.values(group.agents)) {
    agent.state = 'idle';
    agent.activeProduct = null;
    agent.manualAction = null;
    emitAgent(record, agent, 'idle');
  }
}

function modelForRole(role: ModelAgentRole, models: ModelConfig): string {
  if (role === 'visual') return models.visual;
  return models[role];
}

function roleLabel(role: ModelAgentRole): string {
  if (role === 'query') return 'Query';
  if (role === 'ranking') return 'Ranking';
  if (role === 'visual') return 'Visual';
  return 'Metadata';
}

function emitAgent(record: JobRecord, agent: AgentStatus, stage: string): void {
  record.status.currentStage = stage;
  record.emitter.emit('event', { type: 'agent', data: agent } satisfies JobEvent);
  record.emitter.emit('event', { type: 'status', data: record.status } satisfies JobEvent);
}

function emitProduct(record: JobRecord, result: ProductResult): void {
  record.emitter.emit('event', { type: 'product', data: result } satisfies JobEvent);
  record.emitter.emit('event', { type: 'status', data: record.status } satisfies JobEvent);
}

function emitStatus(record: JobRecord, state: JobStatus['state'], stage: string): void {
  record.status.state = state;
  record.status.currentStage = stage;
  record.emitter.emit('event', { type: 'status', data: record.status } satisfies JobEvent);
}

function writeCheckpoint(record: JobRecord): void {
  fs.writeFileSync(
    path.join(record.jobDir, 'checkpoint.json'),
    JSON.stringify(
      {
        version: 1,
        jobId: record.id,
        config: record.config,
        status: record.status,
        agents: record.agents,
        results: normalizeCheckpoint({ results: record.results }),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
