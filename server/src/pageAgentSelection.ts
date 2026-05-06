import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import type { Page } from 'playwright';

import type { ApiKeyConfig, ModelConfig, ProductInput, SearchCandidate } from './types.js';

const require = createRequire(__filename);
const PAGE_AGENT_TIMEOUT_MS = 25_000;
const PAGE_AGENT_DUMMY_KEY = 'backend-proxy';
const bridgeStates = new WeakMap<Page, PageAgentBridgeState>();

interface PageAgentBridgeState {
  apiKey: ApiKeyConfig;
  fetchImpl: typeof fetch;
}

interface PageAgentForwardRequest {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

interface PageAgentForwardResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

interface PageAgentResultItem {
  href?: unknown;
  url?: unknown;
  motivo?: unknown;
  reason?: unknown;
}

interface PageAgentPayload {
  candidatos?: PageAgentResultItem[];
  candidates?: PageAgentResultItem[];
  href?: unknown;
  url?: unknown;
  motivo?: unknown;
  reason?: unknown;
}

interface PageAgentWindowAgent {
  execute(task: string): Promise<{ success?: boolean; data?: unknown }>;
  dispose?: () => void;
}

declare global {
  interface Window {
    PageAgent?: new (config: Record<string, unknown>) => PageAgentWindowAgent;
    __imageFinderPageAgent?: PageAgentWindowAgent | null;
    __pageAgentFetch?: (request: PageAgentForwardRequest) => Promise<PageAgentForwardResponse>;
  }
}

export interface PageAgentSelectionOptions {
  page: Page;
  product: ProductInput;
  query: string;
  candidates: SearchCandidate[];
  apiKey: ApiKeyConfig;
  models: ModelConfig;
  bundlePath?: string;
  fetchImpl?: typeof fetch;
}

export function resolvePageAgentBundlePath(): string {
  const entryPath = require.resolve('page-agent');
  const bundlePath = path.resolve(path.dirname(entryPath), '../iife/page-agent.demo.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`PageAgent IIFE bundle not found at ${bundlePath}. Run npm install.`);
  }
  return bundlePath;
}

export async function selectCandidatesWithPageAgent({
  page,
  product,
  query,
  candidates,
  apiKey,
  models,
  bundlePath = resolvePageAgentBundlePath(),
  fetchImpl = fetch,
}: PageAgentSelectionOptions): Promise<SearchCandidate[]> {
  if (candidates.length === 0) return [];
  if (!models.ranking) throw new Error('GEMINI_RANKING_MODEL must be configured in .env');

  await installPageAgentBridge(page, { apiKey, fetchImpl });
  await injectPageAgent(page, bundlePath);
  const payload = await withTimeout(
    executePageAgentTask(page, {
      task: buildCandidateSelectionPrompt(product, query, candidates),
      baseURL: models.baseUrl,
      model: models.ranking,
    }),
    PAGE_AGENT_TIMEOUT_MS,
    'Timed out while PageAgent selected Google candidates',
  );
  return normalizePageAgentSelection(payload, candidates);
}

export function normalizePageAgentSelection(payload: unknown, candidates: SearchCandidate[]): SearchCandidate[] {
  const items = readPayloadItems(payload);
  const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]));
  const selected = new Set<string>();
  const normalized: SearchCandidate[] = [];

  for (const item of items) {
    const url = typeof item.href === 'string' ? item.href : typeof item.url === 'string' ? item.url : '';
    const candidate = byUrl.get(url);
    if (!candidate || selected.has(candidate.url)) continue;
    selected.add(candidate.url);
    normalized.push({
      ...candidate,
      reason: cleanText(
        typeof item.motivo === 'string' ? item.motivo : typeof item.reason === 'string' ? item.reason : '',
      ),
    });
  }

  return normalized;
}

