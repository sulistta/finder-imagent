import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import XLSX from "xlsx";
import ExcelJS from "exceljs";

const require = createRequire(import.meta.url);

const DEFAULT_INPUT_FILE = "PLANILHA_OLIST_899_FINAL_ESTRUTURA_CORRETA.xlsx";
const CHECKPOINT_FILE = "checkpoint.json";
const OUTPUT_FILE = "resultado.xlsx";
const DEFAULT_STORE_HARD_TIMEOUT_MS = 300_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_SETTLE_MS = 1_000;
const DEFAULT_PAGE_AGENT_CLICK_TIMEOUT_MS = 25_000;
const DEFAULT_GEMINI_MATCH_TIMEOUT_MS = 25_000;
const DEFAULT_GEMINI_RETRY_ATTEMPTS = 3;
const DEFAULT_GEMINI_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_GEMINI_RETRY_MAX_DELAY_MS = 8_000;
const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5_000;
const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_GEMINI_MODEL = "gemma-4-31b-it";
const DEFAULT_GEMINI_MATCH_MODEL = "gemini-3.1-flash-lite-preview";
const GEMINI_MATCH_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    aprovado: { type: "boolean" },
    motivo: { type: "string" },
  },
  required: ["aprovado", "motivo"],
};
const GEMINI_DESCRIPTION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    descricao: { type: "string" },
    categoria: { type: "string" },
    tituloSeo: { type: "string" },
    descricaoSeo: { type: "string" },
    palavrasChaveSeo: { type: "string" },
  },
  required: ["descricao", "categoria", "tituloSeo", "descricaoSeo", "palavrasChaveSeo"],
};
const CHECKPOINT_VERSION = 2;
const WORKER_COUNT = 2;
const MAX_CANDIDATES_PER_QUERY = 3;
const MAX_QUERIES_PER_STORE = 6;
const MAX_AGENT_SUGGESTED_QUERIES = 2;
const MIN_IMAGES_BEFORE_STOP = 3;
const FIXED_RECYCLED_IMAGE_SOURCE = "imagem_fixa_reciclado";
const FIXED_RECYCLED_IMAGES = {
  cartucho:
    "https://esambiental.com.br/wp-content/uploads/2024/11/162886850861168f9cac5bd.jpg",
  toner:
    "https://media.istockphoto.com/id/1040514604/pt/foto/green-recycle-symbol-with-toner-cartridge-3d-rendering-isolated-on-white-background.jpg?s=612x612&w=0&k=20&c=WOmp7GlyDiCkO0JtKreuNp6zRU52uutuLgeWDFClVJY=",
};

const STORES = [
  {
    name: "Kalunga",
    buildSearchUrl: (name) =>
      `https://www.kalunga.com.br/busca/${encodeURIComponent(name)}`,
  },
  {
    name: "KaBuM",
    buildSearchUrl: (name) =>
      `https://www.kabum.com.br/busca/${encodeURIComponent(name)}`,
  },
  {
    name: "Creative Cópias",
    buildSearchUrl: (name) =>
      `https://www.creativecopias.com.br/catalogsearch/result/?q=${encodeURIComponent(name)}`,
  },
  {
    name: "Amazon Brasil",
    buildSearchUrl: (name) =>
      `https://www.amazon.com.br/s?k=${encodeURIComponent(name)}`,
  },
];

const DESCRIPTION_COLUMN = "Descrição complementar";
const CATEGORIA_COLUMN = "Categoria";
const TITULO_SEO_COLUMN = "Título SEO";
const DESCRICAO_SEO_COLUMN = "Descrição SEO";
const PALAVRAS_CHAVE_SEO_COLUMN = "Palavras chave SEO";
const IMAGE_COLUMNS = [
  "URL imagem 1",
  "URL imagem 2",
  "URL imagem 3",
  "URL imagem 4",
  "URL imagem 5",
  "URL imagem 6",
];
const REQUIRED_INPUT_COLUMNS = [
  "Código (SKU)",
  "Descrição",
  DESCRIPTION_COLUMN,
  ...IMAGE_COLUMNS,
];
const PAGE_AGENT_BRIDGE_STATE = new WeakMap();
if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(`Erro fatal: ${error.message}`);
    process.exitCode = 1;
  });
}

function isCliEntrypoint() {
  return Boolean(
    process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
  );
}

async function main() {
  loadEnv();

  const args = new Set(process.argv.slice(2));
  const resume = args.has("--resume");
  const apiKeys = buildGeminiApiKeys();
  const inputFile = process.env.INPUT_FILE || DEFAULT_INPUT_FILE;
  const { clickConfig, matchConfig } = buildGeminiConfigs(apiKeys);
  const timeouts = buildTimeoutConfig();
  const geminiRetryConfig = buildGeminiRetryConfig();

  if (apiKeys.length === 0) {
    throw new Error(
      "GEMINI_API_KEY nao configurada. Crie um .env com base em .env.example.",
    );
  }

  if (!existsSync(inputFile)) {
    throw new Error(`Planilha de entrada nao encontrada: ${inputFile}`);
  }

  if (!resume && existsSync(CHECKPOINT_FILE)) {
    throw new Error(
      `Checkpoint existente encontrado. Use "npm run resume" ou remova ${CHECKPOINT_FILE} para reiniciar.`,
    );
  }

  const products = readProducts(inputFile);
  validateInputColumns(products.headers);
  if (products.length === 0) {
    throw new Error("Nenhum produto valido encontrado na planilha.");
  }

  const checkpoint = resume ? await readCheckpoint() : emptyCheckpoint();
  const normalizedCheckpoint = normalizeCheckpoint(checkpoint);
  const processedSkus = normalizedCheckpoint.processedSkus;
  const results = normalizedCheckpoint.results;
  const pendingProducts = products.filter(
    (product) => !processedSkus.has(product.sku),
  );

  if (normalizedCheckpoint.retrySkus.length > 0) {
    console.log(
      `Checkpoint: ${normalizedCheckpoint.retrySkus.length} SKU(s) pendente(s) serao retentados: ${normalizedCheckpoint.retrySkus.join(", ")}`,
    );
  }

  if (pendingProducts.length === 0) {
    await writeResults(inputFile, results);
    console.log(
      `Todos os ${products.length} produtos ja foram processados. ${OUTPUT_FILE} atualizado.`,
    );
    return;
  }

  const pageAgentBundlePath = resolvePageAgentBundlePath();
  const browser = await chromium.launch({ headless: false });
  const startedAt = Date.now();
  const state = {
    inputFile,
    total: products.length,
    completed: processedSkus.size,
    completedThisRun: 0,
    processedSkus,
    results,
    technicalFailures: normalizedCheckpoint.technicalFailures,
  };

  console.log(
    `Iniciando busca: ${pendingProducts.length} pendentes de ${products.length} produtos | workers=${Math.min(WORKER_COUNT, pendingProducts.length)}`,
  );

  let context = null;

  try {
    context = await createBrowserContext(browser);
    await runProductWorkers({
      context,
      products: pendingProducts,
      state,
      startedAt,
      geminiConfig: clickConfig,
      matchGeminiConfig: matchConfig,
      timeouts,
      geminiRetryConfig,
      pageAgentBundlePath,
    });

    await saveProgress(state, true);
    console.log(`Concluido. Resultado final salvo em ${OUTPUT_FILE}.`);
  } finally {
    await context?.close();
    await browser.close();
  }
}

function loadEnv() {
  if (!existsSync(".env")) return;

  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(".env");
    return;
  }

  const content = require("node:fs").readFileSync(".env", "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function normalizeBaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function buildGeminiApiKeys(env = process.env) {
  return normalizeGeminiApiKeys([
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
  ]);
}

function normalizeGeminiApiKeys(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => String(entry || "").trim()).filter(Boolean);
}

function createGeminiKeyRotator(apiKeys) {
  const keys = normalizeGeminiApiKeys(apiKeys);
  let index = 0;

  return {
    keys,
    nextKey() {
      if (keys.length === 0) return "";
      const key = keys[index % keys.length];
      index += 1;
      return key;
    },
  };
}

function buildGeminiConfigs(apiKeys, env = process.env) {
  const normalizedApiKeys = normalizeGeminiApiKeys(apiKeys);
  const keyRotator = createGeminiKeyRotator(normalizedApiKeys);
  const baseURL = normalizeBaseUrl(
    env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL,
  );
  const nativeBaseURL = deriveNativeGeminiBaseURL(baseURL);
  return {
    clickConfig: {
      apiKey: normalizedApiKeys[0] || "",
      apiKeys: normalizedApiKeys,
      keyRotator,
      baseURL,
      nativeBaseURL,
      model: env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    },
    matchConfig: {
      apiKey: normalizedApiKeys[0] || "",
      apiKeys: normalizedApiKeys,
      keyRotator,
      baseURL,
      nativeBaseURL,
      model: env.GEMINI_MATCH_MODEL || DEFAULT_GEMINI_MATCH_MODEL,
    },
  };
}

function deriveNativeGeminiBaseURL(baseURL) {
  const normalized = normalizeBaseUrl(baseURL || DEFAULT_GEMINI_BASE_URL);
  return normalized.replace(/\/openai$/i, "");
}

function buildTimeoutConfig(env = process.env) {
  const storeHardTimeoutValue =
    env.STORE_HARD_TIMEOUT_MS ?? env.STORE_TIMEOUT_MS;
  return {
    storeHardTimeoutMs: readDurationMs(
      storeHardTimeoutValue,
      DEFAULT_STORE_HARD_TIMEOUT_MS,
      { allowZero: true },
    ),
    navigationTimeoutMs: readDurationMs(
      env.NAVIGATION_TIMEOUT_MS,
      DEFAULT_NAVIGATION_TIMEOUT_MS,
    ),
    pageSettleMs: readDurationMs(env.PAGE_SETTLE_MS, DEFAULT_PAGE_SETTLE_MS, {
      allowZero: true,
    }),
    pageAgentClickTimeoutMs: readDurationMs(
      env.PAGE_AGENT_CLICK_TIMEOUT_MS,
      DEFAULT_PAGE_AGENT_CLICK_TIMEOUT_MS,
    ),
    geminiMatchTimeoutMs: readDurationMs(
      env.GEMINI_MATCH_TIMEOUT_MS,
      DEFAULT_GEMINI_MATCH_TIMEOUT_MS,
    ),
  };
}

function buildGeminiRetryConfig(env = process.env) {
  return {
    attempts: readPositiveInt(
      env.GEMINI_RETRY_ATTEMPTS,
      DEFAULT_GEMINI_RETRY_ATTEMPTS,
    ),
    baseDelayMs: readDurationMs(
      env.GEMINI_RETRY_BASE_DELAY_MS,
      DEFAULT_GEMINI_RETRY_BASE_DELAY_MS,
      { allowZero: true },
    ),
    maxDelayMs: readDurationMs(
      env.GEMINI_RETRY_MAX_DELAY_MS,
      DEFAULT_GEMINI_RETRY_MAX_DELAY_MS,
      { allowZero: true },
    ),
  };
}

function readDurationMs(value, fallback, { allowZero = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;

  const rounded = Math.floor(parsed);
  if (rounded > 0 || (allowZero && rounded === 0)) return rounded;
  return fallback;
}

function readPositiveInt(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;

  const rounded = Math.floor(parsed);
  return rounded >= 1 ? rounded : fallback;
}

function readProducts(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1:A1");
  const headers = [];
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cellAddress = XLSX.utils.encode_cell({ r: range.s.r, c: column });
    headers.push(String(worksheet[cellAddress]?.v || "").trim());
  }
  const rows = XLSX.utils.sheet_to_json(worksheet, { defval: "" });

  const products = rows
    .map((row) => {
      const sku = String(
        row["Código (SKU)"] || row.sku || row.SKU || "",
      ).trim();
      const name = String(row.Descrição || row.nome || row.Nome || "").trim();
      const description = String(row[DESCRIPTION_COLUMN] || "").trim();
      return {
        sku,
        nome: name,
        descricaoComplementar: description,
        marca: String(row.Marca || "").trim(),
        categoria: String(row.Categoria || "").trim(),
        row,
      };
    })
    .filter((product) => product.sku && product.nome);
  products.headers = headers;
  return products;
}

function validateInputColumns(headers) {
  const headerSet = new Set(headers);
  const missing = REQUIRED_INPUT_COLUMNS.filter(
    (header) => !headerSet.has(header),
  );
  if (missing.length > 0) {
    throw new Error(
      `Planilha de entrada sem coluna(s) obrigatoria(s): ${missing.join(", ")}`,
    );
  }
}

