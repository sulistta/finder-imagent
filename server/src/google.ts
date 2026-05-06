import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';

import {
  type PageAgentSelectionOptions,
  resolvePageAgentBundlePath,
  selectCandidatesWithPageAgent,
} from './pageAgentSelection.js';
import type { ApiKeyConfig, ExtractedPage, ModelConfig, ProductInput, SearchCandidate } from './types.js';

const BLOCKED_HOST_PATTERNS = [
  /(^|\.)google\./i,
  /(^|\.)gstatic\./i,
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

export interface SearchProvider {
  search(product: ProductInput, queries: string[]): Promise<SearchCandidate[]>;
  extract(candidate: SearchCandidate): Promise<ExtractedPage>;
  close(): Promise<void>;
}

export class GooglePlaywrightSearchProvider implements SearchProvider {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private googlePage: Page | null = null;
  private readonly pageAgentBundlePath: string;

  constructor(
    private readonly options: {
      headless: boolean;
      maxCandidatesPerQuery: number;
      apiKey: ApiKeyConfig;
      models: ModelConfig;
      onManualAction?: (action: { type: 'google-captcha'; active: boolean; url: string }) => void;
      onCandidateSelectionStart?: () => void;
      pageAgentSelector?: (options: PageAgentSelectionOptions) => Promise<SearchCandidate[]>;
    },
  ) {
    this.pageAgentBundlePath = resolvePageAgentBundlePath();
  }

  async search(product: ProductInput, queries: string[]): Promise<SearchCandidate[]> {
    const page = await this.googleSearchPage();
    const candidates: SearchCandidate[] = [];
    for (const query of queries) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=pt-BR&gl=br&num=10&pws=0`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForGoogleCaptchaIfPresent(page, this.options.onManualAction);
      await dismissGoogleConsent(page);
      await page.waitForTimeout(750);
      const pageCandidates = normalizeSearchCandidates(await collectGoogleCandidates(page)).slice(
        0,
        this.options.maxCandidatesPerQuery,
      );
      if (pageCandidates.length === 0) continue;

      try {
        const selector = this.options.pageAgentSelector ?? selectCandidatesWithPageAgent;
        this.options.onCandidateSelectionStart?.();
        const selected = await selector({
          page,
          product,
          query,
          candidates: pageCandidates,
          apiKey: this.options.apiKey,
          models: this.options.models,
          bundlePath: this.pageAgentBundlePath,
        });
        candidates.push(...selected);
      } catch (error) {
        console.warn(
          `[Image Finder] PageAgent candidate selection failed for SKU ${product.sku || product.title}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return normalizeSearchCandidates(candidates);
  }

  async extract(candidate: SearchCandidate): Promise<ExtractedPage> {
    const page = await this.newPage();
    try {
      await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1_000);
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
    const normalizedCandidate: SearchCandidate = {
      url,
      title: candidate.title.trim(),
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
      if (isBlockedHost(parsed.hostname)) return false;
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      return !/pixel|tracking|analytics|sprite|logo|icon/i.test(url);
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
    const images = Array.from(document.images)
      .filter((image) => image.naturalWidth >= 250 && image.naturalHeight >= 250)
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean);
    const ogImage = meta('og:image');
    if (ogImage) images.unshift(ogImage);

    return {
      title: document.title || '',
      h1: document.querySelector('h1')?.textContent?.trim() || '',
      metaDescription: meta('description') || meta('og:description'),
      jsonLdProducts,
      text: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 5_000) || '',
      images,
    };
  });

  return {
    url: page.url() || fallbackUrl,
    ...data,
    images: filterImageUrls(data.images),
  };
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
  if (isBlockedHost(parsed.hostname)) return null;
  if (IMAGE_EXTENSIONS.test(parsed.pathname)) return null;
  return parsed.toString();
}

async function collectGoogleCandidates(page: Page): Promise<SearchCandidate[]> {
  return page.evaluate(() => {
    const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    return anchors
      .map((anchor) => {
        const title = clean(anchor.querySelector('h3')?.textContent || anchor.textContent || '');
        const container =
          anchor.closest('div[data-sokoban-container], div.g, article, li') ||
          anchor.closest('div')?.parentElement ||
          anchor.parentElement;
        const snippet = clean(container?.textContent || '');
        return { url: anchor.href, title, snippet };
      })
      .filter((candidate) => candidate.title && candidate.url && !candidate.url.startsWith('javascript:'));
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
    return parsed.searchParams.get('q') || parsed.searchParams.get('url') || rawUrl;
  } catch {
    return rawUrl;
  }
}

function normalizeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) {
      parsed.searchParams.delete(param);
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}
