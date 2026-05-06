import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import type { Page } from 'playwright';

import type { ApiKeyConfig, ModelConfig, ProductInput, SearchCandidate } from './types.js';

const require = createRequire(__filename);
const DEFAULT_PAGE_AGENT_TIMEOUT_MS = 90_000;
const PAGE_AGENT_BRIDGE_NAME = '__imageFinderPageAgentFetch';
const exposedPages = new WeakSet<Page>();

export interface PageAgentRankingOptions {
  page: Page;
  product: ProductInput;
  query: string;
  candidates: SearchCandidate[];
  apiKey: ApiKeyConfig;
  models: ModelConfig;
  bundlePath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface PageAgentSelectionResponse {
  candidatos?: Array<{
    href?: string;
    motivo?: string;
  }>;
}

interface ForwardedRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface PageAgentExecutionResult {
  data: string;
  success: boolean;
}

export async function selectCandidatesWithPageAgent(options: PageAgentRankingOptions): Promise<SearchCandidate[]> {
  if (options.candidates.length === 0) return [];
  if (!options.models.ranking) throw new Error('GEMINI_RANKING_MODEL must be configured in .env');
  if (!options.models.baseUrl) throw new Error('GEMINI_BASE_URL must be configured in .env');

  await ensurePageAgentBridge(options.page, options.apiKey, options.fetchImpl ?? fetch);
  await injectPageAgent(options.page, options.bundlePath ?? resolvePageAgentBundlePath());

  const responseText = await runPageAgentRanking(options);
  return normalizePageAgentSelection(responseText, options.candidates);
}

export function getSuccessfulPageAgentData(result: PageAgentExecutionResult): string {
  if (result.success) return result.data;
  throw new Error(`PageAgent ranking failed: ${result.data || 'unknown error'}`);
}

export function normalizePageAgentSelection(responseText: string, candidates: SearchCandidate[]): SearchCandidate[] {
  const response = parsePageAgentJson<PageAgentSelectionResponse>(responseText);
  const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]));
  const seen = new Set<string>();
  const selected: SearchCandidate[] = [];

  for (const item of response.candidatos ?? []) {
    const url = typeof item.href === 'string' ? item.href.trim() : '';
    const candidate = byUrl.get(url);
    if (!candidate || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const reason = typeof item.motivo === 'string' ? item.motivo.replace(/\s+/g, ' ').trim() : '';
    selected.push({ ...candidate, ...(reason ? { reason } : {}) });
  }

  return selected;
}

export function sanitizePageAgentRequestBody(bodyText: string | undefined): Record<string, unknown> {
  const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  delete body.response_format;
  delete body.reasoning_effort;
  return body;
}

