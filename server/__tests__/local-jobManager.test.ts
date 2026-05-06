import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { AiProvider } from '../src/gemini.js';
import type { SearchProvider } from '../src/google.js';
import { ImageFinderJobManager } from '../src/jobManager.js';
import type { ExtractedPage, ProductInput, SearchCandidate } from '../src/types.js';
import { previewWorkbook } from '../src/workbook.js';

describe('ImageFinderJobManager', () => {
  it('runs model agents with mocked Google and Gemini and produces a downloadable workbook', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer(), 'fixture.xlsx');
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret' }],
    });

    const { status } = await manager.startJob({
      workbookId: preview.workbookId,
      sheetName: 'Products',
      columnMapping: {
        sku: 'SKU',
        title: 'Name',
        imageColumns: ['Image 1', 'Image 2'],
        metadataColumns: { description: 'Description' },
      },
      targetImageCount: 2,
      writePolicy: 'fill-empty-only',
    });

    await waitForCompletion(manager, status.id);
    const record = manager.getJob(status.id)!;
    expect(record.agents.map((agent) => agent.role)).toEqual(['query', 'ranking', 'visual', 'metadata']);
    expect(record.agents.every((agent) => agent.apiKeyId === 'key-1')).toBe(true);
    const outputPath = manager.getDownloadPath(status.id);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.getWorksheet('Products')!;
    expect(sheet.getRow(2).getCell(4).value).toBe('https://cdn.test/image-2.jpg');
    expect(sheet.getRow(2).getCell(5).value).toBe('Generated metadata');
  });

  it('creates four model agents per API key and processes one group per key', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer({ secondNeedsWork: true }), 'fixture.xlsx');
    let providersCreated = 0;
    const manager = createManager({
      store: { rootDir },
      apiKeys: [
        { id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' },
        { id: 'key-2', label: 'Google 2 (key:****)', key: 'secret-2' },
      ],
      searchProviderFactory: () => {
        providersCreated += 1;
        return new MockSearchProvider();
      },
    });

    const { status, agents } = await manager.startJob(jobConfig(preview.workbookId));

    expect(agents).toHaveLength(8);
    expect(agents.filter((agent) => agent.apiKeyId === 'key-1').map((agent) => agent.role)).toEqual([
      'query',
      'ranking',
      'visual',
      'metadata',
    ]);
    expect(agents.filter((agent) => agent.apiKeyId === 'key-2')).toHaveLength(4);
    await waitForCompletion(manager, status.id);
    expect(providersCreated).toBe(2);
  });

  it('waits between products within each API-key group', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer({ secondNeedsWork: true }), 'fixture.xlsx');
    const delays: number[] = [];
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' }],
      google: {
        delayMinMs: 2_000,
        delayMaxMs: 5_000,
        maxQueries: 6,
        maxCandidatesPerQuery: 5,
        pageAgentRankingTimeoutMs: 90_000,
      },
      randomDelayMs: () => 2_345,
      delayBetweenProducts: async (ms) => {
        delays.push(ms);
      },
    });

    const { status } = await manager.startJob(jobConfig(preview.workbookId));

    await waitForCompletion(manager, status.id);
    expect(delays).toEqual([2_345]);
  });

  it('keeps query and ranking diagnostics when a later visual stage fails', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer(), 'fixture.xlsx');
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' }],
      aiFactory: () => new VisualRejectingAiProvider(),
    });

    const { status } = await manager.startJob(jobConfig(preview.workbookId));

    await waitForCompletion(manager, status.id);
    const record = manager.getJob(status.id)!;
    expect(record.results[0]).toMatchObject({
      sku: 'SKU-1',
      status: 'failed',
      diagnostics: expect.arrayContaining([
        'queries=1',
        'queryMode=deterministic',
        'rankedCandidates=1',
        'selectedCandidates=1',
        expect.stringContaining('No candidate clearly matched the product.'),
      ]),
    });
  });

  it('runs agents in strict query, ranking, visual, metadata order', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer(), 'fixture.xlsx');
    const events: string[] = [];
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' }],
      aiFactory: () => new RecordingAiProvider(events),
      searchProviderFactory: () => new RecordingSearchProvider(events),
    });

    const { status } = await manager.startJob(jobConfig(preview.workbookId));

    await waitForCompletion(manager, status.id);
    expect(events).toEqual(['ranking:search', 'visual', 'metadata']);
  });

  it('uses deterministic queries without calling the query model', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer(), 'fixture.xlsx');
    const events: string[] = [];
    const searchedQueries: string[] = [];
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' }],
      aiFactory: () => new RecordingAiProvider(events),
      searchProviderFactory: () => new RecordingQuerySearchProvider(searchedQueries),
    });

    const { status } = await manager.startJob(jobConfig(preview.workbookId));

    await waitForCompletion(manager, status.id);
    const record = manager.getJob(status.id)!;
    expect(events).not.toContain('query');
    expect(searchedQueries).toEqual(['Printer toner']);
    expect(record.results[0]).toMatchObject({
      sku: 'SKU-1',
      status: 'completed',
      diagnostics: expect.arrayContaining(['queryMode=deterministic', 'deterministicQueries=1']),
    });
  });

  it('continues to the next candidate when extraction fails for an earlier candidate', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer(), 'fixture.xlsx');
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' }],
      searchProviderFactory: () => new FirstCandidateFailsSearchProvider(),
    });

    const { status } = await manager.startJob(jobConfig(preview.workbookId));

    await waitForCompletion(manager, status.id);
    const record = manager.getJob(status.id)!;
    expect(record.results[0]).toMatchObject({
      sku: 'SKU-1',
      status: 'completed',
      sourceUrl: 'https://shop.test/product-ok',
      diagnostics: expect.arrayContaining([expect.stringContaining('candidateRejected=https://shop.test/product-bad')]),
    });
  });

  it('skips Gemini visual validation for candidates without local product evidence', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer(), 'fixture.xlsx');
    const ai = new CountingAiProvider();
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' }],
      aiFactory: () => ai,
      searchProviderFactory: () => new WeakEvidenceSearchProvider(),
    });

    const { status } = await manager.startJob(jobConfig(preview.workbookId));

    await waitForCompletion(manager, status.id);
    const record = manager.getJob(status.id)!;
    expect(ai.visualCalls).toBe(0);
    expect(record.results[0]).toMatchObject({
      sku: 'SKU-1',
      status: 'failed',
      diagnostics: expect.arrayContaining([expect.stringContaining('evidencia_local_baixa')]),
    });
  });

  it('fails in ranking stage when the search provider cannot return candidates', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const preview = await previewWorkbook({ rootDir }, await fixtureWorkbookBuffer(), 'fixture.xlsx');
    const events: string[] = [];
    const manager = createManager({
      store: { rootDir },
      apiKeys: [{ id: 'key-1', label: 'Google 1 (key:****)', key: 'secret-1' }],
      aiFactory: () => new RecordingAiProvider(events),
      searchProviderFactory: () => ({
        async searchQuery(): Promise<SearchCandidate[]> {
          events.push('ranking:search');
          throw new Error('Google search provider failed');
        },
        async extract(candidate: SearchCandidate): Promise<ExtractedPage> {
          return new MockSearchProvider().extract(candidate);
        },
        async close(): Promise<void> {},
      }),
    });

    const { status } = await manager.startJob(jobConfig(preview.workbookId));

    await waitForCompletion(manager, status.id);
    const record = manager.getJob(status.id)!;
    expect(events).toEqual(['ranking:search']);
    expect(record.results[0]).toMatchObject({
      sku: 'SKU-1',
      status: 'failed',
      validationReason: 'Google search provider failed',
    });
    expect(record.agents.find((agent) => agent.role === 'ranking')).toMatchObject({
      state: 'error',
      lastError: 'Google search provider failed',
    });
  });
});

