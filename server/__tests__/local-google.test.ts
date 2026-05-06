import { describe, expect, it } from 'vitest';

import {
  extractImageUrlsFromPageSnapshot,
  filterImageUrls,
  isGoogleCaptchaChallenge,
  normalizeSearchCandidates,
  rankSearchCandidatesForProduct,
} from '../src/google.js';

describe('google candidate normalization', () => {
  it('drops google/social/video/tracking candidates and deduplicates URLs', () => {
    const candidates = normalizeSearchCandidates([
      { url: 'https://www.google.com/search?q=x', title: 'Google', snippet: '' },
      {
        url: 'https://www.google.com/url?q=https%3A%2F%2Fshop.test%2Fproduct%3Futm_source%3Dx%23details',
        title: 'Redirected product',
        snippet: 'A',
      },
      { url: 'https://www.google.com/shopping/product/123?hl=pt-BR', title: 'Shopping product', snippet: 'B' },
      { url: 'https://www.youtube.com/watch?v=1', title: 'Video', snippet: '' },
      { url: 'https://shop.test/product?utm_source=x#details', title: 'Product', snippet: 'A' },
      { url: 'https://shop.test/product', title: 'Product duplicate', snippet: 'B' },
      { url: 'https://cdn.test/photo.jpg', title: 'Image file', snippet: '' },
    ]);
    expect(candidates).toEqual([
      { url: 'https://shop.test/product', title: 'Redirected product', snippet: 'A' },
      { url: 'https://www.google.com/shopping/product/123?hl=pt-BR', title: 'Shopping product', snippet: 'B' },
    ]);
  });

  it('keeps useful page images and filters tracking assets', () => {
    expect(
      filterImageUrls([
        'https://shop.test/product.jpg',
        'https://shop.test/pixel.gif',
        'https://www.google.com/logo.png',
        'https://shop.test/product.jpg?utm_source=x',
      ]),
    ).toEqual(['https://shop.test/product.jpg']);
  });

  it('extracts product images from lazy, meta, JSON-LD, and extensionless CDN candidates', () => {
    expect(
      extractImageUrlsFromPageSnapshot(
        {
          baseUrl: 'https://shop.test/product',
          candidates: [
            { url: '/lazy/product.webp', score: 5, width: 640, height: 640, source: 'data-src product gallery' },
            { url: 'https://shop.test/logo.png', score: 9, width: 500, height: 200, source: 'site logo' },
            { url: 'https://cdn.test/image-no-extension?id=1', score: 8, width: 900, height: 900, source: 'json-ld' },
            { url: 'https://cdn.test/hero.jpg', score: 8, width: 0, height: 0, source: 'og:image' },
            { url: 'data:image/png;base64,abc', score: 10, width: 900, height: 900, source: 'inline' },
          ],
        },
        'https://shop.test/product',
      ),
    ).toEqual([
      'https://cdn.test/image-no-extension?id=1',
      'https://cdn.test/hero.jpg',
      'https://shop.test/lazy/product.webp',
    ]);
  });

  it('ranks deterministic fallback candidates by product tokens and keeps a permissive fallback', () => {
    const product = {
      rowNumber: 2,
      sku: 'HP-92',
      title: 'Cartucho HP 92 Preto',
      existingImages: [],
      emptyMetadataFields: [],
      category: 'Cartuchos',
    };
    const candidates = [
      { url: 'https://shop.test/random', title: 'Papel A4', snippet: '' },
      { url: 'https://shop.test/prod/hp-92', title: 'Cartucho HP 92 preto original', snippet: 'produto correto' },
      { url: 'https://shop.test/prod/hp-93', title: 'Cartucho HP 93 colorido', snippet: '' },
    ];

    expect(rankSearchCandidatesForProduct(product, candidates).map((candidate) => candidate.url)).toEqual([
      'https://shop.test/prod/hp-92',
      'https://shop.test/prod/hp-93',
      'https://shop.test/random',
    ]);
    expect(
      rankSearchCandidatesForProduct(product, [
        { url: 'https://shop.test/a', title: 'Sem relacao', snippet: '' },
        { url: 'https://shop.test/b', title: 'Outro item', snippet: '' },
        { url: 'https://shop.test/c', title: 'Mais um', snippet: '' },
        { url: 'https://shop.test/d', title: 'Extra', snippet: '' },
      ]).map((candidate) => candidate.url),
    ).toEqual(['https://shop.test/a', 'https://shop.test/b', 'https://shop.test/c']);
  });

  it('detects Google CAPTCHA and unusual traffic pages', () => {
    expect(
      isGoogleCaptchaChallenge({
        url: 'https://www.google.com/sorry/index?continue=https://www.google.com/search',
        bodyText: 'Não sou um robô. Nossos sistemas detectaram tráfego incomum.',
        frameUrls: ['https://www.google.com/recaptcha/api2/anchor'],
      }),
    ).toBe(true);
    expect(
      isGoogleCaptchaChallenge({
        url: 'https://www.google.com/search?q=printer',
        bodyText: 'Resultados da pesquisa',
        frameUrls: [],
      }),
    ).toBe(false);
  });
});
