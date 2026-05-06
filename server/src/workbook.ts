import * as crypto from 'crypto';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';

import type {
  ColumnMapping,
  MetadataColumnKey,
  ProductInput,
  ProductResult,
  WorkbookPreview,
} from './types.js';

export const METADATA_COLUMN_KEYS: MetadataColumnKey[] = [
  'description',
  'category',
  'seoTitle',
  'seoDescription',
  'seoKeywords',
];

export interface WorkbookStore {
  rootDir: string;
}

export async function previewWorkbook(
  store: WorkbookStore,
  fileBuffer: Buffer,
  originalName: string,
): Promise<WorkbookPreview> {
  const workbookId = crypto.randomUUID();
  const workbookDir = path.join(store.rootDir, 'workbooks', workbookId);
  fs.mkdirSync(workbookDir, { recursive: true });
  fs.writeFileSync(path.join(workbookDir, 'input.xlsx'), fileBuffer);
  fs.writeFileSync(path.join(workbookDir, 'source-name.txt'), originalName);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  return {
    workbookId,
    sheets: workbook.worksheets.map((sheet) => {
      const headers = readHeaders(sheet);
      return {
        name: sheet.name,
        headers,
        samples: readSamples(sheet, headers),
      };
    }),
  };
}

export function getWorkbookInputPath(store: WorkbookStore, workbookId: string): string {
  assertSafeId(workbookId);
  return path.join(store.rootDir, 'workbooks', workbookId, 'input.xlsx');
}

export async function readWorkbookSheet(filePath: string, sheetName: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }
  return sheet;
}

export function selectTargetProducts(
  sheet: ExcelJS.Worksheet,
  mapping: ColumnMapping,
  targetImageCount: number,
  maxProducts = 0,
): ProductInput[] {
  const headerMap = buildHeaderMap(sheet);
  const skuColumn = requireColumn(headerMap, mapping.sku);
  const titleColumn = requireColumn(headerMap, mapping.title);
  const imageColumns = mapping.imageColumns.map((header) => requireColumn(headerMap, header));
  const metadataColumns = resolveMetadataColumns(headerMap, mapping.metadataColumns);
  const categoryColumn = metadataColumns.category;
  const products: ProductInput[] = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const sku = cellText(row.getCell(skuColumn));
    const title = cellText(row.getCell(titleColumn));
    if (!sku && !title) return;

    const existingImages = imageColumns
      .map((column) => cellText(row.getCell(column)))
      .filter(Boolean);
    const emptyMetadataFields = METADATA_COLUMN_KEYS.filter((key) => {
      const column = metadataColumns[key];
      return column !== undefined && isEmptyCell(row.getCell(column).value);
    });

    if (existingImages.length < targetImageCount || emptyMetadataFields.length > 0) {
      products.push({
        rowNumber,
        sku,
        title,
        existingImages,
        emptyMetadataFields,
        category: categoryColumn ? cellText(row.getCell(categoryColumn)) : undefined,
      });
    }
  });

  return maxProducts > 0 ? products.slice(0, maxProducts) : products;
}

export async function writeResultsFillEmptyOnly({
  inputPath,
  outputPath,
  sheetName,
  mapping,
  results,
}: {
  inputPath: string;
  outputPath: string;
  sheetName: string;
  mapping: ColumnMapping;
  results: ProductResult[];
}): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);

  const headerMap = buildHeaderMap(sheet);
  const skuColumn = requireColumn(headerMap, mapping.sku);
  const imageColumns = mapping.imageColumns.map((header) => requireColumn(headerMap, header));
  const metadataColumns = resolveMetadataColumns(headerMap, mapping.metadataColumns);
  const bySku = new Map(results.map((result) => [result.sku, result]));

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const sku = cellText(row.getCell(skuColumn));
    const result = bySku.get(sku);
    if (!result || result.status !== 'completed') return;

    const existingImages = new Set(imageColumns.map((column) => cellText(row.getCell(column))).filter(Boolean));
    const newImages = result.images.filter((url) => url && !existingImages.has(url));
    let nextImageIndex = 0;
    for (const column of imageColumns) {
      if (nextImageIndex >= newImages.length) break;
      const cell = row.getCell(column);
      if (isEmptyCell(cell.value)) {
        cell.value = newImages[nextImageIndex];
        nextImageIndex += 1;
      }
    }

    for (const key of METADATA_COLUMN_KEYS) {
      const column = metadataColumns[key];
      const value = result.metadata[key];
      if (column !== undefined && value && isEmptyCell(row.getCell(column).value)) {
        row.getCell(column).value = value;
      }
    }
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
}

