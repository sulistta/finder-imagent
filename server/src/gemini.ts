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
  generateQueries(product: ProductInput, deterministicQueries: string[]): Promise<string[]>;
  rankCandidates(product: ProductInput, candidates: SearchCandidate[]): Promise<SearchCandidate[]>;
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

  async generateQueries(product: ProductInput, deterministicQueries: string[]): Promise<string[]> {
    const model = requireModel(this.models.query, 'GEMINI_QUERY_MODEL');
    const response = await callGeminiJson<{ queries?: string[] }>(this.apiKey.key, model, [
      `Gere ate ${deterministicQueries.length} buscas Google naturais em pt-BR para encontrar imagem e pagina do produto.`,
      `Produto: SKU ${product.sku}; nome ${product.title}; categoria ${product.category || 'n/a'}.`,
      `Use estas buscas deterministicas como base e preserve codigos/modelos importantes: ${JSON.stringify(deterministicQueries)}.`,
      'Responda JSON: {"queries":["termo 1","termo 2"]}.',
    ]);
    return normalizeQueries(response.queries ?? []);
  }

  async rankCandidates(product: ProductInput, candidates: SearchCandidate[]): Promise<SearchCandidate[]> {
    if (candidates.length <= 1) return candidates;
    const model = requireModel(this.models.ranking, 'GEMINI_RANKING_MODEL');
    const response = await callGeminiJson<{ urls?: string[] }>(this.apiKey.key, model, [
      `Escolha as URLs mais provaveis para o produto. SKU: ${product.sku}. Nome: ${product.title}.`,
      JSON.stringify(candidates.map(({ url, title, snippet }) => ({ url, title, snippet }))),
      'Responda JSON: {"urls":["https://..."]}.',
    ]);
    const requested = response.urls ?? [];
    const byUrl = new Map(candidates.map((candidate) => [candidate.url, candidate]));
    const ranked = requested.map((url) => byUrl.get(url)).filter((candidate): candidate is SearchCandidate => Boolean(candidate));
    return ranked.length > 0 ? [...ranked, ...candidates.filter((candidate) => !requested.includes(candidate.url))] : candidates;
  }

  async validateProduct(product: ProductInput, page: ExtractedPage): Promise<VisualValidation> {
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
      'Responda JSON: {"approved":true,"reason":"..."}. Aprove somente correspondencia clara.',
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
      'Campos JSON permitidos: description, category, seoTitle, seoDescription, seoKeywords.',
    ]);
  }
}

async function callGeminiJson<T>(apiKey: string, model: string, textParts: string[]): Promise<T> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: textParts.map((text) => ({ text })) }],
        generationConfig: { responseMimeType: 'application/json' },
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
  return JSON.parse(text) as T;
}

function requireModel(model: string, envName: string): string {
  if (!model) {
    throw new Error(`${envName} must be configured in .env`);
  }
  return model;
}

function normalizeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const query of queries) {
    const clean = query.replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 140 || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }
  return normalized;
}
