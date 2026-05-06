import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

import type { ApiKeyConfig, ExtractedPage, ModelConfig, ProductInput, SearchCandidate } from './types.js';

const IGNORED_RESULT_HOST_PATTERNS = [
  /(^|\.)youtube\./i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)facebook\./i,
  /(^|\.)instagram\./i,
  /(^|\.)tiktok\./i,
  /(^|\.)pinterest\./i,
  /(^|\.)twitter\./i,
  /(^|\.)x\.com$/i,
  /(^|\.)doubleclick\./i,
];

const IMAGE_EXTENSIONS = /\.(avif|gif|jpe?g|png|svg|webp)(\?|#|$)/i;
const TRACKING_QUERY_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
const MIN_VALID_IMAGE_SIZE = 80;
const IMAGE_LOAD_TIMEOUT_MS = 6_000;

interface RawImageCandidate {
  url: string;
  score: number;
  width: number;
  height: number;
  source: string;
}

interface PageImageSnapshot {
  baseUrl: string;
  candidates: RawImageCandidate[];
}

export interface SearchProvider {
  searchQuery(product: ProductInput, query: string): Promise<SearchCandidate[]>;
  extract(candidate: SearchCandidate): Promise<ExtractedPage>;
  close(): Promise<void>;
}

export class GooglePlaywrightSearchProvider implements SearchProvider {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private googlePage: Page | null = null;

  constructor(
    private readonly options: {
      apiKey: ApiKeyConfig;
      headless: boolean;
      maxCandidatesPerQuery: number;
      models: ModelConfig;
      onManualAction?: (action: { type: 'google-captcha'; active: boolean; url: string }) => void;
      pageAgentRankingTimeoutMs: number;
    },
  ) {}

  async searchQuery(product: ProductInput, query: string): Promise<SearchCandidate[]> {
    const page = await this.googleSearchPage();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=pt-BR&gl=br&num=10&pws=0`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForGoogleCaptchaIfPresent(page, this.options.onManualAction);
    await dismissGoogleConsent(page);
    await page.waitForTimeout(750);
    const candidates = normalizeSearchCandidates(await collectGoogleCandidates(page)).slice(
      0,
      this.options.maxCandidatesPerQuery,
    );
    if (candidates.length === 0) return [];
    return rankSearchCandidatesForProduct(product, candidates).slice(0, this.options.maxCandidatesPerQuery);
  }

  async extract(candidate: SearchCandidate): Promise<ExtractedPage> {
    const page = await this.newPage();
    try {
      await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      await revealLazyImages(page);
      return await extractVisiblePageData(page, candidate.url);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.googlePage?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.googlePage = null;
    this.context = null;
    this.browser = null;
  }

  private async newPage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.options.headless });
      this.context = await this.browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });
    }
    if (!this.context) throw new Error('Browser context was not created');
    return this.context.newPage();
  }

  private async googleSearchPage(): Promise<Page> {
    if (!this.googlePage || this.googlePage.isClosed()) {
      this.googlePage = await this.newPage();
      this.googlePage.setDefaultTimeout(30_000);
      this.googlePage.setDefaultNavigationTimeout(30_000);
    }
    return this.googlePage;
  }
}

export function isGoogleCaptchaChallenge({
  url,
  bodyText,
  frameUrls,
}: {
  url: string;
  bodyText: string;
  frameUrls: string[];
}): boolean {
  const normalizedText = bodyText.toLowerCase();
  return (
    /:\/\/www\.google\.[^/]+\/sorry\//i.test(url) ||
    /\/sorry\/index/i.test(url) ||
    frameUrls.some((frameUrl) => /recaptcha|google\.com\/sorry/i.test(frameUrl)) ||
    normalizedText.includes('não sou um robô') ||
    normalizedText.includes('nao sou um robo') ||
    normalizedText.includes('not a robot') ||
    normalizedText.includes('unusual traffic') ||
    normalizedText.includes('tráfego incomum') ||
    normalizedText.includes('trafego incomum') ||
    normalizedText.includes('esta página verifica se é realmente você') ||
    normalizedText.includes('this page checks to see if it') ||
    normalizedText.includes('detected unusual traffic')
  );
}

export function normalizeSearchCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  const normalized: SearchCandidate[] = [];
  for (const candidate of candidates) {
    const url = normalizeCandidateUrl(candidate.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const parsed = new URL(url);
    const title = candidate.title.trim() || candidate.snippet.trim().slice(0, 140) || parsed.hostname;
    const normalizedCandidate: SearchCandidate = {
      url,
      title,
      snippet: candidate.snippet.trim(),
    };
    const reason = candidate.reason?.trim();
    if (reason) normalizedCandidate.reason = reason;
    normalized.push(normalizedCandidate);
  }
  return normalized;
}

export function filterImageUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  return urls
    .map((url) => normalizeUrl(url))
    .filter((url): url is string => Boolean(url))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return !isIgnoredImageAsset(url);
    });
}

async function extractVisiblePageData(page: Page, fallbackUrl: string): Promise<ExtractedPage> {
  const data = await page.evaluate(() => {
    const meta = (name: string) =>
      document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() ||
      '';
    const jsonLdProducts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'))
      .map((script) => {
        try {
          return JSON.parse(script.textContent || 'null') as unknown;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const parseSrcset = (srcset: string | null) =>
      String(srcset || '')
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean);
    const collectJsonLdImages = (value: unknown, insideImageField = false): string[] => {
      if (!value) return [];
      if (typeof value === 'string') return insideImageField ? [value] : [];
      if (Array.isArray(value)) return value.flatMap((entry) => collectJsonLdImages(entry, insideImageField));
      if (typeof value !== 'object') return [];
      const record = value as Record<string, unknown>;
      const directImages = collectJsonLdImages(record.image, true);
      const nestedProductImages = Object.entries(record)
        .filter(([key]) => key !== 'image')
        .flatMap(([, entry]) => collectJsonLdImages(entry));
      return [...directImages, ...nestedProductImages];
    };
    const candidates: RawImageCandidate[] = [];
    const pushCandidate = (url: string | null | undefined, score: number, width: number, height: number, source: string) => {
      if (!url) return;
      candidates.push({ url, score, width, height, source });
    };
    const pushMeta = (name: string, score: number) => pushCandidate(meta(name), score, 0, 0, name);

    pushMeta('og:image', 8);
    pushMeta('og:image:secure_url', 8);
    pushMeta('twitter:image', 7);
    for (const image of collectJsonLdImages(jsonLdProducts)) pushCandidate(image, 7, 0, 0, 'json-ld');

    for (const image of Array.from(document.images)) {
      const source = [
        image.alt,
        image.title,
        image.className,
        image.id,
        image.closest('[class]')?.className,
        image.closest('[id]')?.id,
      ]
        .filter(Boolean)
        .join(' ');
      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;
      const score = (width >= 250 && height >= 250 ? 5 : 0) + (/gallery|product|produto|main|image/i.test(source) ? 4 : 0);
      const attrs = [
        image.currentSrc,
        image.src,
        image.getAttribute('src'),
        image.getAttribute('data-src'),
        image.getAttribute('data-original'),
        image.getAttribute('data-lazy'),
        image.getAttribute('data-zoom-image'),
        image.getAttribute('data-large'),
        image.getAttribute('data-full'),
        image.getAttribute('data-old-hires'),
        ...parseSrcset(image.getAttribute('srcset')),
      ];
      for (const sourceElement of Array.from(image.parentElement?.querySelectorAll('source[srcset]') || [])) {
        attrs.push(...parseSrcset(sourceElement.getAttribute('srcset')));
      }
      for (const rawUrl of attrs) pushCandidate(rawUrl, score, width, height, source);

      try {
        const dynamicImages = JSON.parse(image.getAttribute('data-a-dynamic-image') || '{}') as Record<string, [number, number]>;
        for (const [rawUrl, size] of Object.entries(dynamicImages)) {
          pushCandidate(rawUrl, score + 3, Number(size?.[0]) || 0, Number(size?.[1]) || 0, 'data-a-dynamic-image');
        }
      } catch {
        // Ignore malformed dynamic image payloads.
      }
    }

    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[style*="background"]'))) {
      const style = element.style.backgroundImage || getComputedStyle(element).backgroundImage;
      const urls = Array.from(style.matchAll(/url\(["']?([^"')]+)["']?\)/gi)).map((match) => match[1]);
      const rect = element.getBoundingClientRect();
      for (const rawUrl of urls) pushCandidate(rawUrl, 2, Math.round(rect.width), Math.round(rect.height), 'background-image');
    }

    return {
      title: document.title || '',
      h1: document.querySelector('h1')?.textContent?.trim() || '',
      metaDescription: meta('description') || meta('og:description'),
      jsonLdProducts,
      text: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 5_000) || '',
      imageSnapshot: { baseUrl: location.href, candidates } satisfies PageImageSnapshot,
    };
  });
  const imageCandidates = extractImageUrlsFromPageSnapshot(data.imageSnapshot, page.url() || fallbackUrl);
  const images = await validateImageUrlsInPage(page, imageCandidates);

  return {
    url: page.url() || fallbackUrl,
    title: data.title,
    h1: data.h1,
    metaDescription: data.metaDescription,
    jsonLdProducts: data.jsonLdProducts,
    text: data.text,
    images,
  };
}

export function extractImageUrlsFromPageSnapshot(snapshot: PageImageSnapshot, fallbackUrl: string): string[] {
  const bestByUrl = new Map<string, RawImageCandidate>();
  for (const candidate of snapshot.candidates) {
    const url = normalizeUrl(candidate.url, snapshot.baseUrl || fallbackUrl);
    if (!url || isIgnoredImageAsset(`${url} ${candidate.source}`)) continue;
    const hasExtension = IMAGE_EXTENSIONS.test(new URL(url).pathname);
    const hasUsefulSize = candidate.width >= MIN_VALID_IMAGE_SIZE && candidate.height >= MIN_VALID_IMAGE_SIZE;
    if (!hasExtension && !hasUsefulSize && candidate.score < 7) continue;
    const previous = bestByUrl.get(url);
    if (
      !previous ||
      candidate.score > previous.score ||
      (candidate.score === previous.score && candidate.width * candidate.height > previous.width * previous.height)
    ) {
      bestByUrl.set(url, { ...candidate, url });
    }
  }
  return [...bestByUrl.values()]
    .sort((left, right) => right.score - left.score || right.width * right.height - left.width * left.height)
    .map((candidate) => candidate.url);
}

export function rankSearchCandidatesForProduct(product: ProductInput, candidates: SearchCandidate[]): SearchCandidate[] {
  const productTokens = weightedTokens([product.sku, product.title, product.category || ''].join(' '));
  const ranked = candidates.map((candidate, index) => {
    const haystack = normalizeTokenText([candidate.title, candidate.snippet, candidate.url].join(' '));
    let score = 0;
    for (const [token, weight] of productTokens) {
      if (haystack.includes(token)) score += weight;
    }
    if (/produto|product|prod|dp|item/i.test(candidate.url)) score += 1;
    return { candidate, score, index };
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked.some((entry) => entry.score > 0)
    ? ranked.map((entry) => entry.candidate)
    : candidates.slice(0, Math.min(candidates.length, 3));
}

async function waitForGoogleCaptchaIfPresent(
  page: Page,
  onManualAction: GooglePlaywrightSearchProvider['options']['onManualAction'],
): Promise<void> {
  let announced = false;

  while (await pageHasGoogleCaptcha(page)) {
    if (!announced) {
      announced = true;
      onManualAction?.({ type: 'google-captcha', active: true, url: page.url() });
      console.warn(
        `[Image Finder] Google CAPTCHA detected. Resolve it manually in the opened browser tab: ${page.url()}`,
      );
    }
    await page.waitForTimeout(2_000);
  }

  if (announced) {
    onManualAction?.({ type: 'google-captcha', active: false, url: page.url() });
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  }
}

async function pageHasGoogleCaptcha(page: Page): Promise<boolean> {
  const snapshot = await page
    .evaluate(() => ({
      bodyText: document.body?.innerText || '',
    }))
    .catch(() => ({ bodyText: '' }));
  return isGoogleCaptchaChallenge({
    url: page.url(),
    bodyText: snapshot.bodyText,
    frameUrls: page.frames().map((frame) => frame.url()),
  });
}

function normalizeCandidateUrl(rawUrl: string): string | null {
  const url = normalizeUrl(unwrapGoogleRedirectUrl(rawUrl));
  if (!url) return null;
  const parsed = new URL(url);
  if (isIgnoredResultHost(parsed.hostname)) return null;
  if (isIgnoredGoogleUrl(parsed)) return null;
  if (IMAGE_EXTENSIONS.test(parsed.pathname)) return null;
  return parsed.toString();
}

async function collectGoogleCandidates(page: Page): Promise<SearchCandidate[]> {
  return page.evaluate(() => {
    const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    return anchors
      .map((anchor) => {
        const title = clean(
          anchor.querySelector('h3')?.textContent ||
            anchor.getAttribute('aria-label') ||
            anchor.getAttribute('title') ||
            anchor.textContent ||
            '',
        );
        const container =
          anchor.closest('div[data-sokoban-container], div.g, article, li') ||
          anchor.closest('div')?.parentElement ||
          anchor.parentElement;
        const snippet = clean(container?.textContent || '');
        return { url: anchor.href, title, snippet };
      })
      .filter((candidate) => candidate.url && (candidate.title || candidate.snippet) && !candidate.url.startsWith('javascript:'));
  });
}

async function dismissGoogleConsent(page: Page): Promise<void> {
  const patterns = [/aceitar tudo/i, /concordo/i, /i agree/i, /accept all/i];
  for (const pattern of patterns) {
    const button = page.getByRole('button', { name: pattern }).first();
    if ((await button.count().catch(() => 0)) === 0) continue;
    await button.click({ timeout: 1_000 }).catch(() => undefined);
    await page.waitForTimeout(250);
    return;
  }
}

function unwrapGoogleRedirectUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (!/(^|\.)google\./i.test(parsed.hostname)) return rawUrl;
    return parsed.searchParams.get('q') || parsed.searchParams.get('url') || parsed.searchParams.get('adurl') || rawUrl;
  } catch {
    return rawUrl;
  }
}

function normalizeUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    const parsed = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    for (const param of TRACKING_QUERY_PARAMS) {
      parsed.searchParams.delete(param);
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

async function revealLazyImages(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  await page
    .evaluate(async () => {
      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const positions = [0.35, 0.7, 1, 0];
      for (const position of positions) {
        window.scrollTo(0, Math.round(document.body.scrollHeight * position));
        await sleep(300);
      }
    })
    .catch(() => undefined);
  await page.waitForTimeout(500);
}

async function validateImageUrlsInPage(page: Page, urls: string[]): Promise<string[]> {
  const candidates = filterImageUrls(urls).slice(0, 24);
  if (candidates.length === 0) return [];
  const loaded = await page.evaluate(
    async ({ imageUrls, timeoutMs, minSize }) => {
      const loadImage = (url: string) =>
        new Promise<{ url: string; ok: boolean; width: number; height: number }>((resolve) => {
          const image = new Image();
          let settled = false;
          const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve({ url, ok, width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
          };
          const timer = window.setTimeout(() => done(false), timeoutMs);
          image.onload = () => done(image.naturalWidth >= minSize && image.naturalHeight >= minSize);
          image.onerror = () => done(false);
          image.referrerPolicy = 'no-referrer';
          image.src = url;
        });
      return Promise.all(imageUrls.map(loadImage));
    },
    { imageUrls: candidates, timeoutMs: IMAGE_LOAD_TIMEOUT_MS, minSize: MIN_VALID_IMAGE_SIZE },
  );
  return loaded
    .filter((image) => image.ok)
    .sort((left, right) => right.width * right.height - left.width * left.height)
    .map((image) => image.url);
}

function isIgnoredResultHost(hostname: string): boolean {
  return IGNORED_RESULT_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isIgnoredGoogleUrl(url: URL): boolean {
  if (!/(^|\.)google\./i.test(url.hostname)) return false;
  if (/^\/shopping\/product/i.test(url.pathname)) return false;
  return true;
}

function isIgnoredImageAsset(value: string): boolean {
  return /pixel|tracking|analytics|sprite|logo|icon|placeholder|loading|blank|spacer|favicon|avatar|doubleclick|tagmanager/i.test(
    value,
  );
}

function weightedTokens(value: string): Map<string, number> {
  const tokens = new Map<string, number>();
  for (const token of normalizeTokenText(value).split(/\s+/)) {
    if (token.length < 2 || isWeakToken(token)) continue;
    const weight = /\d/.test(token) ? 4 : 1;
    tokens.set(token, Math.max(tokens.get(token) || 0, weight));
  }
  return tokens;
}

function normalizeTokenText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isWeakToken(token: string): boolean {
  return new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'por', 'the', 'and', 'produto', 'product']).has(token);
}