async function readCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return emptyCheckpoint();

  const raw = await fs.readFile(CHECKPOINT_FILE, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Nao foi possivel ler ${CHECKPOINT_FILE}: ${error.message}`,
    );
  }
}

function emptyCheckpoint() {
  return {
    version: CHECKPOINT_VERSION,
    processedSkus: [],
    products: {},
    total: 0,
    completed: 0,
    updatedAt: null,
  };
}

function normalizeCheckpoint(checkpoint) {
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    const hasLegacyRows = Array.isArray(checkpoint.results);
    if (hasLegacyRows || checkpoint.version) {
      throw new Error(
        `Checkpoint incompativel com o formato atual. Remova ${CHECKPOINT_FILE} para reiniciar com checkpoint v${CHECKPOINT_VERSION}.`,
      );
    }
  }

  const products = checkpoint.products || {};
  const processedSkus = new Set();
  const results = {};
  const retrySkus = [];
  const technicalFailures = {};

  for (const [sku, result] of Object.entries(products)) {
    if (isCheckpointProductComplete(result)) {
      processedSkus.add(sku);
      results[sku] = result;
    } else {
      retrySkus.push(sku);
      technicalFailures[sku] = {
        erro: result?.erro || result?.status || "pendente",
        at: result?.updatedAt || checkpoint.updatedAt || null,
      };
    }
  }

  return { processedSkus, results, retrySkus, technicalFailures };
}

function isCheckpointProductComplete(result) {
  return (
    result?.status === "sucesso" &&
    Array.isArray(result.imagens) &&
    result.imagens.length > 0
  );
}

function resolvePageAgentBundlePath() {
  const entryPath = require.resolve("page-agent");
  const bundlePath = path.resolve(
    path.dirname(entryPath),
    "../iife/page-agent.demo.js",
  );
  if (!existsSync(bundlePath)) {
    throw new Error(
      `Bundle IIFE do page-agent nao encontrado em ${bundlePath}. Rode npm install.`,
    );
  }
  return bundlePath;
}

async function createBrowserContext(browser) {
  return await browser.newContext({
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
}

async function createStorePages(context) {
  const entries = await Promise.all(
    STORES.map(async (store) => [store.name, await context.newPage()]),
  );
  return new Map(entries);
}

async function closeStorePages(storePages) {
  await Promise.all(
    [...storePages.values()].map((page) => page.close().catch(() => {})),
  );
}

async function resetStorePage(context, storePages, storeName, page) {
  await page?.close().catch(() => {});
  const replacement = await context.newPage();
  storePages.set(storeName, replacement);
  return replacement;
}

async function runProductWorkers({
  context,
  products,
  state,
  startedAt,
  geminiConfig,
  matchGeminiConfig = geminiConfig,
  timeouts = buildTimeoutConfig(),
  geminiRetryConfig = buildGeminiRetryConfig(),
  pageAgentBundlePath,
  workerCount = WORKER_COUNT,
  productProcessor = processProduct,
  storePagesFactory = createStorePages,
  storePagesCloser = closeStorePages,
  progressSaver = saveProgress,
  delayBetweenProducts = sleep,
  randomDelayMs = () => randomInt(MIN_DELAY_MS, MAX_DELAY_MS),
}) {
  const activeWorkerCount = Math.min(workerCount, products.length);
  if (activeWorkerCount <= 0) return;

  let nextProductIndex = 0;
  const nextProduct = () => {
    if (nextProductIndex >= products.length) return null;
    const product = products[nextProductIndex];
    nextProductIndex += 1;
    return product;
  };
  const serialProgressSaver = createSerialProgressSaver(progressSaver);

  const workers = Array.from(
    { length: activeWorkerCount },
    async (_, index) => {
      const workerId = index + 1;
      const storePages = await storePagesFactory(context, workerId);

      try {
        while (true) {
          const product = nextProduct();
          if (!product) break;

          await productProcessor({
            workerId,
            context,
            storePages,
            product,
            state,
            startedAt,
            geminiConfig,
            matchGeminiConfig,
            timeouts,
            geminiRetryConfig,
            pageAgentBundlePath,
            progressSaver: serialProgressSaver,
          });

          if (nextProductIndex < products.length) {
            await delayBetweenProducts(randomDelayMs());
          }
        }
      } finally {
        await storePagesCloser(storePages);
      }
    },
  );

  await Promise.all(workers);
}

function createSerialProgressSaver(progressSaver = saveProgress) {
  let chain = Promise.resolve();

  return (state, writeResultFile) => {
    const run = chain.then(() => progressSaver(state, writeResultFile));
    chain = run.catch(() => {});
    return run;
  };
}

async function processProduct(options) {
  const {
    workerId,
    context,
    storePages,
    product,
    state,
    startedAt,
    geminiConfig,
    matchGeminiConfig = geminiConfig,
    timeouts = buildTimeoutConfig(),
    geminiRetryConfig = buildGeminiRetryConfig(),
    pageAgentBundlePath,
    storeSearcher = searchStore,
    matchValidator = validateProductMatchWithGemini,
    clickSelector = selectRelevantCandidatesWithPageAgent,
    progressSaver = saveProgress,
  } = options;
  const progress = formatProgress(state.completed, state.total);
  console.log(
    `[Worker ${workerId}] 🔍 ${product.sku} - Buscando "${product.nome}" | Progresso: ${progress}`,
  );

  const fixedImageRule = findFixedRecycledImageRule(product);
  let storeResults;

  if (fixedImageRule) {
    storeResults = buildFixedRecycledImageStoreResults(product, fixedImageRule);
    console.log(
      `[Worker ${workerId}] ${product.sku} - ${FIXED_RECYCLED_IMAGE_SOURCE}: usando imagem fixa de ${fixedImageRule.type} sem buscar lojas`,
    );
  } else {
    storeResults = [];
    for (const store of STORES) {
      const result = await storeSearcher({
        context,
        storePages,
        store,
        product,
        geminiConfig,
        matchGeminiConfig,
        timeouts,
        geminiRetryConfig,
        pageAgentBundlePath,
        matchValidator,
        clickSelector,
      });
      storeResults.push(result);

      if (hasEnoughImagesToStopStoreSearch(result)) {
        const skippedStores = STORES.slice(storeResults.length);
        storeResults.push(
          ...skippedStores.map((skippedStore) =>
            buildSkippedStoreResult({
              product,
              store: skippedStore,
              successfulStore: result.loja,
              imageCount: result.imageCount,
            }),
          ),
        );
        break;
      }
    }
  }

  for (const result of storeResults) {
    if (result.status === "erro" && result.errorType === "timeout") {
      console.log(
        `[Worker ${workerId}] ✗ ${product.sku} - Timeout na ${result.loja}, pulando...`,
      );
    }
  }

  const summary = storeResults
    .map((result) => `${result.loja} → ${result.imageCount} imagens`)
    .join(" | ");
  const selectedImages = selectBestImages(storeResults);
  const hasSuccess = selectedImages.length > 0;
  console.log(
    `[Worker ${workerId}] ${hasSuccess ? "✓" : "✗"} ${product.sku} - ${summary} | selecionadas=${selectedImages.length}`,
  );

  state.completedThisRun += 1;

  if (selectedImages.length === 0) {
    const erro = "Nenhuma imagem nova valida encontrada.";
    const causa = classifyProductImageFailure(storeResults);
    state.technicalFailures[product.sku] = {
      erro,
      causa,
      lojas: storeResults.map(summarizeStoreResult),
      at: new Date().toISOString(),
    };
    state.results[product.sku] = buildPendingProductResult({
      product,
      erro,
      causa,
      storeResults,
    });
    console.log(
      `[Worker ${workerId}] ${product.sku} - ${erro} SKU nao sera marcado como concluido no checkpoint.`,
    );
    await progressSaver(state, false);
    console.log(
      `⏱ Tempo estimado restante: ${formatEta(startedAt, state.completedThisRun, state.total - state.completed)}`,
    );
    return;
  }

  delete state.technicalFailures[product.sku];
  const bestStoreResult = selectBestStoreResult(storeResults);
  state.results[product.sku] = {
    sku: product.sku,
    status: "sucesso",
    imagens: selectedImages,
    metadadosGerados: bestStoreResult?.metadadosGerados || null,
    descricaoGerada: bestStoreResult?.descricaoGerada || "",
    lojas: storeResults.map(summarizeStoreResult),
    updatedAt: new Date().toISOString(),
  };
  state.processedSkus.add(product.sku);
  state.completed = state.processedSkus.size;

  await progressSaver(state, state.completedThisRun % 10 === 0);
  console.log(
    `⏱ Tempo estimado restante: ${formatEta(startedAt, state.completedThisRun, state.total - state.completed)}`,
  );
}

function findFixedRecycledImageRule(product) {
  const brand = normalizeProductRuleText(
    product.marca || product.row?.Marca || "",
  );
  if (brand !== "rei dos cartuchos") return null;

  const nameAndDescription = normalizeProductRuleText(
    `${product.nome} ${product.descricaoComplementar}`,
  );
  if (!/\breciclad[oa]s?\b/.test(nameAndDescription)) return null;

  const typeText = normalizeProductRuleText(
    `${product.nome} ${product.descricaoComplementar} ${product.categoria || ""}`,
  );
  if (/\btoners?\b/.test(typeText)) {
    return {
      source: FIXED_RECYCLED_IMAGE_SOURCE,
      type: "toner",
      imageUrl: FIXED_RECYCLED_IMAGES.toner,
    };
  }
  if (/\bcartuchos?\b/.test(typeText)) {
    return {
      source: FIXED_RECYCLED_IMAGE_SOURCE,
      type: "cartucho",
      imageUrl: FIXED_RECYCLED_IMAGES.cartucho,
    };
  }

  return null;
}

function buildFixedRecycledImageStoreResults(product, fixedImageRule) {
  return [
    buildStoreResult({
      product,
      store: { name: fixedImageRule.source },
      status: "sucesso",
      titulo: product.nome,
      imagens: [fixedImageRule.imageUrl],
      descricao:
        "Imagem aplicada por regra deterministica para produto reciclado Rei Dos Cartuchos.",
      diagnostico: {
        causa: "",
        origem: FIXED_RECYCLED_IMAGE_SOURCE,
        tipo: fixedImageRule.type,
      },
    }),
  ];
}

function hasEnoughImagesToStopStoreSearch(result) {
  return (
    result?.status === "sucesso" &&
    (result.imageCount || result.imagens?.length || 0) >= MIN_IMAGES_BEFORE_STOP
  );
}

function buildSkippedStoreResult({
  product,
  store,
  successfulStore,
  imageCount,
}) {
  return buildStoreResult({
    product,
    store,
    status: "pulado",
    descricao: `Busca interrompida: ${successfulStore} ja retornou ${imageCount} imagem(ns) valida(s).`,
    diagnostico: {
      causa: "busca_interrompida_sucesso_suficiente",
      lojaComSucesso: successfulStore,
      imagens: imageCount,
      minimo: MIN_IMAGES_BEFORE_STOP,
    },
  });
}

function selectBestImages(storeResults) {
  const ranked = rankStoreResults(storeResults);
  return ranked[0]?.imagens || [];
}

function selectBestStoreResult(storeResults) {
  const ranked = rankStoreResults(storeResults);
  if (ranked.length === 0) return null;
  return storeResults[ranked[0].index];
}

function rankStoreResults(storeResults) {
  return storeResults
    .map((result, index) => ({
      index,
      imagens: unique(result.imagens || []).slice(0, IMAGE_COLUMNS.length),
    }))
    .filter((entry) => entry.imagens.length > 0)
    .sort((a, b) => b.imagens.length - a.imagens.length || a.index - b.index);
}

function summarizeStoreResult(result) {
  return {
    loja: result.loja,
    status: result.status,
    imagens: result.imageCount || 0,
    titulo: result.titulo_encontrado || "",
    url: result.url_anuncio || "",
    erro: result.errorType || "",
    validacao: result.matchValidation
      ? {
          aprovado: Boolean(result.matchValidation.aprovado),
          motivo: result.matchValidation.motivo || "",
        }
      : null,
    diagnostico: result.diagnostico || null,
  };
}

function buildPendingProductResult({
  product,
  erro,
  causa = "",
  storeResults,
  imagens = [],
}) {
  return {
    sku: product.sku,
    status: "pendente",
    erro,
    causa,
    imagens,
    lojas: storeResults.map(summarizeStoreResult),
    updatedAt: new Date().toISOString(),
  };
}

async function searchStore({
  context,
  storePages,
  store,
  product,
  geminiConfig,
  matchGeminiConfig,
  timeouts = buildTimeoutConfig(),
  geminiRetryConfig = buildGeminiRetryConfig(),
  pageAgentBundlePath,
  matchValidator,
  clickSelector,
}) {
  const page =
    storePages.get(store.name) ||
    (await resetStorePage(context, storePages, store.name));

  try {
    const search = searchStoreWithPage({
      page,
      store,
      product,
      geminiConfig,
      matchGeminiConfig,
      timeouts,
      geminiRetryConfig,
      pageAgentBundlePath,
      matchValidator,
      clickSelector,
    });
    return await withOptionalTimeout(
      search,
      timeouts.storeHardTimeoutMs,
      `Hard timeout de ${timeouts.storeHardTimeoutMs / 1000}s na ${store.name}`,
    );
  } catch (error) {
    await resetStorePage(context, storePages, store.name, page);
    const timeoutStage = isTimeoutLikeError(error) ? "store_hard_timeout" : "";
    const errorType = timeoutStage ? "timeout" : "technical";
    return buildStoreResult({
      product,
      store,
      status: "erro",
      descricao: `Erro: ${error.message}`,
      errorType,
      diagnostico: {
        causa: "erro_tecnico_loja",
        erroTecnico: error.message,
        errorType,
        timeoutStage,
      },
    });
  }
}

async function searchStoreWithPage({
  page,
  store,
  product,
  geminiConfig,
  matchGeminiConfig = geminiConfig,
  timeouts = buildTimeoutConfig(),
  geminiRetryConfig = buildGeminiRetryConfig(),
  pageAgentBundlePath,
  matchValidator = validateProductMatchWithGemini,
  clickSelector = selectRelevantCandidatesWithPageAgent,
}) {
  page.setDefaultTimeout(timeouts.navigationTimeoutMs);
  page.setDefaultNavigationTimeout(timeouts.navigationTimeoutMs);
  await page
    .goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 })
    .catch(() => {});

  const queries = [...buildSearchQueries(product.nome)];
  let lastSearchSnapshot = null;
  let lastMatchValidation = null;
  const rejectedCandidates = [];
  const diagnostico = createStoreDiagnostics();
  let suggestionsCollected = false;

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    const isFirstQuery = queryIndex === 0;
    const searchUrl = store.buildSearchUrl(query);
    const queryDiagnostic = {
      query,
      searchUrl,
      noResult: false,
      blocked: false,
      candidatesFound: 0,
      uniqueCandidates: 0,
      candidatesAvailable: 0,
      relevantCandidatesSelected: 0,
      event: "",
      timeoutStage: "",
    };
    diagnostico.queries.push(queryDiagnostic);

    const searchNavigationFailure = await navigateWithDiagnostics({
      page,
      url: searchUrl,
      timeouts,
      timeoutStage: "search_navigation",
    });
    if (searchNavigationFailure) {
      queryDiagnostic.event = searchNavigationFailure.reason;
      queryDiagnostic.timeoutStage = searchNavigationFailure.timeoutStage;
      queryDiagnostic.erroTecnico = searchNavigationFailure.message;
      continue;
    }

    const searchSnapshot = await inspectSearchPage(page, store, product, query);
    lastSearchSnapshot = searchSnapshot;
    queryDiagnostic.noResult = Boolean(searchSnapshot.noResult);
    queryDiagnostic.blocked = Boolean(searchSnapshot.blocked);
    queryDiagnostic.candidatesFound = searchSnapshot.candidates.length;

    if (searchSnapshot.blocked) {
      queryDiagnostic.event = "bloqueio_automacao_loja";
      return buildStoreResult({
        product,
        store,
        status: "erro",
        descricao: "Loja exibiu bloqueio de automacao/captcha.",
        errorType: "technical",
        diagnostico: {
          ...diagnostico,
          causa: "erro_tecnico_loja",
          erroTecnico: "bloqueio_automacao_loja",
          errorType: "technical",
        },
      });
    }

    if (searchSnapshot.noResult) {
      queryDiagnostic.event = "sem_resultado_loja";
      continue;
    }

    const uniqueSearchCandidates = uniqueCandidates(searchSnapshot.candidates);
    queryDiagnostic.uniqueCandidates = uniqueSearchCandidates.length;
    const candidates = uniqueSearchCandidates
      .filter(
        (candidate) => !isRejectedCandidate(candidate, rejectedCandidates),
      )
      .slice(0, MAX_CANDIDATES_PER_QUERY);
    queryDiagnostic.candidatesAvailable = candidates.length;
    if (candidates.length === 0) {
      if (uniqueSearchCandidates.length > 0) {
        queryDiagnostic.event = "todos_candidatos_ja_rejeitados";
        console.log(
          `[PageAgent Candidates] ${product.sku} ${store.name} -> query "${query}" trouxe apenas candidato(s) ja rejeitado(s)`,
        );
      } else {
        queryDiagnostic.event = "sem_candidatos_extraidos";
      }
      continue;
    }

    let clickResult;
    try {
      clickResult = await clickSelector({
        page,
        store,
        product,
        query,
        candidates,
        rejectedCandidates,
        geminiConfig,
        timeouts,
        geminiRetryConfig,
        pageAgentBundlePath,
        allowSuggestions: isFirstQuery && !suggestionsCollected,
      });
    } catch (error) {
      const failure = operationFailure(error, "pageagent_candidate_selection");
      queryDiagnostic.event = failure.reason;
      queryDiagnostic.timeoutStage = failure.timeoutStage;
      queryDiagnostic.erroTecnico = failure.message;
      continue;
    }
    const { candidates: relevantCandidates, suggestedQueries } =
      normalizeClickSelectorResult(clickResult, candidates, rejectedCandidates);
    queryDiagnostic.relevantCandidatesSelected = relevantCandidates.length;
    if (relevantCandidates.length === 0) {
      queryDiagnostic.event = "pageagent_sem_escolha";
      if (isFirstQuery && !suggestionsCollected && suggestedQueries.length > 0) {
        suggestionsCollected = true;
        for (const suggested of suggestedQueries) {
          if (queries.length >= MAX_QUERIES_PER_STORE) break;
          if (!queries.includes(suggested)) {
            queries.push(suggested);
          }
        }
        queryDiagnostic.sugestoesBusca = suggestedQueries;
      }
      continue;
    }

    for (const candidate of relevantCandidates) {
      if (isRejectedCandidate(candidate, rejectedCandidates)) continue;

      if (page.url() !== searchUrl) {
        const returnNavigationFailure = await navigateWithDiagnostics({
          page,
          url: searchUrl,
          timeouts,
          timeoutStage: "search_return_navigation",
        });
        if (returnNavigationFailure) {
          queryDiagnostic.event = returnNavigationFailure.reason;
          queryDiagnostic.timeoutStage = returnNavigationFailure.timeoutStage;
          queryDiagnostic.erroTecnico = returnNavigationFailure.message;
          break;
        }
      }

      const candidateNavigationFailure = await navigateWithDiagnostics({
        page,
        url: candidate.href,
        timeouts,
        timeoutStage: "candidate_navigation",
      });
      if (candidateNavigationFailure) {
        addCandidateRejectionDiagnostic(diagnostico, {
          candidate,
          query,
          reason: candidateNavigationFailure.reason,
          motivo: candidateNavigationFailure.message,
          timeoutStage: candidateNavigationFailure.timeoutStage,
          errorType: candidateNavigationFailure.errorType,
        });
        rejectCandidate(rejectedCandidates, candidate, candidateNavigationFailure.message);
        continue;
      }

      let imageExtraction;
      let candidateResult;
      try {
        imageExtraction = await extractValidatedProductImagesWithDiagnostics(
          page,
          store,
          product,
        );
        candidateResult = await extractDeterministicProductData({
          page,
          store,
          product,
          validatedImages: imageExtraction.images,
        });
      } catch (error) {
        const failure = operationFailure(error, "candidate_extraction");
        addCandidateRejectionDiagnostic(diagnostico, {
          candidate,
          query,
          reason: failure.reason,
          motivo: failure.message,
          timeoutStage: failure.timeoutStage,
          errorType: failure.errorType,
        });
        rejectCandidate(rejectedCandidates, candidate, failure.message);
        continue;
      }

      if (!hasUsableCandidateData(candidateResult)) {
        const motivo = describeCandidateDataFailure(candidateResult);
        console.log(
          `[Match] ${product.sku} ${store.name} -> candidato ignorado sem titulo, URL ou imagem valida`,
        );
        addCandidateRejectionDiagnostic(diagnostico, {
          candidate,
          query,
          reason: motivo.reason,
          motivo: motivo.message,
          candidateResult,
          imageDiagnostics: imageExtraction.diagnostico,
        });
        rejectCandidate(rejectedCandidates, candidate, motivo.message);
        continue;
      }

      let matchValidation;
      try {
        matchValidation = await matchValidator({
          product,
          store,
          query,
          candidate,
          candidateResult,
          geminiConfig: matchGeminiConfig,
          timeoutMs: timeouts.geminiMatchTimeoutMs,
          retryConfig: geminiRetryConfig,
        });
      } catch (error) {
        const failure = operationFailure(error, "gemini_match");
        matchValidation = {
          aprovado: false,
          motivo: `Erro na validacao Gemini: ${error.message}`,
          errorType: "validation",
          failureReason: failure.reason,
          timeoutStage: failure.timeoutStage,
        };
      }
      lastMatchValidation = matchValidation;

      if (!matchValidation.aprovado) {
        console.log(
          `[Gemini Match] ${product.sku} ${store.name} -> reprovado: ${matchValidation.motivo}`,
        );
        addCandidateRejectionDiagnostic(diagnostico, {
          candidate,
          query,
          reason: matchValidation.failureReason || "gemini_reprovou",
          motivo: matchValidation.motivo,
          candidateResult,
          imageDiagnostics: imageExtraction.diagnostico,
          timeoutStage: matchValidation.timeoutStage || "",
          errorType: matchValidation.errorType || "",
        });
        rejectCandidate(rejectedCandidates, candidate, matchValidation.motivo);
        if (matchValidation.failureReason) {
          queryDiagnostic.event = matchValidation.failureReason;
          queryDiagnostic.timeoutStage = matchValidation.timeoutStage || "";
          queryDiagnostic.erroTecnico = matchValidation.motivo;
          break;
        }
        continue;
      }

      console.log(
        `[Gemini Match] ${product.sku} ${store.name} -> aprovado: ${matchValidation.motivo}`,
      );

      let metadadosGerados = null;
      try {
        metadadosGerados = await generateProductDescription({
          page,
          store,
          product,
          geminiConfig: matchGeminiConfig,
          retryConfig: geminiRetryConfig,
        });
        if (metadadosGerados && metadadosGerados.descricao) {
          console.log(
            `[Metadados] ${product.sku} ${store.name} -> metadados gerados com sucesso`,
          );
        }
      } catch (descError) {
        console.warn(
          `[Metadados] ${product.sku} ${store.name} -> erro ao gerar: ${descError.message}`,
        );
      }

      return {
        ...candidateResult,
        metadadosGerados,
        matchValidation,
        diagnostico: {
          ...diagnostico,
          causa: "",
          imagem: imageExtraction.diagnostico,
        },
      };
    }

    if (!queryDiagnostic.event) {
      queryDiagnostic.event = "candidatos_rejeitados";
    }
  }

  diagnostico.causa = classifyStoreFailure(diagnostico);

  return buildStoreResult({
    product,
    store,
    status: "não encontrado",
    descricao: `Nenhum candidato relevante encontrado. Queries testadas: ${queries.join(" | ")}${lastSearchSnapshot?.noResult ? " | ultima busca sem resultados" : ""}`,
    matchValidation: lastMatchValidation,
    diagnostico,
  });
}

async function waitForPageSettle(page, timeouts) {
  if (timeouts.pageSettleMs <= 0) return;
  await page.waitForTimeout(timeouts.pageSettleMs);
}

async function navigateWithDiagnostics({ page, url, timeouts, timeoutStage }) {
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeouts.navigationTimeoutMs,
    });
    await waitForPageSettle(page, timeouts);
    return null;
  } catch (error) {
    return operationFailure(error, timeoutStage);
  }
}

function operationFailure(error, timeoutStage) {
  const timeout = isTimeoutLikeError(error);
  return {
    reason: timeout ? `${timeoutStage}_timeout` : `${timeoutStage}_erro`,
    message: error?.message || String(error),
    timeoutStage: timeout ? timeoutStage : "",
    errorType: timeout ? "timeout" : "technical",
  };
}

function hasUsableCandidateData(result) {
  return (
    result?.titulo_encontrado &&
    result?.url_anuncio &&
    Array.isArray(result.imagens) &&
    result.imagens.length > 0
  );
}

function createStoreDiagnostics() {
  return {
    causa: "",
    queries: [],
    rejeicoes: [],
  };
}

function addCandidateRejectionDiagnostic(
  diagnostico,
  {
    candidate,
    query,
    reason,
    motivo,
    candidateResult,
    imageDiagnostics,
    timeoutStage = "",
    errorType = "",
  },
) {
  diagnostico.rejeicoes.push({
    query,
    reason,
    motivo,
    href: candidate?.href || "",
    texto: candidate?.text || candidate?.searchText || "",
    titulo: candidateResult?.titulo_encontrado || "",
    url: candidateResult?.url_anuncio || "",
    imagens:
      candidateResult?.imageCount || candidateResult?.imagens?.length || 0,
    diagnosticoImagem: imageDiagnostics || null,
    timeoutStage,
    errorType,
  });
}

function describeCandidateDataFailure(result) {
  if (!result?.titulo_encontrado) {
    return {
      reason: "extracao_sem_titulo",
      message: "Dados tecnicos insuficientes apos clique: titulo ausente.",
    };
  }
  if (!result?.url_anuncio) {
    return {
      reason: "extracao_sem_url",
      message: "Dados tecnicos insuficientes apos clique: URL ausente.",
    };
  }
  return {
    reason: "sem_imagem_validada",
    message: "Dados tecnicos insuficientes apos clique: nenhuma imagem valida.",
  };
}

function classifyStoreFailure(diagnostico) {
  const rejeicoes = diagnostico.rejeicoes || [];
  if (rejeicoes.some((item) => item.reason === "sem_imagem_validada")) {
    return "sem_imagem_validada";
  }
  if (
    rejeicoes.some(
      (item) => item.errorType === "timeout" || item.errorType === "technical",
    ) ||
    (diagnostico.queries || []).some((item) => item.erroTecnico)
  ) {
    return "erro_tecnico_loja";
  }
  if (
    rejeicoes.length > 0 &&
    rejeicoes.every((item) => item.reason === "gemini_reprovou")
  ) {
    return "gemini_reprovou_todos";
  }
  if (
    (diagnostico.queries || []).some(
      (item) => item.event === "pageagent_sem_escolha",
    )
  ) {
    return "pageagent_sem_escolha";
  }
  if (
    (diagnostico.queries || []).length > 0 &&
    (diagnostico.queries || []).every(
      (item) =>
        item.noResult ||
        item.candidatesFound === 0 ||
        item.event === "sem_candidatos_extraidos",
    )
  ) {
    return "sem_resultado_lojas";
  }
  if (
    (diagnostico.queries || []).some(
      (item) => item.event === "todos_candidatos_ja_rejeitados",
    )
  ) {
    return "gemini_reprovou_todos";
  }
  return "sem_imagem_validada";
}

function classifyProductImageFailure(storeResults) {
  const causes = storeResults
    .map((result) => {
      if (result.status === "erro") return "erro_tecnico_loja";
      return result.diagnostico?.causa || "";
    })
    .filter(Boolean);

  if (causes.includes("sem_imagem_validada")) return "sem_imagem_validada";
  if (causes.includes("erro_tecnico_loja")) return "erro_tecnico_loja";
  if (
    causes.length > 0 &&
    causes.every((cause) => cause === "sem_resultado_lojas")
  ) {
    return "sem_resultado_lojas";
  }
  if (causes.includes("pageagent_sem_escolha")) return "pageagent_sem_escolha";
  if (causes.includes("gemini_reprovou_todos")) return "gemini_reprovou_todos";
  return causes[0] || "sem_imagem_validada";
}

async function extractDeterministicProductData({
  page,
  store,
  product,
  validatedImages,
}) {
  const payload = await page.evaluate(() => {
    const clean = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    const firstText = (selectors) => {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        const text = clean(node?.textContent || node?.getAttribute("content"));
        if (text) return text;
      }
      return "";
    };
    const collectSectionText = (selectors) => {
      const texts = [];
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          const text = clean(node.innerText || node.textContent);
          if (text && text.length > 20) texts.push(text);
        }
      }
      return texts.sort((a, b) => b.length - a.length)[0] || "";
    };

    const title = firstText([
      "h1",
      "[data-testid*=title i]",
      "[class*=product-name i]",
      "[class*=productName i]",
      "[class*=titulo i]",
      "[class*=title i]",
      "meta[property='og:title']",
    ]);

    const description =
      collectSectionText([
        "[itemprop='description']",
        "[data-testid*=description i]",
        "[class*=description i]",
        "[class*=descricao i]",
        "#descricao",
        "#description",
        "section",
      ]) ||
      firstText([
        "meta[name='description']",
        "meta[property='og:description']",
      ]);

    return {
      title,
      description,
      url: location.href,
    };
  });

  const normalized = {
    titulo: cleanText(payload.title),
    descricao: cleanText(payload.description),
    url_anuncio: normalizeUrl(payload.url, page.url()),
    imagens: unique(validatedImages),
  };
  const imageNote =
    normalized.imagens.length === 0
      ? " | Nenhuma imagem valida encontrada"
      : "";
  const status =
    normalized.titulo && normalized.url_anuncio
      ? normalized.imagens.length >= 1
        ? "sucesso"
        : "erro"
      : "não encontrado";

  return buildStoreResult({
    product,
    store,
    status,
    titulo: normalized.titulo,
    url: normalized.url_anuncio,
    imagens: normalized.imagens,
    descricao: `${normalized.descricao || "Extracao deterministica sem descricao suficiente."}${imageNote}`,
    errorType: status === "erro" ? "extraction" : null,
  });
}

async function selectRelevantCandidatesWithPageAgent({
  page,
  store,
  product,
  query,
  candidates,
  rejectedCandidates,
  geminiConfig,
  timeouts = buildTimeoutConfig(),
  geminiRetryConfig = buildGeminiRetryConfig(),
  pageAgentBundlePath,
  allowSuggestions = false,
}) {
  const availableCandidates = candidates.filter(
    (candidate) => !isRejectedCandidate(candidate, rejectedCandidates),
  );
  if (availableCandidates.length === 0) return { candidates: [], suggestedQueries: [] };

  await installPageAgentBridge(page, store, product, geminiConfig, {
    retryConfig: geminiRetryConfig,
  });
  await injectPageAgent(page, pageAgentBundlePath);

  const payload = await withTimeout(
    executePageAgentTask({
      page,
      geminiConfig,
      task: buildClickSelectionPrompt({
        product,
        store,
        query,
        candidates: availableCandidates,
        rejectedCandidates,
        allowSuggestions,
      }),
    }),
    timeouts.pageAgentClickTimeoutMs,
    `Timeout PageAgent de ${timeouts.pageAgentClickTimeoutMs / 1000}s ao selecionar anuncios`,
  );
  const selectedCandidates = normalizeRelevantCandidateSelection(
    payload,
    availableCandidates,
    rejectedCandidates,
  );
  const suggestedQueries = normalizeSuggestedQueries(payload);

  if (selectedCandidates.length === 0) {
    if (suggestedQueries.length > 0) {
      console.log(
        `[PageAgent Candidates] ${product.sku} ${store.name} -> nenhum candidato relevante, sugestões: ${JSON.stringify(suggestedQueries)}`,
      );
    } else {
      console.log(
        `[PageAgent Candidates] ${product.sku} ${store.name} -> nenhum candidato relevante`,
      );
    }
    return { candidates: [], suggestedQueries };
  }

  const selectedUrls = selectedCandidates
    .map((candidate) => candidate.href)
    .join(" | ");
  console.log(
    `[PageAgent Candidates] ${product.sku} ${store.name} -> selecionados=${selectedCandidates.length}: ${selectedUrls}`,
  );
  return { candidates: selectedCandidates, suggestedQueries: [] };
}

async function executePageAgentTask({ page, geminiConfig, task }) {
  const agentResult = await page.evaluate(
    async ({ task, apiKey, baseURL, model }) => {
      if (!window.PageAgent) {
        throw new Error("PageAgent nao foi carregado na pagina.");
      }

      window.__productSearchAgent?.dispose?.();
      window.pageAgent?.dispose?.();

      const agent = new window.PageAgent({
        model,
        baseURL,
        apiKey,
        language: "pt-BR",
        enableMask: false,
        promptForNextTask: false,
        maxSteps: 1,
        stepDelay: 0.2,
        customFetch: async (url, options = {}) => {
          const headers =
            options.headers instanceof Headers
              ? Object.fromEntries(options.headers.entries())
              : options.headers;
          const response = await window.__pageAgentFetch({
            url,
            method: options.method,
            headers,
            body: options.body,
          });
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
        transformRequestBody: (body) => {
          const nextBody = { ...body };
          delete nextBody.reasoning_effort;
          return nextBody;
        },
      });

      window.__productSearchAgent = agent;
      const result = await agent.execute(task);
      agent.dispose?.();
      window.__productSearchAgent = null;
      return { success: result.success, data: result.data };
    },
    {
      task,
      apiKey: geminiConfig.apiKey,
      baseURL: geminiConfig.baseURL,
      model: geminiConfig.model,
    },
  );

  return parseAgentPayload(agentResult.data);
}

async function installPageAgentBridge(
  page,
  store,
  product,
  geminiConfig,
  { retryConfig = buildGeminiRetryConfig() } = {},
) {
  let bindingState = PAGE_AGENT_BRIDGE_STATE.get(page);
  if (bindingState) {
    Object.assign(bindingState, { store, product, geminiConfig, retryConfig });
    return;
  }

  bindingState = { store, product, geminiConfig, retryConfig };
  PAGE_AGENT_BRIDGE_STATE.set(page, bindingState);

  await page.exposeBinding("__pageAgentFetch", async (_source, request) => {
    const current = PAGE_AGENT_BRIDGE_STATE.get(page) || bindingState;
    const startedAt = Date.now();
    const result = await fetchGeminiWithRetry(
      {
        url: request.url,
        method: request.method || "GET",
        headers: request.headers || {},
        body: request.body,
        geminiConfig: current.geminiConfig,
        authMode: "openai",
      },
      current.retryConfig,
      {
        product: current.product,
        store: current.store,
      },
    );
    const contentType = result.headers["content-type"] || "";
    const elapsedMs = Date.now() - startedAt;
    const url = redactGeminiSecrets(request.url, current.geminiConfig);
    const preview = result.body.slice(0, 220).replace(/\s+/g, " ");

    console.log(
      `[Gemini] ${current.product.sku} ${current.store.name} ${request.method || "GET"} ${url} -> ${result.status} ${result.statusText} | ${result.body.length} bytes | ${contentType} | ${elapsedMs}ms${result.ok ? "" : ` | ${preview}`}`,
    );

    return {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: result.body,
    };
  });
}

async function fetchGeminiWithRetry(request, retryConfig, context = {}) {
  const attempts = Math.max(1, retryConfig?.attempts || 1);
  let lastResult = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const headers = buildGeminiRequestHeaders(
        request.headers,
        request.geminiConfig,
        request.authMode,
      );
      const response = await fetch(request.url, {
        method: request.method || "GET",
        headers,
        body: request.body,
      });
      const result = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
      lastResult = result;

      if (!isRetryableGeminiStatus(result.status) || attempt >= attempts) {
        return result;
      }

      await waitBeforeGeminiRetry({
        attempt,
        attempts,
        retryConfig,
        context,
        reason: `HTTP ${result.status} ${result.statusText}`,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) throw error;

      await waitBeforeGeminiRetry({
        attempt,
        attempts,
        retryConfig,
        context,
        reason: error.message,
      });
    }
  }

  if (lastResult) return lastResult;
  throw lastError || new Error("Falha Gemini sem resposta");
}

function buildGeminiRequestHeaders(headers, geminiConfig, authMode = "native") {
  const nextHeaders = normalizeHeaders(headers);
  const apiKey = nextGeminiApiKey(geminiConfig);
  if (!apiKey) return nextHeaders;

  for (const headerName of Object.keys(nextHeaders)) {
    const lowerName = headerName.toLowerCase();
    if (lowerName === "authorization" || lowerName === "x-goog-api-key") {
      delete nextHeaders[headerName];
    }
  }
  if (authMode === "openai") {
    nextHeaders.Authorization = `Bearer ${apiKey}`;
  } else {
    nextHeaders["x-goog-api-key"] = apiKey;
  }
  return nextHeaders;
}

function normalizeHeaders(headers = {}) {
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

function nextGeminiApiKey(geminiConfig) {
  return geminiConfig?.keyRotator?.nextKey?.() || geminiConfig?.apiKey || "";
}

function redactGeminiSecrets(value, geminiConfig) {
  let redacted = String(value || "");
  const keys = normalizeGeminiApiKeys([
    ...(geminiConfig?.apiKeys || []),
    geminiConfig?.apiKey,
  ]);
  for (const key of keys) {
    redacted = redacted.split(key).join("[redacted]");
  }
  return redacted;
}

async function waitBeforeGeminiRetry({
  attempt,
  attempts,
  retryConfig,
  context,
  reason,
}) {
  const delayMs = calculateGeminiRetryDelay(attempt, retryConfig);
  const sku = context.product?.sku || "?";
  const storeName = context.store?.name || "?";
  console.log(
    `[Gemini Retry] ${sku} ${storeName} -> tentativa ${attempt + 1}/${attempts} apos ${reason}; aguardando ${delayMs}ms`,
  );
  if (delayMs > 0) await sleep(delayMs);
}

function calculateGeminiRetryDelay(attempt, retryConfig) {
  const baseDelayMs = Math.max(0, retryConfig?.baseDelayMs || 0);
  const maxDelayMs = Math.max(0, retryConfig?.maxDelayMs || 0);
  if (baseDelayMs === 0 || maxDelayMs === 0) return 0;

  const exponentialDelay = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(baseDelayMs, 250));
  return Math.min(maxDelayMs, exponentialDelay + jitter);
}

function isRetryableGeminiStatus(status) {
  return [429, 500, 502, 503, 504].includes(status);
}

async function extractValidatedProductImagesWithDiagnostics(
  page,
  store,
  product,
) {
  const imageCollection = await collectProductImageCandidatesWithDiagnostics(
    page,
    store,
    product,
  );
  const candidates = imageCollection.candidates;
  const effectiveStore = imageCollection.effectiveStoreName
    ? { ...store, name: imageCollection.effectiveStoreName }
    : store;
  const validation = await validateImageUrlsInPageDetailed(
    page,
    candidates.map((candidate) => candidate.url),
    effectiveStore,
  );
  const diagnostico = {
    perfilImagem: effectiveStore.name,
    coletadas: candidates.length,
    normalizadas: validation.normalizedCount,
    plausiveis: validation.plausibleCount,
    validas: validation.valid.length,
    rejeitadasPorFiltro: validation.rejectedByPlausibilityCount,
    rejeitadasPorLoad: validation.invalidLoadCount,
    rejeitadasPorDuplicidade: validation.rejectedByDuplicateCount,
    rejeitadasPorOutroProduto: imageCollection.rejectedByOtherProductCount,
    amazonImageBlockMissing: Boolean(imageCollection.amazonImageBlockMissing),
    productGalleryMissing: Boolean(imageCollection.productGalleryMissing),
  };

  if (validation.valid.length < 4) {
    console.log(
      `[Images] ${product.sku} ${store.name} -> coletadas=${diagnostico.coletadas} plausiveis=${diagnostico.plausiveis} validas=${diagnostico.validas}`,
    );
  }

  if (diagnostico.rejeitadasPorLoad > 0) {
    console.log(
      `[Images] ${product.sku} ${store.name} descartou ${diagnostico.rejeitadasPorLoad} URL(s) que nao carregaram como imagem`,
    );
  }

  return {
    images: validation.valid,
    diagnostico,
  };
}

async function collectProductImageCandidatesWithDiagnostics(
  page,
  store,
  product,
) {
  return await page.evaluate(
    ({ storeName, productName }) => {
      const normalize = (value) =>
        String(value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();
      const clean = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      const effectiveStoreName = detectImageStoreName(
        location.hostname,
        storeName,
      );
      const productTokens = normalize(productName)
        .split(/[^a-z0-9]+/i)
        .filter((token) => token.length > 1);
      const productId = extractPageProductId(
        location.pathname,
        effectiveStoreName,
      );

      const parseSrcset = (srcset) =>
        String(srcset || "")
          .split(",")
          .map((part) => part.trim().split(/\s+/)[0])
          .filter(Boolean);
      const absolute = (url) => {
        try {
          return new URL(url, location.href).toString();
        } catch {
          return "";
        }
      };
      function detectImageStoreName(hostname, currentStoreName) {
        if (currentStoreName !== "Google") return currentStoreName;
        const host = String(hostname || "").replace(/^www\./, "").toLowerCase();
        if (host === "mercadolivre.com.br" || host.endsWith(".mercadolivre.com.br")) {
          return "Mercado Livre";
        }
        if (host === "amazon.com.br" || host.endsWith(".amazon.com.br")) {
          return "Amazon Brasil";
        }
        if (host === "kabum.com.br" || host.endsWith(".kabum.com.br")) {
          return "KaBuM";
        }
        if (host === "kalunga.com.br" || host.endsWith(".kalunga.com.br")) {
          return "Kalunga";
        }
        if (host === "creativecopias.com.br" || host.endsWith(".creativecopias.com.br")) {
          return "Creative Cópias";
        }
        return currentStoreName;
      }
      function extractPageProductId(pathname, currentStoreName) {
        if (currentStoreName === "KaBuM") {
          return pathname.match(/\/produto\/(\d+)(?:\/|$)/i)?.[1] || "";
        }

        return (
          pathname.match(/\/(?:produto|prod)\/(?:.*?\/)?(\d+)(?:\/)?$/i)?.[1] ||
          pathname.match(/\/(\d+)(?:\/)?$/)?.[1] ||
          ""
        );
      }
      function extractImageProductId(url, currentStoreName) {
        try {
          const parsed = new URL(url);
          if (currentStoreName === "Kalunga") {
            return (
              parsed.pathname.match(/\/fotosdeprodutos\/(\d+)/i)?.[1] || ""
            );
          }
          if (currentStoreName === "KaBuM") {
            return (
              parsed.pathname.match(
                /\/produtos\/fotos\/sync_mirakl\/(\d+)(?:\/|$)/i,
              )?.[1] ||
              parsed.pathname.match(/\/produtos\/fotos\/(\d+)(?:\/|$)/i)?.[1] ||
              ""
            );
          }
        } catch {
          return "";
        }
        return "";
      }
      function isImageFromCurrentProduct(url) {
        const imageProductId = extractImageProductId(url, effectiveStoreName);
        return !productId || !imageProductId || imageProductId === productId;
      }
      function amazonImageIdentity(rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          return (
            parsed.pathname
              .match(/\/images\/I\/([^/._]+)(?:\._[^/.]+_)?\.(?:jpe?g|png|webp|gif)$/i)?.[1]
              ?.toLowerCase() || ""
          );
        } catch {
          return "";
        }
      }
      function addCandidateUrl({
        rawUrl,
        meta = "",
        sourceScore = 0,
        width = 0,
        height = 0,
        img = null,
      }) {
        const url = absolute(rawUrl);
        if (!url) return;
        if (!isImageFromCurrentProduct(url)) {
          rejectedByOtherProductCount += 1;
          return;
        }

        const urlNorm = normalize(url);
        const metaNorm = normalize(meta);
        if (!/^https?:\/\//i.test(url)) return;
        if (!/\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$/i.test(url)) return;
        if (
          /logo|banner|sprite|placeholder|loading|vlibras|bing\.com|google|facebook|tagmanager|doubleclick/i.test(
            `${url} ${meta}`,
          )
        ) {
          return;
        }

        const naturalWidth = img?.naturalWidth || width || 0;
        const naturalHeight = img?.naturalHeight || height || 0;
        let score = sourceScore;
        if (naturalWidth >= 300 && naturalHeight >= 300) score += 4;
        if (naturalWidth >= 90 && naturalHeight >= 90) score += 1;
        if (productId && url.includes(productId)) score += 4;
        if (/galeria|produto|product|img-grande|object-contain/i.test(meta))
          score += 2;
        if (/xlarge|large|fotosdeprodutos|sync_mirakl/i.test(url)) score += 2;
        if (/small|medium|thumb|mini/i.test(url)) score -= 2;
        if (
          effectiveStoreName === "Kalunga" &&
          /img\.kalunga\.com\.br\/fotosdeprodutos/i.test(url)
        )
          score += 4;
        if (
          effectiveStoreName === "KaBuM" &&
          /images\d*\.kabum\.com\.br\/produtos\/fotos/i.test(url)
        )
          score += 4;
        if (
          effectiveStoreName === "Creative Cópias" &&
          /creativecopias\.com\.br\/media\/catalog\/product\/cache/i.test(url)
        ) {
          score += 3;
          if (/product-image-gallery|gallery-image|image-main/i.test(meta)) {
            score += 4;
          }
          if (/\/image\//i.test(url)) score += 2;
          if (/\/image\/(?:\d{1,2}|[12]\d{2})x/i.test(url)) score -= 5;
          if (/\/small_image\/|\/thumbnail\//i.test(url)) score -= 5;
        }
        if (
          effectiveStoreName === "Amazon Brasil" &&
          /m\.media-amazon\.com\/images\/I\//i.test(url)
        ) {
          score += 4;
          if (/imageBlock|imgTagWrapper|landingImage|main-image/i.test(meta)) {
            score += 4;
          }
          if (/\._AC_(?:SX|SL|SY|UX|UY)\d+_/i.test(url)) score += 1;
          if (/\._AC_(?:US|SS|SR)\d+_/i.test(url)) score -= 5;
        }
        if (
          productTokens.some(
            (token) => metaNorm.includes(token) || urlNorm.includes(token),
          )
        )
          score += 1;

        urls.push({
          url,
          score,
          width: naturalWidth,
          height: naturalHeight,
        });
      }
      function mercadoLivreImageIdentity(rawUrl) {
        try {
          const parsed = new URL(rawUrl);
          const filename =
            parsed.pathname.match(/\/([^/]+)\.(?:jpe?g|png|webp|gif)$/i)?.[1] ||
            "";
          return (
            filename
              .match(/(?:^|_)(\d+-ML[A-Z]\d+_\d+)(?:-[A-Z])?$/i)?.[1]
              ?.toLowerCase() || rawUrl
          );
        } catch {
          return rawUrl;
        }
      }
      function isRejectedGenericImageElement(img) {
        const context = clean(
          [
            img.alt,
            img.title,
            img.className,
            img.id,
            img.closest("[class]")?.className,
            img.closest("[id]")?.id,
          ].join(" "),
        );
        return /recomend|recommend|related|relacionad|sponsored|patrocinad|vitrine|suggest|similar|tamb[eé]m|quem viu|also|ads?\b|banner/i.test(
          context,
        );
      }
      function addDynamicAmazonImages(element, meta, sourceScore) {
        try {
          const dynamicImages = JSON.parse(
            element.getAttribute("data-a-dynamic-image") || "{}",
          );
          for (const [rawUrl, dimensions] of Object.entries(dynamicImages)) {
            addCandidateUrl({
              rawUrl,
              meta,
              sourceScore,
              width: Number(dimensions?.[0]) || 0,
              height: Number(dimensions?.[1]) || 0,
            });
          }
        } catch {
          // Ignore malformed Amazon dynamic image payloads.
        }
      }

      const urls = [];
      let rejectedByOtherProductCount = 0;
      if (effectiveStoreName === "Mercado Livre") {
        const root =
          document.querySelector(".ui-pdp-gallery") ||
          document.querySelector("[class*='ui-pdp-gallery']") ||
          document.querySelector(".ui-pdp-image")?.closest("section, div");

        if (!root) {
          return {
            effectiveStoreName,
            candidates: [],
            rejectedByOtherProductCount,
            productGalleryMissing: true,
          };
        }

        const selectors = [
          ".ui-pdp-gallery img",
          "[class*='ui-pdp-gallery'] img",
          ".ui-pdp-image",
          "img[src*='mlstatic.com']",
        ].join(",");

        for (const element of [...root.querySelectorAll(selectors)]) {
          const meta = clean(
            [
              element.getAttribute("alt"),
              element.getAttribute("title"),
              element.className,
              element.id,
              element.closest("[class]")?.className,
            ].join(" "),
          );
          const attrs = [
            element.currentSrc,
            element.src,
            element.getAttribute("src"),
            element.getAttribute("data-src"),
            element.getAttribute("data-zoom"),
            element.getAttribute("data-zoom-image"),
            ...parseSrcset(element.getAttribute("srcset")),
          ];
          for (const rawUrl of attrs) {
            addCandidateUrl({
              rawUrl,
              meta,
              sourceScore: 10,
              img: element.tagName === "IMG" ? element : null,
            });
          }
        }

        const bestByAsset = new Map();
        for (const candidate of urls) {
          const key = mercadoLivreImageIdentity(candidate.url);
          const previous = bestByAsset.get(key);
          if (
            !previous ||
            candidate.score > previous.score ||
            (candidate.score === previous.score &&
              candidate.width * candidate.height >
                previous.width * previous.height)
          ) {
            bestByAsset.set(key, candidate);
          }
        }

        return {
          effectiveStoreName,
          candidates: [...bestByAsset.values()]
            .filter((candidate) => candidate.score >= 10)
            .sort(
              (a, b) =>
                b.score - a.score || b.width * b.height - a.width * a.height,
            )
            .slice(0, 12),
          rejectedByOtherProductCount,
          productGalleryMissing: false,
        };
      }

      if (effectiveStoreName === "Amazon Brasil") {
        const root =
          document.querySelector("#imageBlock_feature_div #imageBlock") ||
          document.querySelector("#imageBlock_feature_div") ||
          document.querySelector("#imageBlock") ||
          document.querySelector("#main-image-container");

        if (!root) {
          return {
            effectiveStoreName,
            candidates: [],
            rejectedByOtherProductCount,
            amazonImageBlockMissing: true,
          };
        }

        const selectors = [
          "#landingImage",
          "[data-a-image-name='landingImage']",
          ".desktop-media-mainView .media-block-image-tag",
          ".desktop-media-mainView [data-a-dynamic-image]",
          "#main-image-container img",
          "#imgTagWrapperId img",
        ].join(",");

        for (const element of [...root.querySelectorAll(selectors)]) {
          const meta = clean(
            [
              element.getAttribute("alt"),
              element.getAttribute("title"),
              element.className,
              element.id,
              element.getAttribute("data-a-image-name"),
              element.closest("[class]")?.className,
            ].join(" "),
          );
          const sourceScore = /landingImage|imgTagWrapperId/i.test(
            `${element.id} ${element.getAttribute("data-a-image-name") || ""}`,
          )
            ? 8
            : 6;

          addCandidateUrl({
            rawUrl: element.currentSrc,
            meta,
            sourceScore,
            img: element.tagName === "IMG" ? element : null,
          });
          addCandidateUrl({
            rawUrl: element.getAttribute("src"),
            meta,
            sourceScore,
            img: element.tagName === "IMG" ? element : null,
          });
          addCandidateUrl({
            rawUrl: element.getAttribute("data-old-hires"),
            meta,
            sourceScore: sourceScore + 2,
          });
          addDynamicAmazonImages(element, meta, sourceScore + 1);
        }

        const bestByAsset = new Map();
        for (const candidate of urls) {
          const key = amazonImageIdentity(candidate.url) || candidate.url;
          const previous = bestByAsset.get(key);
          if (
            !previous ||
            candidate.score > previous.score ||
            (candidate.score === previous.score &&
              candidate.width * candidate.height >
                previous.width * previous.height)
          ) {
            bestByAsset.set(key, candidate);
          }
        }

        return {
          effectiveStoreName,
          candidates: [...bestByAsset.values()]
            .filter((candidate) => candidate.score >= 8)
            .sort(
              (a, b) =>
                b.score - a.score || b.width * b.height - a.width * a.height,
            )
            .slice(0, 12),
          rejectedByOtherProductCount,
          amazonImageBlockMissing: false,
        };
      }

      for (const img of [...document.images]) {
        if (
          effectiveStoreName === "Google" &&
          isRejectedGenericImageElement(img)
        ) {
          continue;
        }
        const attrs = [
          img.currentSrc,
          img.src,
          img.getAttribute("data-src"),
          img.getAttribute("data-original"),
          img.getAttribute("data-zoom-image"),
          img.getAttribute("data-lazy"),
          ...parseSrcset(img.getAttribute("srcset")),
        ];
        const meta = clean(
          [
            img.alt,
            img.title,
            img.className,
            img.id,
            img.closest("[class]")?.className,
          ].join(" "),
        );

        for (const rawUrl of attrs) {
          addCandidateUrl({ rawUrl, img, meta });
        }
      }

      const bestByUrl = new Map();
      for (const candidate of urls) {
        const previous = bestByUrl.get(candidate.url);
        if (!previous || candidate.score > previous.score) {
          bestByUrl.set(candidate.url, candidate);
        }
      }

      return {
        effectiveStoreName,
        candidates: [...bestByUrl.values()]
          .filter((candidate) =>
            effectiveStoreName === "Google"
              ? candidate.score >= 6
              : candidate.score >= 4,
          )
          .sort(
            (a, b) =>
              b.score - a.score || b.width * b.height - a.width * a.height,
          )
          .slice(0, 12),
        rejectedByOtherProductCount,
      };
    },
    { storeName: store.name, productName: product.nome },
  );
}

async function validateImageUrlsInPageDetailed(page, urls, store) {
  const candidates = unique(
    urls
      .map((url) => normalizeUrl(url, page.url()))
      .filter((url) => isPlausibleImageUrl(url, store)),
  ).slice(0, 20);

  const normalizedCount = unique(
    urls.map((url) => normalizeUrl(url, page.url())),
  ).length;

  if (candidates.length === 0) {
    return {
      valid: [],
      normalizedCount,
      plausibleCount: 0,
      rejectedByPlausibilityCount: normalizedCount,
      invalidLoadCount: 0,
      rejectedByDuplicateCount: 0,
    };
  }

  const validated = await page.evaluate(async (imageUrls) => {
    const loadImage = (url) =>
      new Promise((resolve) => {
        const img = new Image();
        const done = (ok) =>
          resolve({
            url,
            ok,
            width: img.naturalWidth || 0,
            height: img.naturalHeight || 0,
          });
        const timer = setTimeout(() => done(false), 6_000);
        img.onload = () => {
          clearTimeout(timer);
          done(img.naturalWidth >= 80 && img.naturalHeight >= 80);
        };
        img.onerror = () => {
          clearTimeout(timer);
          done(false);
        };
        img.referrerPolicy = "no-referrer";
        img.src = url;
      });

    return await Promise.all(imageUrls.map(loadImage));
  }, candidates);

  const valid = validated
    .filter((image) => image.ok)
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .map((image) => image.url);
  const deduped = dedupeImageUrlsByIdentity(valid, store);

  return {
    valid: deduped.valid,
    normalizedCount,
    plausibleCount: candidates.length,
    rejectedByPlausibilityCount: Math.max(
      0,
      normalizedCount - candidates.length,
    ),
    invalidLoadCount: candidates.length - valid.length,
    rejectedByDuplicateCount: deduped.rejectedByDuplicateCount,
  };
}

function dedupeImageUrlsByIdentity(urls, store) {
  const seen = new Set();
  const valid = [];
  let rejectedByDuplicateCount = 0;

  for (const url of urls) {
    const key = imageIdentityKey(url, store);
    if (!key) continue;
    if (seen.has(key)) {
      rejectedByDuplicateCount += 1;
      continue;
    }
    seen.add(key);
    valid.push(url);
  }

  return { valid, rejectedByDuplicateCount };
}

function resolveImageStoreNameFromUrl(store, url) {
  if (store?.name && store.name !== "Google") return store.name;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "mlstatic.com" || host.endsWith(".mlstatic.com")) {
      return "Mercado Livre";
    }
    if (host === "mercadolivre.com.br" || host.endsWith(".mercadolivre.com.br")) {
      return "Mercado Livre";
    }
    if (host === "media-amazon.com" || host.endsWith(".media-amazon.com")) {
      return "Amazon Brasil";
    }
    if (host === "amazon.com.br" || host.endsWith(".amazon.com.br")) {
      return "Amazon Brasil";
    }
    if (host === "kabum.com.br" || host.endsWith(".kabum.com.br")) {
      return "KaBuM";
    }
    if (host === "kalunga.com.br" || host.endsWith(".kalunga.com.br")) {
      return "Kalunga";
    }
    if (host === "creativecopias.com.br" || host.endsWith(".creativecopias.com.br")) {
      return "Creative Cópias";
    }
  } catch {
    // Fall through to the provided store name.
  }
  return store?.name || "";
}

function mercadoLivreImageAssetKey(parsedUrl) {
  const filename =
    parsedUrl.pathname.match(/\/([^/]+)\.(?:jpe?g|png|webp|gif)$/i)?.[1] ||
    "";
  return (
    filename
      .match(/(?:^|_)(\d+-ML[A-Z]\d+_\d+)(?:-[A-Z])?$/i)?.[1]
      ?.toLowerCase() || ""
  );
}

function imageIdentityKey(url, store) {
  try {
    const parsed = new URL(url);
    const storeName = resolveImageStoreNameFromUrl(store, url);
    if (storeName === "Mercado Livre") {
      const assetKey = mercadoLivreImageAssetKey(parsed);
      return assetKey ? `mercadolivre:${assetKey}` : `mercadolivre:${parsed.pathname}`;
    }

    if (storeName === "Creative Cópias") {
      const segments = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => segment.toLowerCase());
      const filename = segments.at(-1) || "";
      const productIndex = segments.lastIndexOf("product");
      if (productIndex !== -1 && filename) {
        return `creativecopias:${filename}`;
      }
      return `creativecopias:${parsed.pathname.toLowerCase()}`;
    }

    if (storeName === "Amazon Brasil") {
      const imageId =
        parsed.pathname
          .match(/\/images\/I\/([^/._]+)(?:\._[^/.]+_)?\.(?:jpe?g|png|webp|gif)$/i)?.[1]
          ?.toLowerCase() || "";
      return imageId ? `amazon:${imageId}` : `amazon:${parsed.pathname}`;
    }

    if (storeName !== "KaBuM") return url;

    const sizeSegments = new Set([
      "xlarge",
      "large",
      "medium",
      "small",
      "thumb",
      "mini",
    ]);
    const pathname = parsed.pathname
      .split("/")
      .filter((segment) => segment && !sizeSegments.has(segment.toLowerCase()))
      .join("/")
      .toLowerCase();
    return `kabum:${pathname}`;
  } catch {
    return url.replace(/[?#].*$/, "");
  }
}

function isPlausibleImageUrl(url, store) {
  if (!url) return false;
  if (!/\.(?:jpe?g|png|webp|gif)(?:[?#].*)?$/i.test(url)) return false;
  if (
    /logo|banner|sprite|placeholder|loading|vlibras|bing\.com|google|facebook|tagmanager|doubleclick/i.test(
      url,
    )
  ) {
    return false;
  }
  const storeName = resolveImageStoreNameFromUrl(store, url);
  if (storeName === "Mercado Livre") {
    try {
      const parsed = new URL(url);
      return (
        /(?:^|\.)mlstatic\.com$/i.test(parsed.hostname) &&
        Boolean(mercadoLivreImageAssetKey(parsed))
      );
    } catch {
      return false;
    }
  }
  if (storeName === "Kalunga") {
    return /img\.kalunga\.com\.br\/fotosdeprodutos/i.test(url);
  }
  if (storeName === "KaBuM") {
    return (
      /images\d*\.kabum\.com\.br\/produtos\/fotos/i.test(url) &&
      isAllowedKabumImageSize(url)
    );
  }
  if (storeName === "Creative Cópias") {
    return (
      /creativecopias\.com\.br\/media\/catalog\/product\/cache/i.test(url) &&
      /\/image\//i.test(url) &&
      !/\/(?:small_image|thumbnail)\//i.test(url) &&
      !/\/image\/(?:\d{1,2}|[12]\d{2})x/i.test(url)
    );
  }
  if (storeName === "Amazon Brasil") {
    return (
      /m\.media-amazon\.com\/images\/I\//i.test(url) &&
      !/\._AC_(?:US|SS|SR)\d+_/i.test(url) &&
      !/\._QL25_/i.test(url)
    );
  }
  return true;
}

function isAllowedKabumImageSize(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());
    const sizeSegments = new Set([
      "xlarge",
      "large",
      "medium",
      "small",
      "thumb",
      "mini",
    ]);
    const sizeSegment = segments.find((segment) => sizeSegments.has(segment));
    return !sizeSegment || sizeSegment === "xlarge";
  } catch {
    return false;
  }
}

async function injectPageAgent(page, bundlePath) {
  await page.addScriptTag({ path: bundlePath });
  await page.waitForFunction(() => Boolean(window.PageAgent), null, {
    timeout: 5_000,
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    window.pageAgent?.dispose?.();
    window.pageAgent = null;
  });
}

function buildSearchQueries(name) {
  const cleanName = cleanText(name);
  const words = cleanName.split(/\s+/).filter(Boolean);
  const stopAt = new Set([
    "reciclado",
    "reciclada",
    "compativel",
    "compatível",
    "original",
    "preto",
    "preta",
    "color",
    "colorido",
    "colorida",
    "azul",
    "magenta",
    "amarelo",
    "amarela",
    "ciano",
    "pequeno",
    "pequena",
  ]);
  const baseWords = [];

  for (const word of words) {
    const normalized = normalizeSearchText(word);
    if (
      baseWords.length >= 2 &&
      (stopAt.has(normalized) || /^\d+(?:,\d+)?\s*ml$/i.test(word))
    ) {
      break;
    }
    if (normalized === "ml") break;
    baseWords.push(word);
  }

  const baseQuery = baseWords.join(" ");
  const codeQuery = buildCodeQuery(words);

  return unique([cleanName, baseQuery, codeQuery].filter(Boolean));
}

function buildCodeQuery(words) {
  const modelIndex = words.findIndex((word) => /\d/.test(word));
  if (modelIndex === -1) return "";

  const start = Math.max(0, modelIndex - 1);
  return words.slice(start, modelIndex + 1).join(" ");
}

function uniqueCandidates(candidates) {
  const byKey = new Map();
  for (const candidate of candidates) {
    const key = candidateUrlKey(candidate.href);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, {
      ...candidate,
      href: normalizeCandidateHref(candidate.href),
      candidateKey: key,
    });
  }
  return [...byKey.values()];
}

function rejectCandidate(rejectedCandidates, candidate, motivo) {
  const key = candidateUrlKey(candidate.href);
  if (
    !key ||
    rejectedCandidates.some((rejected) => rejected.candidateKey === key)
  ) {
    return;
  }

  rejectedCandidates.push({
    ...candidate,
    href: normalizeCandidateHref(candidate.href),
    candidateKey: key,
    motivo,
  });
}

function isRejectedCandidate(candidate, rejectedCandidates) {
  const key = candidateUrlKey(candidate.href);
  return rejectedCandidates.some((rejected) => rejected.candidateKey === key);
}

function candidateUrlKey(value) {
  const href = normalizeCandidateHref(value);
  if (!href) return "";

  try {
    const url = new URL(href);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return href.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function normalizeCandidateHref(value) {
  return String(value || "")
    .split("#")[0]
    .trim();
}

async function inspectSearchPage(page, store, product, query) {
  const snapshot = await page.evaluate(() => {
    const normalize = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    const bodyText = normalize(document.body?.innerText || "");
    const noResult =
      /lamentamos,\s*nenhum produto encontrado|nenhum produto encontrado|nenhum resultado|não encontramos|nao encontramos/i.test(
        bodyText,
      );
    const blocked =
      /captcha|digite os caracteres|insira os caracteres|verifique que voce nao e um robo|verifique que você não é um robô|robot check|automated access/i.test(
        bodyText,
      );
    const anchors = [...document.querySelectorAll("a[href]")];
    const candidates = anchors
      .map((anchor) => {
        const href = anchor.href.split("#")[0];
        const card =
          anchor.closest(
            "article, li, [data-testid], [class*=product], [class*=Product], [class*=item], [class*=card]",
          ) || anchor.parentElement;
        const text = normalize(
          [
            anchor.getAttribute("title"),
            anchor.innerText,
            anchor.textContent,
            card?.innerText,
          ]
            .filter(Boolean)
            .join(" "),
        ).slice(0, 900);
        return { href, text };
      })
      .filter((candidate) => candidate.href && candidate.text);

    return { noResult, blocked, candidates };
  });

  return {
    ...snapshot,
    candidates: snapshot.candidates.filter((candidate) =>
      isStoreProductCandidateHref(candidate.href, store.name),
    ),
    query,
    store: store.name,
    product: product.nome,
  };
}

function isStoreProductCandidateHref(href, storeName) {
  if (storeName === "Kalunga") {
    return /kalunga\.com\.br\/prod\//i.test(href);
  }
  if (storeName === "KaBuM") {
    return /kabum\.com\.br\/produto\//i.test(href);
  }
  if (storeName === "Creative Cópias") {
    return /creativecopias\.com\.br\/[^?#]+\.html(?:[?#].*)?$/i.test(href);
  }
  if (storeName === "Amazon Brasil") {
    return /amazon\.com\.br\/(?:[^?#]+\/)?(?:dp|gp\/product)\/[a-z0-9]{10}(?:[/?#]|$)/i.test(
      href,
    );
  }
  return false;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeProductRuleText(value) {
  return normalizeSearchText(value).replace(/\s+/g, " ").trim();
}

function buildClickSelectionPrompt({
  product,
  store,
  query,
  candidates,
  rejectedCandidates,
  allowSuggestions = false,
}) {
  const row = product.row || {};
  const context = {
    produtoProcurado: {
      sku: product.sku,
      nome: product.nome,
      categoria: product.categoria || row.Categoria || "",
    },
    busca: {
      loja: store.name,
      query,
    },
    candidatosDisponiveis: candidates.map((candidate, index) => ({
      index: index + 1,
      href: candidate.href,
      texto: candidate.text || "",
    })),
    candidatosJaTestados: rejectedCandidates.map((candidate) => ({
      href: candidate.href,
      texto: candidate.text || "",
      motivo: candidate.motivo || "",
    })),
  };

  const suggestionRule = allowSuggestions
    ? '- Se nenhum candidato disponivel parecer minimamente relacionado, retorne lista vazia de candidatos E preencha "sugestoesBusca" com ate 2 termos de busca alternativos que voce acredita que poderiam encontrar este produto nesta loja. Use codigos de modelo, nomes tecnicos, ou variantes do nome do produto.'
    : '- Se nenhum candidato disponivel parecer minimamente relacionado, retorne lista vazia.';

  const suggestionFormat = allowSuggestions
    ? ',\n  "sugestoesBusca": ["termo alternativo 1", "termo alternativo 2"]'
    : '';

  return `
Selecione todos os anuncios relevantes da lista de candidatos disponiveis.

Regras:
- Retorne apenas candidatos que parecam relevantes para a busca atual.
- Ordene do mais provavel para o menos provavel.
- Nao inclua candidatos ja testados.
- Prefira candidatos com mesmo nome completo, modelo, codigo, cor e tipo de produto.
- Nao invente URLs; cada href deve ser exatamente um href de candidatosDisponiveis.
${suggestionRule}
- Responda apenas JSON valido, sem markdown.

Dados:
${JSON.stringify(context, null, 2)}

Formato obrigatorio:
{
  "candidatos": [
    {
      "href": "href exato escolhido",
      "motivo": "explicacao curta"
    }
  ]${suggestionFormat}
}
`.trim();
}

function normalizeClickSelectorResult(
  clickResult,
  candidates,
  rejectedCandidates = [],
) {
  if (
    clickResult &&
    typeof clickResult === "object" &&
    "candidates" in clickResult
  ) {
    return {
      candidates: clickResult.candidates || [],
      suggestedQueries: normalizeSuggestedQueries(clickResult),
    };
  }
  return {
    candidates: normalizeRelevantCandidateSelection(
      clickResult,
      candidates,
      rejectedCandidates,
    ),
    suggestedQueries: normalizeSuggestedQueries(clickResult),
  };
}

function normalizeRelevantCandidateSelection(
  payload,
  candidates,
  rejectedCandidates = [],
) {
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.candidatos)
      ? payload.candidatos
      : payload?.href
        ? [payload]
        : [];
  const selectedCandidates = [];
  const selectedKeys = new Set();

  for (const item of rawItems) {
    const href = normalizeCandidateHref(item?.href);
    if (!href) continue;

    const selected = candidates.find(
      (candidate) => normalizeCandidateHref(candidate.href) === href,
    );
    if (!selected || isRejectedCandidate(selected, rejectedCandidates)) {
      continue;
    }

    const key = candidateUrlKey(selected.href);
    if (!key || selectedKeys.has(key)) continue;

    selectedCandidates.push({
      ...selected,
      href: normalizeCandidateHref(selected.href),
      motivo: cleanText(item?.motivo) || "Selecionado pelo PageAgent.",
    });
    selectedKeys.add(key);
  }

  return selectedCandidates;
}

function normalizeSuggestedQueries(payload) {
  const raw = payload?.suggestedQueries || payload?.sugestoesBusca;
  if (!Array.isArray(raw)) return [];
  return unique(
    raw
      .map((item) => cleanText(item))
      .filter((item) => item.length > 0 && item.length <= 120),
  ).slice(0, MAX_AGENT_SUGGESTED_QUERIES);
}

async function extractStorePageText(page) {
  return page.evaluate(() => {
    const clean = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    const url = window.location.href;
    let contentEl = null;

    if (url.includes("kabum.com.br")) {
      contentEl =
        document.querySelector("#description") ||
        document.querySelector(".productDescription") ||
        document.querySelector("article");
    } else if (url.includes("kalunga.com.br")) {
      contentEl =
        document.querySelector(".product-description") ||
        document.querySelector("#descricao") ||
        document.querySelector(".container-descricao");
    } else if (url.includes("creativecopias.com.br")) {
      contentEl =
        document.querySelector(".product.attribute.description") ||
        document.querySelector("#description");
    } else if (url.includes("amazon.com.br")) {
      const bullets = document.querySelector("#feature-bullets")
        ? document.querySelector("#feature-bullets").innerText
        : "";
      const desc = document.querySelector("#productDescription")
        ? document.querySelector("#productDescription").innerText
        : "";
      if (bullets || desc) return clean(bullets + "\n\n" + desc);
    }

    if (contentEl && clean(contentEl.innerText).length > 50) {
      return clean(contentEl.innerText);
    }

    const selectorsToRemove = [
      "nav",
      "footer",
      "header",
      "aside",
      ".menu",
      "#menu",
      ".similar-products",
      ".related-products",
      ".reviews",
      '[id*="menu"]',
      '[class*="menu"]',
    ];
    
    const elementsToHide = [];
    selectorsToRemove.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        elementsToHide.push({ el, display: el.style.display });
        el.style.display = "none";
      });
    });

    const main =
      document.querySelector("main") ||
      document.querySelector("#main") ||
      document.body;
      
    const text = clean(main.innerText);
    
    elementsToHide.forEach(({ el, display }) => {
      el.style.display = display;
    });
    
    return text;
  });
}

async function generateProductDescription({
  page,
  store,
  product,
  geminiConfig,
  retryConfig = buildGeminiRetryConfig(),
}) {
  const pageText = await extractStorePageText(page);
  if (!pageText || pageText.length < 50) {
    return null;
  }

  return await generateProductMetadataFromText({
    sourceText: pageText,
    product,
    store,
    geminiConfig,
    retryConfig,
  });
}

async function generateProductMetadataFromText({
  sourceText,
  product,
  store = { name: "dados_locais" },
  geminiConfig,
  retryConfig = buildGeminiRetryConfig(),
}) {
  const pageText = cleanText(sourceText);
  if (!pageText || pageText.length < 50) {
    return null;
  }

  const originalName = product.nome || "Produto Sem Nome";
  const prompt = `Atue como um especialista em e-commerce e SEO.
Abaixo estão os dados brutos extraídos de uma página de produto, mas O PRODUTO REAL A SER DESCRITO É: "${originalName}".

Sua tarefa é analisar os dados extraídos e gerar os metadados do produto estritamente em formato JSON.

REGRAS ESTRITAS:
1. Certifique-se de que os dados gerados correspondem perfeitamente a esse nome oficial ("${originalName}"). Use os dados extraídos apenas para enriquecer as características técnicas e benefícios.
2. NUNCA inclua o preço, valor, condições de pagamento ou parcelamento.
3. NUNCA inclua informações sobre garantia ou política de devolução.
4. "descricao": Crie uma descrição vendedora e atraente em Português do Brasil (pt-BR) em texto puro (texto plano). Organize o texto usando apenas quebras de linha. NÃO USE formatação Markdown (como #, **, *, etc).
5. "categoria": Retorne o caminho da categoria ideal para o produto (ex: "Informática > Suprimentos > Cartuchos de Tinta").
6. "tituloSeo": Retorne um título otimizado para SEO com no máximo 60 caracteres.
7. "descricaoSeo": Retorne uma descrição otimizada para SEO com no máximo 160 caracteres.
8. "palavrasChaveSeo": Retorne uma lista de 5 a 10 palavras-chave separadas por vírgula.

DADOS DO PRODUTO:
${pageText.slice(0, 30000)}`;

  try {
    const payload = await callGeminiStructuredJson({
      geminiConfig: {
        ...geminiConfig,
        model: "gemini-3.1-flash-lite-preview",
      },
      systemInstruction: "Você é um especialista em SEO e e-commerce que retorna dados estruturados em JSON.",
      prompt,
      schema: GEMINI_DESCRIPTION_RESPONSE_SCHEMA,
      temperature: 0.1,
      retryConfig,
      product,
      store,
    });
    
    // Ensure all string fields are trimmed and within limits
    if (payload) {
      for (const key of Object.keys(payload)) {
        if (typeof payload[key] === "string") {
          payload[key] = payload[key].trim();
        }
      }
      if (payload.descricaoSeo && payload.descricaoSeo.length > 160) {
        payload.descricaoSeo = payload.descricaoSeo.substring(0, 157).trim() + "...";
      }
      if (payload.tituloSeo && payload.tituloSeo.length > 60) {
        payload.tituloSeo = payload.tituloSeo.substring(0, 57).trim() + "...";
      }
    }
    
    return payload;
  } catch (error) {
    console.error(`[Worker] Erro ao gerar descrição estruturada para ${product.sku}: ${error.message}`);
    return null;
  }
}

async function validateProductMatchWithGemini({
  product,
  store,
  query,
  candidate,
  candidateResult,
  imageAttachments = [],
  geminiConfig,
  timeoutMs = DEFAULT_GEMINI_MATCH_TIMEOUT_MS,
  retryConfig = buildGeminiRetryConfig(),
}) {
  const prompt = buildProductMatchValidationPrompt({
    product,
    store,
    query,
    candidate,
    candidateResult,
  });
  const payload = await withTimeout(
    callGeminiStructuredJson({
      geminiConfig,
      systemInstruction:
        "Voce valida correspondencia entre produtos buscados e anuncios de e-commerce brasileiro.",
      prompt,
      parts: buildProductMatchValidationParts({
        prompt,
        imageAttachments,
      }),
      schema: GEMINI_MATCH_RESPONSE_SCHEMA,
      temperature: 0,
      retryConfig,
      product,
      store,
    }),
    timeoutMs,
    `Timeout Gemini Match de ${timeoutMs / 1000}s`,
  );
  return normalizeMatchValidationPayload(payload);
}

function buildProductMatchValidationPrompt({
  product,
  store,
  query,
  candidate,
  candidateResult,
}) {
  const row = product.row || {};
  const context = {
    produtoProcurado: {
      sku: product.sku,
      nome: product.nome,
      categoria: product.categoria || row.Categoria || "",
    },
    anuncioCandidato: {
      loja: store.name,
      query,
      textoBusca: candidate.text || "",
      hrefBusca: candidate.href || "",
      tituloExtraido: candidateResult.titulo_encontrado || "",
      urlAnuncio: candidateResult.url_anuncio || "",
      descricaoExtraida: candidateResult.descricao || "",
      imagens: candidateResult.imagens || [],
    },
  };

  return `
Valide se o anuncio candidato corresponde ao produto procurado.

Regras:
- Aprove somente se o anuncio for claramente o mesmo item ou uma correspondencia comercial direta do produto procurado.
- Reprove se houver divergencia relevante de nome completo, modelo, codigo, cor, tipo de produto, compatibilidade ou categoria.
- Nao aprove apenas porque ha palavras genericas em comum como cartucho, toner, tinta, reciclado, preto ou colorido.
- As imagens extraidas da pagina candidata foram anexadas a esta mensagem; use-as para confirmar se a pagina mostra o produto correto.
- Use apenas os dados fornecidos abaixo. Nao invente informacoes.

Dados:
${JSON.stringify(context, null, 2)}
`.trim();
}

function buildProductMatchValidationParts({ prompt, imageAttachments }) {
  const parts = [{ text: prompt }];
  for (const image of imageAttachments || []) {
    if (!image?.mimeType || !image?.base64) continue;
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.base64,
      },
    });
  }
  return parts;
}

function normalizeMatchValidationPayload(payload) {
  if (typeof payload?.aprovado !== "boolean") {
    throw new Error("campo aprovado ausente ou invalido");
  }

  const motivo = cleanText(payload.motivo).slice(0, 300);
  return {
    aprovado: payload.aprovado,
    motivo:
      motivo ||
      (payload.aprovado ? "Aprovado pelo Gemini." : "Reprovado pelo Gemini."),
  };
}

async function callGeminiStructuredJson(
  {
    geminiConfig,
    prompt,
    parts = null,
    systemInstruction = "",
    schema,
    temperature = 0,
    retryConfig = buildGeminiRetryConfig(),
    product = null,
    store = null,
  },
) {
  const nativeBaseURL = geminiConfig.nativeBaseURL ||
    deriveNativeGeminiBaseURL(geminiConfig.baseURL || DEFAULT_GEMINI_BASE_URL);
  const body = {
    contents: [
      {
        role: "user",
        parts: parts || [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
  };
  if (systemInstruction) {
    body.systemInstruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const result = await fetchGeminiWithRetry(
    {
      url: `${nativeBaseURL}/models/${encodeURIComponent(geminiConfig.model)}:generateContent`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      geminiConfig,
      body: JSON.stringify(body),
    },
    retryConfig,
    { product, store },
  );
  if (!result.ok) {
    const preview = result.body.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(`HTTP ${result.status} ${result.statusText}: ${preview}`);
  }

  let json;
  try {
    json = JSON.parse(result.body);
  } catch (error) {
    throw new Error(`Resposta Gemini invalida: ${error.message}`);
  }

  const content = extractGeminiNativeText(json);
  if (!content) {
    throw new Error("Resposta Gemini sem conteudo");
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`JSON Gemini invalido: ${error.message}`);
  }
}

function extractGeminiNativeText(response) {
  return (response?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("")
    .trim();
}

function parseAgentPayload(rawData) {
  const text = String(rawData || "").trim();
  if (!text) throw new Error("PageAgent retornou resposta vazia.");

  const withoutFence = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const jsonText = extractJsonObject(withoutFence);
  return JSON.parse(jsonText);
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Resposta nao contem JSON valido: ${text.slice(0, 120)}`);
  }
  return text.slice(start, end + 1);
}

