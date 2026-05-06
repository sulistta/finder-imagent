import { afterEach, describe, expect, it, vi } from 'vitest';

import { callGeminiJson, GeminiAiProvider } from '../src/gemini.js';
import type { ProductInput, SearchCandidate } from '../src/types.js';

describe('Gemini JSON responses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests JSON without native Structured Outputs fields', async () => {
    let requestBody: unknown;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"urls":["https://shop.test/a"]}' }] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await callGeminiJson('api-key', 'gemma-4-31b-it', ['rank']);

    expect(requestBody).toMatchObject({
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });
    expect(requestBody).not.toHaveProperty('generationConfig.responseJsonSchema');
    expect(requestBody).not.toHaveProperty('generationConfig.responseSchema');
  });

  it('filters query model output to the local allowlist', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      queries: ['comprar Printer toner', 'Printer toner', 'HP 85A'],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = new GeminiAiProvider(
      { id: 'key-1', label: 'Google 1', key: 'secret' },
      {
        query: 'query-model',
        ranking: 'gemma-4-31b-it',
        visual: 'visual-model',
        metadata: 'metadata-model',
      },
    );

    await expect(provider.generateQueries(productFixture, ['Printer toner', 'HP 85A'])).resolves.toEqual([
      'Printer toner',
      'HP 85A',
    ]);
  });

  it('selects only existing Google candidates from JSON model output', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      candidatos: [
                        { href: 'https://shop.test/b', motivo: 'modelo correto' },
                        { href: 'https://missing.test/product', motivo: 'inventado' },
                        { href: 'https://shop.test/b', motivo: 'duplicado' },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = providerFixture();
    const candidates: SearchCandidate[] = [
      { url: 'https://shop.test/a', title: 'A', snippet: 'A' },
      { url: 'https://shop.test/b', title: 'B', snippet: 'B' },
    ];

    await expect(provider.selectCandidates(productFixture, 'Printer toner', candidates)).resolves.toEqual([
      { url: 'https://shop.test/b', title: 'B', snippet: 'B', reason: 'modelo correto' },
    ]);
  });

  it('accepts a single JSON object followed by extra model text without selecting invented URLs', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: `${JSON.stringify({
                      candidatos: [
                        { href: 'https://shop.test/b', motivo: 'modelo correto' },
                        { href: 'https://missing.test/product', motivo: 'inventado' },
                      ],
                    })}\nObservacao fora do JSON.`,
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const provider = providerFixture();
    const candidates: SearchCandidate[] = [
      { url: 'https://shop.test/a', title: 'A', snippet: 'A' },
      { url: 'https://shop.test/b', title: 'B', snippet: 'B' },
    ];

    await expect(provider.selectCandidates(productFixture, 'Printer toner', candidates)).resolves.toEqual([
      { url: 'https://shop.test/b', title: 'B', snippet: 'B', reason: 'modelo correto' },
    ]);
  });

  it('rejects visual matches for conflicting model variants before calling Gemini', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = providerFixture();

    await expect(
      provider.validateProduct(
        { ...productFixture, title: 'Cartucho HP 92 Preto' },
        {
          url: 'https://shop.test/hp-92xl',
          title: 'Cartucho HP 92XL Preto',
          h1: 'Cartucho HP 92XL',
          metaDescription: 'Alto rendimento',
          jsonLdProducts: [],
          text: 'Cartucho de tinta HP 92XL preto alto rendimento',
          images: ['https://cdn.test/image.jpg'],
        },
      ),
    ).resolves.toMatchObject({
      approved: false,
      reason: expect.stringContaining('92XL'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function providerFixture(): GeminiAiProvider {
  return new GeminiAiProvider(
    { id: 'key-1', label: 'Google 1', key: 'secret' },
    {
      query: 'query-model',
      ranking: 'gemma-4-31b-it',
      visual: 'visual-model',
      metadata: 'metadata-model',
    },
  );
}

const productFixture: ProductInput = {
  rowNumber: 2,
  sku: 'SKU-1',
  title: 'Printer toner',
  existingImages: [],
  emptyMetadataFields: [],
};