export function buildDeterministicQueries(product: ProductInput): string[] {
  const cleanName = cleanSearchText(product.title);
  const words = cleanName.split(/\s+/).filter(Boolean);
  const baseQuery = buildBaseSearchQuery(words);
  const codeQuery = buildCodeSearchQuery(words);
  const fullNameQuery = shouldUseFullNameQuery(words) ? cleanName : '';
  return unique([baseQuery, codeQuery, fullNameQuery].filter(Boolean));
}

function shouldUseFullNameQuery(words: string[]): boolean {
  return !words.some((word, index) => {
    const normalized = normalizeSearchText(word);
    const nextNormalized = normalizeSearchText(words[index + 1] || '');
    return isSearchStopTerm(normalized) || isMlVolumeToken(normalized, nextNormalized);
  });
}

function buildBaseSearchQuery(words: string[]): string {
  const baseWords: string[] = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const normalized = normalizeSearchText(word);
    const nextNormalized = normalizeSearchText(words[index + 1] || '');
    if (baseWords.length >= 2 && (isSearchStopTerm(normalized) || isMlVolumeToken(normalized, nextNormalized))) {
      break;
    }
    if (normalized === 'ml') break;
    baseWords.push(word);
  }

  return baseWords.join(' ');
}

function isSearchStopTerm(normalized: string): boolean {
  return new Set([
    'reciclado',
    'reciclada',
    'compativel',
    'compatível',
    'original',
    'preto',
    'preta',
    'color',
    'colorido',
    'colorida',
    'azul',
    'magenta',
    'amarelo',
    'amarela',
    'ciano',
    'pequeno',
    'pequena',
  ]).has(normalized);
}

function isMlVolumeToken(normalized: string, nextNormalized: string): boolean {
  return /^\d+(?:,\d+)?ml$/i.test(normalized) || (/^\d+(?:,\d+)?$/i.test(normalized) && nextNormalized === 'ml');
}

function buildCodeSearchQuery(words: string[]): string {
  const modelIndex = words.findIndex((word) => /\d/.test(word));
  if (modelIndex === -1) return '';
  const start = Math.max(0, modelIndex - 1);
  return words.slice(start, modelIndex + 1).join(' ');
}

function cleanSearchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function normalizeCheckpoint(raw: unknown): ProductResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.filter(isProductResult);
}

function isProductResult(value: unknown): value is ProductResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as ProductResult;
  return typeof result.sku === 'string' && Array.isArray(result.images) && Array.isArray(result.diagnostics);
}

function readHeaders(sheet: ExcelJS.Worksheet): string[] {
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell((cell) => {
    headers.push(cellText(cell));
  });
  return headers;
}

function readSamples(sheet: ExcelJS.Worksheet, headers: string[]): Record<string, string>[] {
  const samples: Record<string, string>[] = [];
  for (let rowNumber = 2; rowNumber <= Math.min(sheet.rowCount, 6); rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const sample: Record<string, string> = {};
    headers.forEach((header, index) => {
      sample[header] = cellText(row.getCell(index + 1));
    });
    samples.push(sample);
  }
  return samples;
}

function buildHeaderMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, columnNumber) => {
    const header = cellText(cell);
    if (header) map.set(header, columnNumber);
  });
  return map;
}

function resolveMetadataColumns(
  headerMap: Map<string, number>,
  columns: ColumnMapping['metadataColumns'],
): Partial<Record<MetadataColumnKey, number>> {
  const resolved: Partial<Record<MetadataColumnKey, number>> = {};
  for (const key of METADATA_COLUMN_KEYS) {
    const header = columns?.[key];
    if (header) resolved[key] = requireColumn(headerMap, header);
  }
  return resolved;
}

function requireColumn(headerMap: Map<string, number>, header: string): number {
  const column = headerMap.get(header);
  if (!column) throw new Error(`Column not found: ${header}`);
  return column;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => String(part.text ?? '')).join('').trim();
    }
    if ('result' in value) return String(value.result ?? '').trim();
    if ('hyperlink' in value && typeof value.hyperlink === 'string') return value.hyperlink.trim();
  }
  return String(value).trim();
}

function isEmptyCell(value: ExcelJS.CellValue): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function assertSafeId(id: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error('Invalid workbook id');
  }
}
