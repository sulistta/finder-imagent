import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { ColumnMapping, ProductResult } from '../src/types.js';
import {
  buildDeterministicQueries,
  previewWorkbook,
  readWorkbookSheet,
  selectTargetProducts,
  writeResultsFillEmptyOnly,
} from '../src/workbook.js';

describe('workbook pipeline helpers', () => {
  it('previews sheets and selects rows needing images or metadata', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const buffer = await fixtureWorkbookBuffer();
    const preview = await previewWorkbook({ rootDir }, buffer, 'fixture.xlsx');
    expect(preview.sheets[0].headers).toEqual(['SKU', 'Name', 'Image 1', 'Image 2', 'Description']);

    const sheet = await readWorkbookSheet(
      path.join(rootDir, 'workbooks', preview.workbookId, 'input.xlsx'),
      'Products',
    );
    const targets = selectTargetProducts(sheet, mapping, 2);
    expect(targets.map((product) => product.sku)).toEqual(['SKU-1']);
    expect(targets[0].emptyMetadataFields).toEqual(['description']);
  });

  it('fills only empty cells when writing results', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-finder-'));
    const inputPath = path.join(rootDir, 'input.xlsx');
    const outputPath = path.join(rootDir, 'output.xlsx');
    fs.writeFileSync(inputPath, await fixtureWorkbookBuffer());

    const results: ProductResult[] = [
      {
        sku: 'SKU-1',
        status: 'completed',
        images: ['https://cdn.test/new-1.jpg', 'https://cdn.test/new-2.jpg'],
        metadata: { description: 'Generated description' },
        sourceUrl: 'https://source.test/product',
        validationReason: 'clear match',
        diagnostics: [],
      },
    ];

    await writeResultsFillEmptyOnly({
      inputPath,
      outputPath,
      sheetName: 'Products',
      mapping,
      results,
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.getWorksheet('Products')!;
    expect(sheet.getRow(2).getCell(3).value).toBe('https://cdn.test/existing.jpg');
    expect(sheet.getRow(2).getCell(4).value).toBe('https://cdn.test/new-1.jpg');
    expect(sheet.getRow(2).getCell(5).value).toBe('Generated description');
  });

  it('builds legacy-style Google queries from full name, truncated base, and model code', () => {
    expect(
      buildDeterministicQueries({
        rowNumber: 2,
        sku: 'SKU-1',
        title: 'Toner HP 85A CE285A Compatível Preto 100ml',
        existingImages: [],
        emptyMetadataFields: [],
      }),
    ).toEqual(['Toner HP 85A CE285A Compatível Preto 100ml', 'Toner HP 85A CE285A', 'HP 85A']);
    expect(
      buildDeterministicQueries({
        rowNumber: 3,
        sku: 'SKU-2',
        title: 'Cartucho Epson T544 100 ml',
        existingImages: [],
        emptyMetadataFields: [],
      }),
    ).toEqual(['Cartucho Epson T544 100 ml', 'Cartucho Epson T544', 'Epson T544']);
  });
});

const mapping: ColumnMapping = {
  sku: 'SKU',
  title: 'Name',
  imageColumns: ['Image 1', 'Image 2'],
  metadataColumns: { description: 'Description' },
};

async function fixtureWorkbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.addRow(['SKU', 'Name', 'Image 1', 'Image 2', 'Description']);
  sheet.addRow(['SKU-1', 'Printer toner', 'https://cdn.test/existing.jpg', '', '']);
  sheet.addRow(['SKU-2', 'Cable', 'https://cdn.test/1.jpg', 'https://cdn.test/2.jpg', 'Ready']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