export async function forwardPageAgentGeminiRequest(
  request: ForwardedRequest,
  apiKey: ApiKeyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (!request.url) throw new Error('PageAgent Gemini request is missing URL');
  const headers = new Headers(request.headers ?? {});
  headers.delete('authorization');
  headers.delete('x-goog-api-key');
  headers.set('Authorization', `Bearer ${apiKey.key}`);
  headers.set('Content-Type', 'application/json');
  const body = sanitizePageAgentRequestBody(request.body);

  const response = await fetchImpl(request.url, {
    method: request.method || 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: headersToRecord(response.headers),
    body: await response.text(),
  };
}

function resolvePageAgentBundlePath(): string {
  const entrypointPath = require.resolve('page-agent');
  const bundlePath = path.resolve(path.dirname(entrypointPath), '..', 'iife', 'page-agent.demo.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`PageAgent IIFE bundle not found at ${bundlePath}`);
  }
  return bundlePath;
}

async function ensurePageAgentBridge(page: Page, apiKey: ApiKeyConfig, fetchImpl: typeof fetch): Promise<void> {
  if (exposedPages.has(page)) return;
  await page.exposeFunction(PAGE_AGENT_BRIDGE_NAME, (request: ForwardedRequest) =>
    forwardPageAgentGeminiRequest(request, apiKey, fetchImpl),
  );
  exposedPages.add(page);
}

async function injectPageAgent(page: Page, bundlePath: string): Promise<void> {
  const hasPageAgent = await page.evaluate(() => Boolean(window.PageAgent)).catch(() => false);
  if (hasPageAgent) return;
  await page.addScriptTag({ path: bundlePath });
  await page.waitForFunction(() => Boolean(window.PageAgent), null, { timeout: 5_000 });
}

async function runPageAgentRanking(options: PageAgentRankingOptions): Promise<string> {
  const task = buildRankingTask(options.product, options.query, options.candidates);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAGE_AGENT_TIMEOUT_MS;
  const result = await pageAgentTimeout(
    options.page.evaluate(
      async ({ baseUrl, bridgeName, model, taskText, timeout }) => {
        const PageAgentClass = window.PageAgent;
        if (!PageAgentClass) throw new Error('PageAgent was not loaded on Google page');
        window.pageAgent?.dispose?.();
        window.pageAgent = new PageAgentClass({
          apiKey: 'backend-bridge',
          baseURL: baseUrl.replace(/\/$/, ''),
          enableMask: false,
          customFetch: async (url: RequestInfo | URL, init: RequestInit = {}) => {
            const headers: Record<string, string> = {};
            new Headers(init.headers || {}).forEach((value, key) => {
              headers[key] = value;
            });
            const bridge = (window as unknown as Record<string, Window['__imageFinderPageAgentFetch']>)[bridgeName];
            if (!bridge) throw new Error('PageAgent Gemini bridge was not installed');
            const response = await bridge({
              url: String(url),
              method: init.method || 'POST',
              headers,
              body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body ?? {}),
            });
            return new Response(response.body, {
              status: response.status,
              headers: response.headers,
            });
          },
          language: 'pt-BR',
          maxSteps: 1,
          model,
          promptForNextTask: false,
          stepDelay: 0.2,
          temperature: 0,
          transformRequestBody: (body: Record<string, unknown>) => {
            const nextBody = { ...body };
            delete nextBody.reasoning_effort;
            return nextBody;
          },
        });
        window.pageAgent.panel?.hide?.();
        let timer: number | null = null;
        try {
          const timeoutResult = new Promise<PageAgentExecutionResult>((resolve) => {
            timer = window.setTimeout(() => {
              window.pageAgent?.stop?.();
              resolve({
                success: false,
                data: `Timed out while PageAgent selected Google candidates after ${timeout}ms`,
              });
            }, timeout);
          });
          return await Promise.race([window.pageAgent.execute(taskText), timeoutResult]);
        } finally {
          if (timer !== null) window.clearTimeout(timer);
        }
      },
      {
        baseUrl: options.models.baseUrl,
        bridgeName: PAGE_AGENT_BRIDGE_NAME,
        model: options.models.ranking,
        taskText: task,
        timeout: timeoutMs,
      },
    ),
    timeoutMs + 5_000,
    () => stopPageAgent(options.page),
  );
  return getSuccessfulPageAgentData(result);
}

function buildRankingTask(product: ProductInput, query: string, candidates: SearchCandidate[]): string {
  return [
    'Voce esta na pagina de resultados do Google. Use os elementos visiveis da SERP para escolher somente links organicos relevantes.',
    'Nao navegue para paginas de produto. Nao clique em anuncios. Nao invente URLs.',
    `Produto: SKU ${product.sku}; nome ${product.title}; categoria ${product.category || 'n/a'}.`,
    `Query usada: ${query}.`,
    'URLs permitidas:',
    JSON.stringify(
      candidates.map((candidate, index) => ({
        index: index + 1,
        href: candidate.url,
        title: candidate.title,
        snippet: candidate.snippet.slice(0, 600),
      })),
    ),
    'A unica acao permitida e done. Finalize imediatamente com done.',
    'Coloque no campo text SOMENTE JSON valido no formato {"candidatos":[{"href":"...","motivo":"..."}]}.',
    'Cada href deve ser exatamente uma URL permitida. Se nenhum resultado corresponder claramente, retorne {"candidatos":[]}.',
  ].join('\n');
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

async function pageAgentTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => Promise<void>): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void onTimeout?.();
          reject(new Error(`Timed out while PageAgent selected Google candidates after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function stopPageAgent(page: Page): Promise<void> {
  await page.evaluate(() => window.pageAgent?.stop?.()).catch(() => undefined);
}

function parsePageAgentJson<T>(text: string): T {
  const jsonText = extractFirstJsonObject(text);
  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`${message}; response preview=${JSON.stringify(preview)}`);
  }
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return text;
}

declare global {
  interface Window {
    PageAgent?: new (config: Record<string, unknown>) => {
      execute(task: string): Promise<{ data: string; success: boolean }>;
      panel?: { hide?: () => void };
      dispose?: () => void;
    };
    pageAgent?: {
      execute(task: string): Promise<{ data: string; success: boolean }>;
      panel?: { hide?: () => void };
      dispose?: () => void;
      stop?: () => void;
    };
    __imageFinderPageAgentFetch?: (request: ForwardedRequest) => Promise<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>;
  }
}