export async function forwardPageAgentGeminiRequest(
  request: PageAgentForwardRequest,
  apiKey: ApiKeyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PageAgentForwardResponse> {
  const headers = normalizeHeaders(request.headers);
  for (const headerName of Object.keys(headers)) {
    const lowerName = headerName.toLowerCase();
    if (lowerName === 'authorization' || lowerName === 'x-goog-api-key') {
      delete headers[headerName];
    }
  }
  headers.Authorization = `Bearer ${apiKey.key}`;

  const response = await fetchImpl(request.url, {
    method: request.method || 'GET',
    headers,
    body: request.body,
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    body: await response.text(),
  };
}

async function installPageAgentBridge(page: Page, state: PageAgentBridgeState): Promise<void> {
  if (bridgeStates.has(page)) {
    bridgeStates.set(page, state);
    return;
  }

  bridgeStates.set(page, state);
  await page.exposeBinding('__pageAgentFetch', async (_source, request: PageAgentForwardRequest) => {
    const current = bridgeStates.get(page) ?? state;
    return forwardPageAgentGeminiRequest(request, current.apiKey, current.fetchImpl);
  });
}

async function injectPageAgent(page: Page, bundlePath: string): Promise<void> {
  await page.addScriptTag({ path: bundlePath });
  await page.waitForFunction(() => Boolean(window.PageAgent), null, { timeout: 5_000 });
}

async function executePageAgentTask(
  page: Page,
  {
    task,
    baseURL,
    model,
  }: {
    task: string;
    baseURL: string;
    model: string;
  },
): Promise<unknown> {
  const result = await page.evaluate(
    async ({ task, baseURL, model, apiKey }) => {
      if (!window.PageAgent) throw new Error('PageAgent was not loaded on the page.');
      if (!window.__pageAgentFetch) throw new Error('PageAgent backend fetch bridge was not installed.');

      window.__imageFinderPageAgent?.dispose?.();
      const agent = new window.PageAgent({
        model,
        baseURL,
        apiKey,
        language: 'pt-BR',
        enableMask: false,
        promptForNextTask: false,
        maxSteps: 1,
        stepDelay: 0.2,
        customFetch: async (_url: string, options: RequestInit = {}) => {
          const headersToObject = (headers: Headers) => {
            const record: Record<string, string> = {};
            headers.forEach((value, key) => {
              record[key] = value;
            });
            return record;
          };
          const headers = options.headers instanceof Headers ? headersToObject(options.headers) : options.headers;
          const response = await window.__pageAgentFetch!({
            url: _url,
            method: options.method,
            headers,
            body: typeof options.body === 'string' ? options.body : null,
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
        transformRequestBody: (body: Record<string, unknown>) => {
          const nextBody = { ...body };
          delete nextBody.reasoning_effort;
          return nextBody;
        },
      });

      window.__imageFinderPageAgent = agent;
      const output = await agent.execute(task);
      agent.dispose?.();
      window.__imageFinderPageAgent = null;
      return output.data;
    },
    { task, baseURL, model, apiKey: PAGE_AGENT_DUMMY_KEY },
  );
  return parseAgentPayload(result);
}

function buildCandidateSelectionPrompt(
  product: ProductInput,
  query: string,
  candidates: SearchCandidate[],
): string {
  const context = {
    produtoProcurado: {
      sku: product.sku,
      nome: product.title,
      categoria: product.category || '',
    },
    busca: { loja: 'Google', query },
    candidatosDisponiveis: candidates.map((candidate, index) => ({
      index: index + 1,
      href: candidate.url,
      texto: cleanText([candidate.title, candidate.snippet].filter(Boolean).join(' ')).slice(0, 900),
    })),
  };

  return `
Selecione os resultados organicos mais relevantes da lista de candidatos disponiveis.

Regras:
- Retorne apenas candidatos que parecam relevantes para o produto procurado.
- Ordene do mais provavel para o menos provavel.
- Prefira resultados com mesmo nome completo, modelo, codigo, cor e tipo de produto.
- Nao invente URLs; cada href deve ser exatamente um href de candidatosDisponiveis.
- Se nenhum candidato parecer minimamente relacionado, retorne lista vazia.
- Responda apenas JSON valido, sem markdown.

Dados:
${JSON.stringify(context, null, 2)}

Formato obrigatorio:
{
  "candidatos": [
    {
      "href": "href exato escolhido",
      "motivo": "explicacao curta"
    }
  ]
}
`.trim();
}

function readPayloadItems(payload: unknown): PageAgentResultItem[] {
  const parsed = parseAgentPayload(payload);
  if (Array.isArray(parsed)) return parsed.filter(isPageAgentResultItem);
  if (!parsed || typeof parsed !== 'object') return [];
  const objectPayload = parsed as PageAgentPayload;
  if (Array.isArray(objectPayload.candidatos)) return objectPayload.candidatos;
  if (Array.isArray(objectPayload.candidates)) return objectPayload.candidates;
  if (objectPayload.href || objectPayload.url) return [objectPayload];
  return [];
}

function parseAgentPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  const trimmed = payload.trim();
  if (!trimmed) throw new Error('PageAgent returned an empty response.');
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced?.[1]?.trim() || trimmed);
}

function isPageAgentResultItem(value: unknown): value is PageAgentResultItem {
  return Boolean(value && typeof value === 'object');
}

function normalizeHeaders(headers: HeadersInit | undefined = {}): Record<string, string> {
  if (headers instanceof Headers) return headersToRecord(headers);
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