class MockSearchProvider implements SearchProvider {
  async searchQuery(_product: ProductInput, _query: string): Promise<SearchCandidate[]> {
    return [{ url: 'https://shop.test/product', title: 'Product', snippet: 'Snippet' }];
  }

  async extract(candidate: SearchCandidate): Promise<ExtractedPage> {
    return {
      url: candidate.url,
      title: candidate.title,
      h1: 'Printer toner',
      metaDescription: 'A matching product',
      jsonLdProducts: [],
      text: 'SKU-1 Printer toner',
      images: ['https://cdn.test/image-2.jpg'],
    };
  }

  async close(): Promise<void> {}
}

class MockAiProvider implements AiProvider {
  async generateQueries(_product: ProductInput, deterministicQueries: string[]): Promise<string[]> {
    return deterministicQueries;
  }

  async validateProduct(): Promise<{ approved: boolean; reason: string }> {
    return { approved: true, reason: 'clear match' };
  }

  async generateMetadata(): Promise<{ description: string }> {
    return { description: 'Generated metadata' };
  }
}

class VisualRejectingAiProvider extends MockAiProvider {
  async validateProduct(): Promise<{ approved: boolean; reason: string }> {
    return { approved: false, reason: 'not enough evidence' };
  }
}

class RecordingSearchProvider extends MockSearchProvider {
  constructor(private readonly events: string[]) {
    super();
  }