function buildStoreResult({
  product,
  store,
  status,
  titulo = "",
  url = "",
  imagens = [],
  descricao = "",
  errorType = null,
  matchValidation = null,
  diagnostico = null,
}) {
  return {
    sku: product.sku,
    nome_buscado: product.nome,
    loja: store.name,
    titulo_encontrado: titulo,
    url_anuncio: url,
    imagens,
    descricao,
    status,
    imageCount: imagens.length,
    errorType,
    matchValidation,
    diagnostico,
  };
}

async function saveProgress(state, writeResultFile) {
  const checkpoint = {
    version: CHECKPOINT_VERSION,
    processedSkus: [...state.processedSkus],
    products: state.results,
    technicalFailures: state.technicalFailures,
    total: state.total,
    completed: state.processedSkus.size,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(CHECKPOINT_FILE, checkpoint);

  if (writeResultFile) {
    await writeResults(state.inputFile, state.results);
  }
}

async function writeJsonAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function writeResults(inputFile, resultsBySku) {
  const workbook = new ExcelJS.Workbook();
  const sourceWorkbook = new ExcelJS.Workbook();
  await sourceWorkbook.xlsx.readFile(inputFile);
  const sourceWorksheet = sourceWorkbook.worksheets[0];
  const sourceHeaders = sourceWorksheet.getRow(1).values.slice(1);
  const columnByHeader = buildColumnIndex(sourceHeaders);

  workbook.creator = "products-page-agent";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(sourceWorksheet.name);
  worksheet.views = sourceWorksheet.views;
  worksheet.autoFilter = sourceWorksheet.autoFilter;
  worksheet.properties = { ...sourceWorksheet.properties };
  worksheet.pageSetup = { ...sourceWorksheet.pageSetup };
  worksheet.columns = sourceHeaders.map((header, index) => ({
    header,
    key: `col_${index + 1}`,
    width: sourceWorksheet.getColumn(index + 1).width,
    hidden: sourceWorksheet.getColumn(index + 1).hidden,
    style: cloneStyle(sourceWorksheet.getColumn(index + 1).style),
  }));
  copyRowFormat(sourceWorksheet.getRow(1), worksheet.getRow(1));

  for (
    let rowNumber = 2;
    rowNumber <= sourceWorksheet.rowCount;
    rowNumber += 1
  ) {
    const sourceRow = sourceWorksheet.getRow(rowNumber);
    const values = [];
    for (let column = 1; column <= sourceHeaders.length; column += 1) {
      values.push(sourceRow.getCell(column).value ?? "");
    }

    const sku = String(
      sourceRow.getCell(columnByHeader.get("Código (SKU)")).value ?? "",
    ).trim();
    const result = resultsBySku[sku];

    // Limpar as imagens originais para todos os produtos
    for (let index = 0; index < IMAGE_COLUMNS.length; index += 1) {
      const column = columnByHeader.get(IMAGE_COLUMNS[index]);
      if (column) values[column - 1] = "";
    }

    if (isCheckpointProductComplete(result)) {
      for (let index = 0; index < IMAGE_COLUMNS.length; index += 1) {
        const column = columnByHeader.get(IMAGE_COLUMNS[index]);
        if (column) values[column - 1] = result.imagens[index] || "";
      }

      const md = result.metadadosGerados || {};
      
      const descFinal = md.descricao || result.descricaoGerada;
      if (descFinal) {
        const col = columnByHeader.get(DESCRIPTION_COLUMN);
        if (col) values[col - 1] = descFinal;
      }
      if (md.categoria) {
        const col = columnByHeader.get(CATEGORIA_COLUMN);
        if (col) values[col - 1] = md.categoria;
      }
      if (md.tituloSeo) {
        const col = columnByHeader.get(TITULO_SEO_COLUMN);
        if (col) values[col - 1] = md.tituloSeo;
      }
      if (md.descricaoSeo) {
        const col = columnByHeader.get(DESCRICAO_SEO_COLUMN);
        if (col) values[col - 1] = md.descricaoSeo;
      }
      if (md.palavrasChaveSeo) {
        const col = columnByHeader.get(PALAVRAS_CHAVE_SEO_COLUMN);
        if (col) values[col - 1] = md.palavrasChaveSeo;
      }
    }

    const outputRow = worksheet.addRow(values);
    copyRowFormat(sourceRow, outputRow);
  }

  worksheet.getColumn(columnByHeader.get(DESCRIPTION_COLUMN)).alignment = {
    ...worksheet.getColumn(columnByHeader.get(DESCRIPTION_COLUMN)).alignment,
    wrapText: true,
    vertical: "top",
  };

  const tempPath = `${OUTPUT_FILE}.tmp`;
  await workbook.xlsx.writeFile(tempPath);
  await fs.rename(tempPath, OUTPUT_FILE);
}

function buildColumnIndex(headers) {
  return new Map(headers.map((header, index) => [String(header), index + 1]));
}

function copyRowFormat(sourceRow, targetRow) {
  targetRow.height = sourceRow.height;
  targetRow.hidden = sourceRow.hidden;
  targetRow.outlineLevel = sourceRow.outlineLevel;
  targetRow.eachCell({ includeEmpty: true }, (cell, column) => {
    const sourceCell = sourceRow.getCell(column);
    cell.style = cloneStyle(sourceCell.style);
    cell.numFmt = sourceCell.numFmt;
    cell.alignment = cloneStyle(sourceCell.alignment);
    cell.font = cloneStyle(sourceCell.font);
    cell.fill = cloneStyle(sourceCell.fill);
    cell.border = cloneStyle(sourceCell.border);
    cell.protection = cloneStyle(sourceCell.protection);
  });
}

function cloneStyle(style) {
  return style ? JSON.parse(JSON.stringify(style)) : undefined;
}

function formatProgress(completed, total) {
  const pct = total === 0 ? 0 : (completed / total) * 100;
  return `${completed}/${total} (${pct.toFixed(1)}%)`;
}

function formatEta(startedAt, completedThisRun, remaining) {
  if (completedThisRun <= 0 || remaining <= 0) return "0min";
  const elapsedMs = Date.now() - startedAt;
  const avgMs = elapsedMs / completedThisRun;
  return formatDuration(avgMs * remaining);
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}min`;
  return `${hours}h ${minutes}min`;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timeoutId),
  );
}

function withOptionalTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return withTimeout(promise, timeoutMs, message);
}

function isTimeoutLikeError(error) {
  return (
    error?.name === "TimeoutError" ||
    /timeout/i.test(error?.message || "")
  );
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(value, baseUrl) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (raw.startsWith("//")) return `https:${raw}`;
    return new URL(raw, baseUrl).toString();
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  CATEGORIA_COLUMN,
  CHECKPOINT_FILE,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_INPUT_FILE,
  DESCRICAO_SEO_COLUMN,
  DESCRIPTION_COLUMN,
  FIXED_RECYCLED_IMAGE_SOURCE,
  FIXED_RECYCLED_IMAGES,
  IMAGE_COLUMNS,
  PALAVRAS_CHAVE_SEO_COLUMN,
  TITULO_SEO_COLUMN,
  buildGeminiApiKeys,
  buildGeminiConfigs,
  buildGeminiRetryConfig,
  buildSearchQueries,
  buildTimeoutConfig,
  buildProductMatchValidationParts,
  createSerialProgressSaver,
  createGeminiKeyRotator,
  createBrowserContext,
  deriveNativeGeminiBaseURL,
  extractDeterministicProductData,
  extractValidatedProductImagesWithDiagnostics,
  findFixedRecycledImageRule,
  generateProductDescription,
  generateProductMetadataFromText,
  isCheckpointProductComplete,
  imageIdentityKey,
  isPlausibleImageUrl,
  isStoreProductCandidateHref,
  loadEnv,
  processProduct,
  readCheckpoint,
  readProducts,
  resolvePageAgentBundlePath,
  runProductWorkers,
  searchStoreWithPage,
  selectRelevantCandidatesWithPageAgent,
  validateProductMatchWithGemini,
  writeJsonAtomic,
  writeResults,
};
