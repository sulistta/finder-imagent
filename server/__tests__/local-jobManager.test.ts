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
});

class MockSearchProvider implements SearchProvider {
  async search(_product: ProductInput, _queries: string[]): Promise<SearchCandidate[]> {
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

  async rankCandidates(_product: ProductInput, candidates: SearchCandidate[]): Promise<SearchCandidate[]> {
    return candidates;
  }

  async validateProduct(): Promise<{ approved: boolean; reason: string }> {
    return { approved: true, reason: 'clear match' };
  }

  async generateMetadata(): Promise<{ description: string }> {
    return { description: 'Generated metadata' };
  }
}

function createManager(
  options: Partial<ConstructorParameters<typeof ImageFinderJobManager>[0]> &
    Pick<ConstructorParameters<typeof ImageFinderJobManager>[0], 'store' | 'apiKeys'>,
): ImageFinderJobManager {
  return new ImageFinderJobManager({
    models: {
      query: 'query-model',
      ranking: 'ranking-model',
      visual: 'visual-model',
      metadata: 'metadata-model',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    googleHeadless: true,
    google: {
      delayMinMs: 0,
      delayMaxMs: 0,
      maxQueries: 6,
      maxCandidatesPerQuery: 5,
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
