import type {
  ApiKeyConfig,
  ExtractedPage,
  MetadataColumnKey,
  ModelConfig,
  ProductInput,
  SearchCandidate,
  VisualValidation,
} from './types.js';

export interface AiProvider {
  generateQueries(product: ProductInput, allowedQueries: string[]): Promise<string[]>;
  selectCandidates(product: ProductInput, query: string, candidates: SearchCandidate[]): Promise<SearchCandidate[]>;
  validateProduct(product: ProductInput, page: ExtractedPage): Promise<VisualValidation>;
  generateMetadata(
    product: ProductInput,
    page: ExtractedPage,
    fields: MetadataColumnKey[],
  ): Promise<Partial<Record<MetadataColumnKey, string>>>;
}

export class GeminiAiProvider implements AiProvider {
  constructor(
    private readonly apiKey: ApiKeyConfig,
    private readonly models: ModelConfig,
  ) {}

  async generateQueries(product: ProductInput, allowedQueries: string[]): Promise<string[]> {
    const model = requireModel(this.models.query, 'GEMINI_QUERY_MODEL');
    const response = await callGeminiJson<{ queries?: string[] }>(this.apiKey.key, model, [
      `Escolha e ordene ate ${allowedQueries.length} buscas Google naturais em pt-BR para encontrar imagem e pagina do produto.`,
      `Produto: SKU ${product.sku}; nome ${product.title}; categoria ${product.category || 'n/a'}.`,
      `Use somente buscas desta lista permitida, sem criar termos novos: ${JSON.stringify(allowedQueries)}.`,
      'Responda somente JSON no formato {"queries":["termo"]}. Cada item de queries deve ser copia exata de uma busca permitida.',
    ]);
    return normalizeAllowedQueries(response.queries ?? [], allowedQueries);
  }

  async selectCandidates(product: ProductInput, query: string, candidates: SearchCandidate[]): Promise<SearchCandidate[]> {
    if (candidates.length === 0) return [];
    const model = requireModel(this.models.ranking, 'GEMINI_RANKING_MODEL');
    const response = await callGeminiJson<{ candidatos?: Array<{ href?: string; motivo?: string }> }>(this.apiKey.key, model, [
      'Selecione apenas resultados organicos realmente relevantes para o produto procurado.',
      `Produto: SKU ${product.sku}; nome ${product.title}; categoria ${product.category || 'n/a'}.`,
      `Query usada no Google: ${query}.`,
      JSON.stringify({
        candidatosDisponiveis: candidates.map((candidate, index) => ({
          index: index + 1,
          href: candidate.url,
          texto: [candidate.title, candidate.snippet].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 900),
        })),
      }),
      'Responda somente JSON no formato {"candidatos":[{"href":"...","motivo":"..."}]}. Nao invente URLs. Cada href deve ser exatamente um href de candidatosDisponiveis. Se nenhum parecer relacionado, retorne lista vazia.',
    ]);
    const requested = response.candidatos ?? [];
    const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]));
    const selected = new Set<string>();
    return requested.flatMap((item) => {
      const url = typeof item.href === 'string' ? item.href : '';
      const candidate = byUrl.get(url);
      if (!candidate || selected.has(candidate.url)) return [];
      selected.add(candidate.url);
      const reason = typeof item.motivo === 'string' ? item.motivo.replace(/\s+/g, ' ').trim() : '';
      return [{ ...candidate, ...(reason ? { reason } : {}) }];
    });
  }

  async validateProduct(product: ProductInput, page: ExtractedPage): Promise<VisualValidation> {
    const conflictingVariant = findConflictingModelVariant(product, page);
    if (conflictingVariant) {
      return {
        approved: false,
        reason: `A pagina indica variante/modelo diferente (${conflictingVariant}) sem correspondencia exata clara.`,
      };
    }
    const model = requireModel(this.models.visual, 'GEMINI_VISUAL_MODEL');
    const response = await callGeminiJson<{ approved?: boolean; reason?: string }>(this.apiKey.key, model, [
      `Valide se a pagina corresponde claramente ao produto. SKU: ${product.sku}. Nome: ${product.title}.`,
      JSON.stringify({
        url: page.url,
        title: page.title,
        h1: page.h1,
        metaDescription: page.metaDescription,
        text: page.text.slice(0, 1_500),
        images: page.images.slice(0, 8),
      }),
      'Responda somente JSON no formato {"approved":true,"reason":"..."}. Aprove somente correspondencia clara de identificadores, modelo/codigo e produto. Rejeite variantes como XL se o produto solicitado nao tiver essa variante.',
    ]);
    return {
      approved: response.approved === true,
      reason: response.reason || 'Resposta sem justificativa.',
    };
  }

  async generateMetadata(
    product: ProductInput,
    page: ExtractedPage,
    fields: MetadataColumnKey[],
  ): Promise<Partial<Record<MetadataColumnKey, string>>> {
    if (fields.length === 0) return {};
    const model = requireModel(this.models.metadata, 'GEMINI_METADATA_MODEL');
    return callGeminiJson<Partial<Record<MetadataColumnKey, string>>>(this.apiKey.key, model, [
      `Gere metadados em pt-BR apenas para os campos solicitados: ${fields.join(', ')}.`,
      `Produto: SKU ${product.sku}; nome ${product.title}; categoria ${product.category || 'n/a'}.`,
      JSON.stringify({
        sourceUrl: page.url,
        h1: page.h1,
        metaDescription: page.metaDescription,
        text: page.text.slice(0, 2_000),
      }),
      'Responda somente JSON. Campos permitidos: description, category, seoTitle, seoDescription, seoKeywords.',
    ]);
  }
}

export async function callGeminiJson<T>(
  apiKey: string,
  model: string,
  textParts: string[],
): Promise<T> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: textParts.map((text) => ({ text })) }],
        generationConfig: {
          responseMimeType: 'application/json',
        },
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '{}';
  return parseGeminiJson<T>(text);
}

function requireModel(model: string, envName: string): string {
  if (!model) {
    throw new Error(`${envName} must be configured in .env`);
  }
  return model;
}

function normalizeAllowedQueries(queries: string[], allowedQueries: string[]): string[] {
  const byNormalized = new Map(allowedQueries.map((query) => [normalizeQueryKey(query), query]));
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const query of queries) {
    const allowed = byNormalized.get(normalizeQueryKey(query));
    if (!allowed || seen.has(allowed)) continue;
    seen.add(allowed);
    normalized.push(allowed);
  }
  return normalized;
}

function normalizeQueryKey(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

function findConflictingModelVariant(product: ProductInput, page: ExtractedPage): string | null {
  const productTokens = tokenizeModelText(product.title);
  const pageTokens = tokenizeModelText([page.title, page.h1, page.metaDescription, page.text].join(' '));
  const pageTokenSet = new Set(pageTokens);

  for (const token of productTokens) {
    if (!/\d/.test(token) || token.length < 2) continue;
    if (pageTokenSet.has(token)) continue;
    const conflict = pageTokens.find((pageToken) => pageToken.startsWith(token) && pageToken.length > token.length);
    if (conflict) return conflict.toUpperCase();
  }
  return null;
}

function tokenizeModelText(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[a-z]*\d+[a-z0-9]*/g) ?? [];
}

function parseGeminiJson<T>(text: string): T {
  const jsonText = extractFirstJsonObject(text);
  try {
    return JSON.parse(jsonText) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 140);
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
