import { describe, expect, it } from 'vitest';

import { filterImageUrls, isGoogleCaptchaChallenge, normalizeSearchCandidates } from '../src/google.js';

describe('google candidate normalization', () => {
  it('drops google/social/video/tracking candidates and deduplicates URLs', () => {
    const candidates = normalizeSearchCandidates([
      { url: 'https://www.google.com/search?q=x', title: 'Google', snippet: '' },
      { url: 'https://www.youtube.com/watch?v=1', title: 'Video', snippet: '' },
      { url: 'https://shop.test/product?utm_source=x#details', title: 'Product', snippet: 'A' },
      { url: 'https://shop.test/product', title: 'Product duplicate', snippet: 'B' },
      { url: 'https://cdn.test/photo.jpg', title: 'Image file', snippet: '' },
    ]);
    expect(candidates).toEqual([{ url: 'https://shop.test/product', title: 'Product', snippet: 'A' }]);
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