  async searchQuery(product: ProductInput, query: string): Promise<SearchCandidate[]> {
    this.events.push('ranking:search');
    return super.searchQuery(product, query);
  }
}

class RecordingQuerySearchProvider extends MockSearchProvider {
  constructor(private readonly queries: string[]) {
    super();
  }

  async searchQuery(product: ProductInput, query: string): Promise<SearchCandidate[]> {
    this.queries.push(query);
    return super.searchQuery(product, query);
  }
}

class RecordingAiProvider extends MockAiProvider {
  constructor(private readonly events: string[]) {
    super();
  }

  async generateQueries(product: ProductInput, deterministicQueries: string[]): Promise<string[]> {
    this.events.push('query');
    return super.generateQueries(product, deterministicQueries);
  }

  async validateProduct(): Promise<{ approved: boolean; reason: string }> {
    this.events.push('visual');
    return super.validateProduct();
  }

  async generateMetadata(): Promise<{ description: string }> {
    this.events.push('metadata');
    return super.generateMetadata();
  }
}

class FirstCandidateFailsSearchProvider implements SearchProvider {
  async searchQuery(): Promise<SearchCandidate[]> {
    return [
      { url: 'https://shop.test/product-bad', title: 'Broken page', snippet: 'Broken page' },
      { url: 'https://shop.test/product-ok', title: 'Printer toner', snippet: 'SKU-1 Printer toner' },
    ];
  }

  async extract(candidate: SearchCandidate): Promise<ExtractedPage> {
    if (candidate.url.includes('product-bad')) {
      throw new Error('candidate extraction failed');
    }
    return {
      url: candidate.url,
      title: 'Printer toner',
      h1: 'Printer toner',
      metaDescription: 'A matching product',
      jsonLdProducts: [],
      text: 'SKU-1 Printer toner',
      images: ['https://cdn.test/image-2.jpg'],
    };
  }

  async close(): Promise<void> {}
}

class WeakEvidenceSearchProvider implements SearchProvider {
  async searchQuery(): Promise<SearchCandidate[]> {
    return [{ url: 'https://shop.test/unrelated', title: 'Papel A4', snippet: 'Papel A4 branco' }];
  }

  async extract(candidate: SearchCandidate): Promise<ExtractedPage> {
    return {
      url: candidate.url,
      title: 'Papel A4 branco',
      h1: 'Papel A4',
      metaDescription: 'Produto completamente diferente',
      jsonLdProducts: [],
      text: 'Papel A4 branco 75g',
      images: ['https://cdn.test/image.jpg'],
    };
  }

  async close(): Promise<void> {}
}

class CountingAiProvider extends MockAiProvider {
  visualCalls = 0;

  async validateProduct(): Promise<{ approved: boolean; reason: string }> {
    this.visualCalls += 1;
    return super.validateProduct();
  }
}

function createManager(
  options: Partial<ConstructorParameters<typeof ImageFinderJobManager>[0]> &
    Pick<ConstructorParameters<typeof ImageFinderJobManager>[0], 'store' | 'apiKeys'>,
): ImageFinderJobManager {
  return new ImageFinderJobManager({
    models: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      query: 'query-model',
      ranking: 'ranking-model',
      visual: 'visual-model',
      metadata: 'metadata-model',
    },
    googleHeadless: true,
    google: {
      delayMinMs: 0,
      delayMaxMs: 0,
      maxQueries: 6,
      maxCandidatesPerQuery: 5,
      pageAgentRankingTimeoutMs: 90_000,
    },
    aiFactory: () => new MockAiProvider(),
    searchProviderFactory: () => new MockSearchProvider(),
    ...options,
  });
}

function jobConfig(workbookId: string) {
  return {
    workbookId,
    sheetName: 'Products',
    columnMapping: {
      sku: 'SKU',
      title: 'Name',
      imageColumns: ['Image 1', 'Image 2'],
      metadataColumns: { description: 'Description' },
    },
    targetImageCount: 2,
    writePolicy: 'fill-empty-only' as const,
  };
}

async function waitForCompletion(manager: ImageFinderJobManager, jobId: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const record = manager.getJob(jobId);
    if (record?.status.downloadable) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for job completion');
}

async function fixtureWorkbookBuffer(options: { secondNeedsWork?: boolean } = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.addRow(['SKU', 'Name', 'Image 1', 'Image 2', 'Description']);
  sheet.addRow(['SKU-1', 'Printer toner', 'https://cdn.test/existing.jpg', '', '']);
  if (options.secondNeedsWork) {
    sheet.addRow(['SKU-2', 'Printer drum', 'https://cdn.test/existing-2.jpg', '', '']);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
