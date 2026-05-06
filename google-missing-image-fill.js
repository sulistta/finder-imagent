import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import ExcelJS from "exceljs";

import {
  CATEGORIA_COLUMN,
  DESCRICAO_SEO_COLUMN,
  DESCRIPTION_COLUMN,
  IMAGE_COLUMNS,
  PALAVRAS_CHAVE_SEO_COLUMN,
  TITULO_SEO_COLUMN,
  buildGeminiApiKeys,
  buildGeminiConfigs,
  buildGeminiRetryConfig,
  buildSearchQueries,
  buildTimeoutConfig,
  createBrowserContext,
  extractDeterministicProductData,
  extractValidatedProductImagesWithDiagnostics,
  generateProductDescription,
  isCheckpointProductComplete,
  loadEnv,
  readProducts,
  selectRelevantCandidatesWithGemini,
  validateProductMatchWithGemini,
  writeJsonAtomic,
} from "./main.js";

const DEFAULT_INPUT_FILE = "resultado.xlsx";
const DEFAULT_OUTPUT_FILE = "resultado-fill-verified-google.xlsx";
const DEFAULT_CHECKPOINT_FILE = "google-missing-image-checkpoint.json";
const CHECKPOINT_VERSION = 2;
const DEFAULT_GOOGLE_MAX_QUERIES = 6;
const DEFAULT_GOOGLE_MAX_CANDIDATES_PER_QUERY = 5;
const GOOGLE_TARGET_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const GOOGLE_STORE = {
  name: "Google",
  buildSearchUrl: (query) =>
    `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=pt-BR&gl=br&num=10&pws=0`,
};

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

async function main({
  inputFile = null,
  outputFile = null,
  checkpointFile = null,
} = {}) {
  loadEnv();

  const args = new Set(process.argv.slice(2));
  const resume = args.has("--resume");
  const resolvedInputFile =
    inputFile || process.env.GOOGLE_MISSING_INPUT_FILE || DEFAULT_INPUT_FILE;
  const resolvedOutputFile =
    outputFile || process.env.GOOGLE_MISSING_OUTPUT_FILE || DEFAULT_OUTPUT_FILE;
  const resolvedCheckpointFile =
    checkpointFile ||
    process.env.GOOGLE_MISSING_CHECKPOINT_FILE ||
    DEFAULT_CHECKPOINT_FILE;
  const apiKeys = buildGeminiApiKeys();
  const { clickConfig, matchConfig } = buildGeminiConfigs(apiKeys);
  const timeouts = buildTimeoutConfig();
  const geminiRetryConfig = buildGeminiRetryConfig();
  const limit = readPositiveInt(process.env.GOOGLE_MISSING_LIMIT, 0);

  if (apiKeys.length === 0) {
    throw new Error(
      "GEMINI_API_KEY nao configurada. Crie um .env com base em .env.example.",
    );
  }
  if (!existsSync(resolvedInputFile)) {
    throw new Error(`Planilha de entrada nao encontrada: ${resolvedInputFile}`);
  }
  if (!resume && existsSync(resolvedCheckpointFile)) {
    throw new Error(
      `Checkpoint existente encontrado. Use "npm run resume-google-missing" ou remova ${resolvedCheckpointFile} para reiniciar.`,
    );
  }

  const allProducts = readProducts(resolvedInputFile);
  const targets = selectGoogleImageTargets(allProducts);
  const selectedTargets = limit > 0 ? targets.slice(0, limit) : targets;
  if (selectedTargets.length === 0) {
    console.log(
      `Nenhum produto com menos de ${GOOGLE_TARGET_IMAGE_COUNT} imagens encontrado em ${resolvedInputFile}.`,
    );
    return;
  }

  const checkpoint = resume
    ? await readGoogleCheckpoint(resolvedCheckpointFile)
    : emptyGoogleCheckpoint();
  const normalized = normalizeGoogleCheckpoint(checkpoint);
  const pendingProducts = selectedTargets.filter(
    (product) => !normalized.processedSkus.has(product.sku),
  );
  const state = {
    inputFile: resolvedInputFile,
    outputFile: resolvedOutputFile,
    checkpointFile: resolvedCheckpointFile,
    total: selectedTargets.length,
    completedThisRun: 0,
    processedSkus: normalized.processedSkus,
    results: normalized.results,
    technicalFailures: normalized.technicalFailures,
  };

  if (pendingProducts.length === 0) {
    await writeGoogleResults(resolvedInputFile, resolvedOutputFile, state.results);
    console.log(
      `Todos os ${selectedTargets.length} produto(s) com menos de ${GOOGLE_TARGET_IMAGE_COUNT} imagens ja foram processados. ${resolvedOutputFile} atualizado.`,
    );
    return;
  }

  console.log(
    `Google missing fill: ${pendingProducts.length} pendente(s) de ${selectedTargets.length} produto(s) com menos de ${GOOGLE_TARGET_IMAGE_COUNT} imagens`,
  );

  const browser = await chromium.launch({ headless: false });
  const startedAt = Date.now();
  const captchaPrompt = createCaptchaPrompt();
  let context = null;

  try {
    context = await createBrowserContext(browser);
    await runGoogleProducts({
      context,
      products: pendingProducts,
      state,
      startedAt,
      geminiConfig: clickConfig,
      matchGeminiConfig: matchConfig,
      timeouts,
      geminiRetryConfig,
      captchaPrompt,
    });

    await saveGoogleProgress(state, true);
    console.log(`Concluido. Resultado final salvo em ${resolvedOutputFile}.`);
  } finally {
    captchaPrompt.close();
    await context?.close();
    await browser.close();
  }
}

async function runGoogleProducts({
  context,
  products,
  state,
  startedAt,
  geminiConfig,
  matchGeminiConfig,
  timeouts,
  geminiRetryConfig,
  captchaPrompt,
}) {
  const page = await context.newPage();
  try {
    for (const product of products) {
      await processGoogleProduct({
        page,
        product,
        state,
        startedAt,
        geminiConfig,
        matchGeminiConfig,
        timeouts,
        geminiRetryConfig,
        captchaPrompt,
      });
    }
  } finally {
    await page.close().catch(() => {});
  }
}

async function processGoogleProduct({
  page,
  product,
  state,
  startedAt,
  geminiConfig,
  matchGeminiConfig,
  timeouts,
  geminiRetryConfig,
  captchaPrompt,
}) {
  const progress = formatProgress(state.processedSkus.size, state.total);
  console.log(
    `[Google] Buscando SKU ${product.sku} "${product.nome}" | Progresso: ${progress}`,
  );

  const result = await searchGoogleProduct({
    page,
    product,
    geminiConfig,
    matchGeminiConfig,
    timeouts,
    geminiRetryConfig,
    captchaPrompt,
  });

  state.completedThisRun += 1;

  if (!isGoogleResultComplete(result)) {
    state.results[product.sku] = result;
    state.technicalFailures[product.sku] = {
      erro: result.erro || result.status || "pendente",
      causa: result.causa || "",
      at: result.updatedAt,
    };
    console.log(
      `[Google] SKU ${product.sku} pendente: ${result.erro || result.status}`,
    );
    await saveGoogleProgress(state, false);
    return;
  }

  delete state.technicalFailures[product.sku];
  state.results[product.sku] = result;
  state.processedSkus.add(product.sku);

  console.log(
    `[Google] SKU ${product.sku} sucesso: ${result.imagens.length} imagem(ns)`,
  );
  await saveGoogleProgress(state, state.completedThisRun % 10 === 0);
  console.log(
    `Tempo estimado restante: ${formatEta(startedAt, state.completedThisRun, state.total - state.processedSkus.size)}`,
  );
}

async function searchGoogleProduct({
  page,
  product,
  geminiConfig,
  matchGeminiConfig,
  timeouts,
  geminiRetryConfig,
  captchaPrompt,
}) {
  page.setDefaultTimeout(timeouts.navigationTimeoutMs);
  page.setDefaultNavigationTimeout(timeouts.navigationTimeoutMs);

  const maxQueries = readPositiveInt(
    process.env.GOOGLE_MAX_QUERIES,
    DEFAULT_GOOGLE_MAX_QUERIES,
  );
  const queries = buildSearchQueries(product.nome).slice(0, maxQueries);
  const maxCandidates = readPositiveInt(
    process.env.GOOGLE_MAX_CANDIDATES_PER_QUERY,
    DEFAULT_GOOGLE_MAX_CANDIDATES_PER_QUERY,
  );
  const rejectedCandidates = [];
  const diagnostics = { causa: "", queries: [], rejeicoes: [] };
  let suggestionsCollected = false;

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    const isFirstQuery = queryIndex === 0;
    const searchUrl = GOOGLE_STORE.buildSearchUrl(query);
    const queryDiagnostic = {
      query,
      searchUrl,
      candidatesFound: 0,
      candidatesAvailable: 0,
      relevantCandidatesSelected: 0,
      event: "",
      erroTecnico: "",
    };
    diagnostics.queries.push(queryDiagnostic);

    try {
      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeouts.navigationTimeoutMs,
      });
      await page.waitForTimeout(timeouts.pageSettleMs);
      await dismissGoogleConsent(page);
      await waitForCaptchaIfNeeded({ page, product, query, captchaPrompt });
    } catch (error) {
      queryDiagnostic.event = "google_navigation_error";
      queryDiagnostic.erroTecnico = error.message;
      continue;
    }

    const candidates = (await collectGoogleCandidates(page))
      .filter((candidate) => !isRejectedCandidate(candidate, rejectedCandidates))
      .slice(0, maxCandidates);
    queryDiagnostic.candidatesFound = candidates.length;

    if (candidates.length === 0) {
      queryDiagnostic.event = "sem_candidatos_google";
      continue;
    }
    queryDiagnostic.candidatesAvailable = candidates.length;

    let relevantCandidates = [];
    let suggestedQueries = [];
    try {
      const clickResult = await selectRelevantCandidatesWithGemini({
        page,
        store: GOOGLE_STORE,
        product,
        query,
        candidates,
        rejectedCandidates,
        geminiConfig,
        timeouts,
        geminiRetryConfig,
        allowSuggestions: isFirstQuery && !suggestionsCollected,
      });
      relevantCandidates = clickResult.candidates || [];
      suggestedQueries = clickResult.suggestedQueries || [];
    } catch (error) {
      queryDiagnostic.event = "gemini_candidate_selection_erro";
      queryDiagnostic.erroTecnico = error.message;
      continue;
    }

    queryDiagnostic.relevantCandidatesSelected = relevantCandidates.length;
    if (relevantCandidates.length === 0) {
      queryDiagnostic.event = "gemini_sem_escolha";
      if (isFirstQuery && !suggestionsCollected && suggestedQueries.length > 0) {
        suggestionsCollected = true;
        for (const suggested of suggestedQueries) {
          if (queries.length >= maxQueries) break;
          if (!queries.includes(suggested)) {
            queries.push(suggested);
          }
        }
        queryDiagnostic.sugestoesBusca = suggestedQueries;
      }
      continue;
    }

    for (const candidate of relevantCandidates) {
      try {
        await page.goto(candidate.href, {
          waitUntil: "domcontentloaded",
          timeout: timeouts.navigationTimeoutMs,
        });
        await page.waitForTimeout(timeouts.pageSettleMs);
        await waitForCaptchaIfNeeded({ page, product, query, captchaPrompt });

        const imageExtraction = await extractValidatedProductImagesWithDiagnostics(
          page,
          GOOGLE_STORE,
          product,
        );
        const candidateResult = await extractDeterministicProductData({
          page,
          store: GOOGLE_STORE,
          product,
          validatedImages: imageExtraction.images,
        });

        if (!hasUsableCandidateData(candidateResult)) {
          rejectCandidate(rejectedCandidates, candidate, "dados insuficientes");
          diagnostics.rejeicoes.push({
            query,
            href: candidate.href,
            texto: candidate.text || "",
            reason: "dados_insuficientes",
            imagens: candidateResult?.imagens?.length || 0,
            diagnosticoImagem: imageExtraction.diagnostico,
          });
          continue;
        }

        const candidateImages = candidateResult.imagens.slice(0, IMAGE_COLUMNS.length);
        if (!hasGoogleImageUpgrade(product, candidateImages.length)) {
          const motivo = `Anuncio tem ${candidateImages.length} imagem(ns) valida(s), mas o produto ja tem ${product.currentImageCount}.`;
          rejectCandidate(rejectedCandidates, candidate, motivo);
          diagnostics.rejeicoes.push({
            query,
            href: candidate.href,
            texto: candidate.text || "",
            reason: "imagens_insuficientes_para_melhorar",
            motivo,
            titulo: candidateResult.titulo_encontrado,
            imagens: candidateImages.length,
            imagensAtuais: product.currentImageCount,
            diagnosticoImagem: imageExtraction.diagnostico,
          });
          console.log(`[Google Images] ${product.sku} sem upgrade: ${motivo}`);
          continue;
        }

        const imageAttachments = await downloadGeminiImageAttachments(candidateImages);
        const approvedImages = imageAttachments.map((image) => image.url).filter(Boolean);
        if (!hasGoogleImageUpgrade(product, approvedImages.length)) {
          const motivo = `Anuncio teve ${approvedImages.length} imagem(ns) baixada(s) para anexar ao Gemini, mas o produto ja tem ${product.currentImageCount}.`;
          rejectCandidate(rejectedCandidates, candidate, motivo);
          diagnostics.rejeicoes.push({
            query,
            href: candidate.href,
            texto: candidate.text || "",
            reason: "imagens_anexadas_insuficientes_para_melhorar",
            motivo,
            titulo: candidateResult.titulo_encontrado,
            imagens: candidateImages.length,
            anexos: imageAttachments.length,
            imagensAtuais: product.currentImageCount,
          });
          console.log(`[Google Images] ${product.sku} sem anexos: ${motivo}`);
          continue;
        }

        const candidateResultForValidation = {
          ...candidateResult,
          imagens: approvedImages,
        };
        const matchValidation = await validateProductMatchWithGemini({
          product,
          store: GOOGLE_STORE,
          query,
          candidate,
          candidateResult: candidateResultForValidation,
          imageAttachments,
          geminiConfig: matchGeminiConfig,
          timeoutMs: timeouts.geminiMatchTimeoutMs,
          retryConfig: geminiRetryConfig,
        });

        if (!matchValidation.aprovado) {
          rejectCandidate(rejectedCandidates, candidate, matchValidation.motivo);
          diagnostics.rejeicoes.push({
            query,
            href: candidate.href,
            texto: candidate.text || "",
            reason: "gemini_reprovou",
            motivo: matchValidation.motivo,
            titulo: candidateResultForValidation.titulo_encontrado,
            imagens: candidateResultForValidation.imagens.length,
          });
          console.log(
            `[Google Match] ${product.sku} reprovado: ${matchValidation.motivo}`,
          );
          continue;
        }

        let metadadosGerados = null;
        if (hasMissingMetadata(product)) {
          try {
            metadadosGerados = await generateProductDescription({
              page,
              store: GOOGLE_STORE,
              product,
              geminiConfig: matchGeminiConfig,
              retryConfig: geminiRetryConfig,
            });
          } catch (error) {
            console.warn(
              `[Google Metadata] ${product.sku} erro ao gerar: ${error.message}`,
            );
          }
        }

        return {
          sku: product.sku,
          status: "sucesso",
          imagens: approvedImages.slice(0, IMAGE_COLUMNS.length),
          metadadosGerados,
          descricaoGerada: metadadosGerados?.descricao || "",
          lojas: [
            {
              loja: GOOGLE_STORE.name,
              status: "sucesso",
              imagens: approvedImages.length,
              titulo: candidateResultForValidation.titulo_encontrado,
              url: candidateResultForValidation.url_anuncio,
              erro: "",
              validacao: matchValidation,
              diagnostico: {
                ...diagnostics,
                imagem: imageExtraction.diagnostico,
                anexosGemini: imageAttachments.length,
              },
            },
          ],
          updatedAt: new Date().toISOString(),
        };
      } catch (error) {
        rejectCandidate(rejectedCandidates, candidate, error.message);
        diagnostics.rejeicoes.push({
          query,
          href: candidate.href,
          texto: candidate.text || "",
          reason: "erro_tecnico_candidato",
          motivo: error.message,
        });
      }
    }

    if (!queryDiagnostic.event) queryDiagnostic.event = "candidatos_rejeitados";
  }

  diagnostics.causa = classifyGoogleFailure(diagnostics);
  return {
    sku: product.sku,
    status: "pendente",
    erro: "Nenhum anuncio aprovado com mais imagens validas do que a planilha encontrado via Google.",
    causa: diagnostics.causa,
    imagens: [],
    lojas: [
      {
        loja: GOOGLE_STORE.name,
        status: "nao encontrado",
        imagens: 0,
        titulo: "",
        url: "",
        erro: diagnostics.causa,
        validacao: null,
        diagnostico: diagnostics,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
}

async function collectGoogleCandidates(page) {
  const rawCandidates = await page.evaluate(() => {
    const clean = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    const anchors = [...document.querySelectorAll("a[href]")];
    return anchors
      .map((anchor) => {
        const href = anchor.href;
        const card =
          anchor.closest("div.g, div[data-sokoban-container], article") ||
          anchor.parentElement;
        const text = clean(
          [
            anchor.getAttribute("aria-label"),
            anchor.getAttribute("title"),
            anchor.innerText,
            card?.innerText,
          ]
            .filter(Boolean)
            .join(" "),
        ).slice(0, 1000);
        return { href, text };
      })
      .filter((candidate) => candidate.href && candidate.text);
  });

  const byKey = new Map();
  for (const candidate of rawCandidates) {
    const href = normalizeGoogleResultHref(candidate.href);
    if (!href || shouldIgnoreGoogleResultHref(href)) continue;
    const key = candidateUrlKey(href);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { href, text: candidate.text, candidateKey: key });
  }
  return [...byKey.values()];
}

function normalizeGoogleResultHref(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    if (parsed.hostname.endsWith("google.com") && parsed.pathname === "/url") {
      return parsed.searchParams.get("q") || "";
    }
    if (
      parsed.hostname.endsWith("google.com") &&
      parsed.pathname.startsWith("/interstitial")
    ) {
      return parsed.searchParams.get("url") || "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function shouldIgnoreGoogleResultHref(href) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    return (
      host === "google.com" ||
      host.endsWith(".google.com") ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "facebook.com" ||
      host.endsWith(".facebook.com") ||
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "pinterest.com" ||
      host.endsWith(".pinterest.com") ||
      host === "tiktok.com" ||
      host.endsWith(".tiktok.com") ||
      host === "kabum.com.br" ||
      host.endsWith(".kabum.com.br") ||
      host === "kalunga.com.br" ||
      host.endsWith(".kalunga.com.br") ||
      host === "creativecopias.com.br" ||
      host.endsWith(".creativecopias.com.br") ||
      host === "amazon.com.br" ||
      host.endsWith(".amazon.com.br") ||
      host === "cartuchofacil.com.br" ||
      host.endsWith(".cartuchofacil.com.br") ||
      host === "leroymerlin.com.br" ||
      host.endsWith(".leroymerlin.com.br") ||
      host === "weaap.com.br" ||
      host.endsWith(".weaap.com.br") ||
      host === "printloja.com.br" ||
      host.endsWith(".printloja.com.br") ||
      host === "aliexpress.com" ||
      host.endsWith(".aliexpress.com") ||
      host === "aliexpress.us" ||
      host.endsWith(".aliexpress.us") ||
      host === "aliexpress.com.br" ||
      host.endsWith(".aliexpress.com.br") ||
      host === "shopee.com.br" ||
      host.endsWith(".shopee.com.br") ||
      host === "shopee.com" ||
      host.endsWith(".shopee.com")
    );
  } catch {
    return true;
  }
}

async function dismissGoogleConsent(page) {
  await page
    .evaluate(() => {
      const labels = [/aceitar tudo/i, /concordo/i, /accept all/i, /i agree/i];
      for (const button of [...document.querySelectorAll("button")]) {
        const text = button.innerText || button.textContent || "";
        if (labels.some((pattern) => pattern.test(text))) {
          button.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
  await page.waitForTimeout(500).catch(() => {});
}

async function waitForCaptchaIfNeeded({ page, product, query, captchaPrompt }) {
  while (await isCaptchaPage(page)) {
    await captchaPrompt.wait({
      sku: product.sku,
      query,
      url: page.url(),
    });
    await page.waitForTimeout(1000);
  }
}

async function isCaptchaPage(page) {
  return await page
    .evaluate(() => {
      const text = String(document.body?.innerText || "");
      const title = String(document.title || "");
      const host = location.hostname.replace(/^www\./, "").toLowerCase();
      const pageText = `${title} ${text}`;
      const isGoogle = host === "google.com" || host.endsWith(".google.com");

      if (
        isGoogle &&
        /captcha|recaptcha|hcaptcha|nao sou um robo|não sou um robô|trafego incomum|tráfego incomum|unusual traffic|verify you are human|robot check|automated access|nossos sistemas detectaram/i.test(
          pageText,
        )
      ) {
        return true;
      }

      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0 ||
          element.getAttribute("aria-hidden") === "true"
        ) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width >= 40 && rect.height >= 30;
      };

      const visibleChallenge = [
        ...document.querySelectorAll(
          "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .g-recaptcha, .h-captcha, [id*='captcha' i], [class*='captcha' i]",
        ),
      ].some((element) => {
        if (!isVisible(element)) return false;
        const src = element.getAttribute("src") || "";
        const label = [
          element.getAttribute("title"),
          element.getAttribute("aria-label"),
          element.innerText,
          src,
        ].join(" ");
        return /challenge|captcha|recaptcha|hcaptcha|nao sou um robo|não sou um robô|verify/i.test(
          label,
        );
      });

      return (
        visibleChallenge &&
        /captcha|recaptcha|hcaptcha|nao sou um robo|não sou um robô|verify you are human|robot check/i.test(
          pageText,
        )
      );
    })
    .catch(() => false);
}

function createCaptchaPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let chain = Promise.resolve();

  return {
    wait({ sku, query, url }) {
      const run = chain.then(async () => {
        console.log(
          `CAPTCHA detectado no SKU ${sku} | query="${query}" | ${url}`,
        );
        await rl.question(
          "Resolva o CAPTCHA na janela do navegador e pressione Enter para continuar...",
        );
      });
      chain = run.catch(() => {});
      return run;
    },
    close() {
      rl.close();
    },
  };
}

function selectProductsWithoutImages(products) {
  return products.filter((product) =>
    IMAGE_COLUMNS.every((column) => !cellToText(product.row?.[column]).trim()),
  );
}

function selectGoogleImageTargets(products) {
  return products
    .map((product) => {
      const currentImages = getProductImages(product);
      return {
        ...product,
        currentImages,
        currentImageCount: currentImages.length,
      };
    })
    .filter((product) => product.currentImageCount < GOOGLE_TARGET_IMAGE_COUNT);
}

function getProductImages(product) {
  return IMAGE_COLUMNS.map((column) => cellToText(product.row?.[column]).trim()).filter(
    Boolean,
  );
}

function hasGoogleImageUpgrade(product, imageCount) {
  return Number(imageCount) > Number(product.currentImageCount || 0);
}

function hasMissingMetadata(product) {
  const row = product.row || {};
  return [
    DESCRIPTION_COLUMN,
    CATEGORIA_COLUMN,
    TITULO_SEO_COLUMN,
    DESCRICAO_SEO_COLUMN,
    PALAVRAS_CHAVE_SEO_COLUMN,
  ].some((column) => !cellToText(row[column]).trim());
}

async function downloadGeminiImageAttachments(urls, fetchImpl = fetch) {
  const attachments = [];
  for (const url of urls) {
    try {
      attachments.push(await downloadGeminiImageAttachment(url, fetchImpl));
    } catch (error) {
      console.warn(`[Google Images] imagem ignorada no anexo: ${url} | ${error.message}`);
    }
  }
  return attachments;
}

async function downloadGeminiImageAttachment(url, fetchImpl = fetch) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Imagem HTTP ${response.status} ${response.statusText}`);
  }

  const mimeType = normalizeImageMimeType(
    response.headers?.get?.("content-type") || guessMimeTypeFromUrl(url),
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error("Imagem vazia.");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Imagem maior que ${MAX_IMAGE_BYTES} bytes.`);
  }

  return {
    url,
    mimeType,
    base64: buffer.toString("base64"),
  };
}

function normalizeImageMimeType(contentType) {
  const mimeType = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)) {
    return mimeType;
  }
  return "image/jpeg";
}

function guessMimeTypeFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "image/png";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".gif")) return "image/gif";
  } catch {
    return "image/jpeg";
  }
  return "image/jpeg";
}

async function writeGoogleResults(inputFile, outputFile, resultsBySku) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputFile);
  const worksheet = workbook.worksheets[0];
  const headers = worksheet.getRow(1).values.slice(1);
  const columnByHeader = buildColumnIndex(headers);
  const skuColumn = columnByHeader.get("Código (SKU)");

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const sku = cellToText(row.getCell(skuColumn).value).trim();
    const result = resultsBySku[sku];
    if (!isCheckpointProductComplete(result)) continue;

    for (let index = 0; index < IMAGE_COLUMNS.length; index += 1) {
      const column = columnByHeader.get(IMAGE_COLUMNS[index]);
      if (column) row.getCell(column).value = result.imagens[index] || "";
    }

    const md = result.metadadosGerados || {};
    setIfEmpty(row, columnByHeader, DESCRIPTION_COLUMN, md.descricao);
    setIfEmpty(row, columnByHeader, CATEGORIA_COLUMN, md.categoria);
    setIfEmpty(row, columnByHeader, TITULO_SEO_COLUMN, md.tituloSeo);
    setIfEmpty(row, columnByHeader, DESCRICAO_SEO_COLUMN, md.descricaoSeo);
    setIfEmpty(
      row,
      columnByHeader,
      PALAVRAS_CHAVE_SEO_COLUMN,
      md.palavrasChaveSeo,
    );
    row.commit?.();
  }

  const tempPath = `${outputFile}.tmp`;
  await workbook.xlsx.writeFile(tempPath);
  await fs.rename(tempPath, outputFile);
}

function setIfEmpty(row, columnByHeader, columnName, value) {
  const text = cellToText(value).trim();
  const column = columnByHeader.get(columnName);
  if (!column || !text) return;
  if (cellToText(row.getCell(column).value).trim()) return;
  row.getCell(column).value = text;
}

async function saveGoogleProgress(state, writeResultFile) {
  await writeJsonAtomic(state.checkpointFile, {
    version: CHECKPOINT_VERSION,
    processedSkus: [...state.processedSkus],
    products: state.results,
    technicalFailures: state.technicalFailures,
    total: state.total,
    completed: state.processedSkus.size,
    updatedAt: new Date().toISOString(),
  });

  if (writeResultFile) {
    await writeGoogleResults(state.inputFile, state.outputFile, state.results);
  }
}

async function readGoogleCheckpoint(checkpointFile) {
  if (!existsSync(checkpointFile)) return emptyGoogleCheckpoint();
  const raw = await fs.readFile(checkpointFile, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Nao foi possivel ler ${checkpointFile}: ${error.message}`,
    );
  }
}

function emptyGoogleCheckpoint() {
  return {
    version: CHECKPOINT_VERSION,
    processedSkus: [],
    products: {},
    technicalFailures: {},
    total: 0,
    completed: 0,
    updatedAt: null,
  };
}

function normalizeGoogleCheckpoint(checkpoint) {
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new Error(
      `Checkpoint Google incompativel. Remova ${DEFAULT_CHECKPOINT_FILE} para reiniciar.`,
    );
  }

  const results = checkpoint.products || {};
  const processedSkus = new Set(
    (checkpoint.processedSkus || []).filter((sku) =>
      isGoogleResultComplete(results[sku]),
    ),
  );
  return {
    processedSkus,
    results,
    technicalFailures: checkpoint.technicalFailures || {},
  };
}

function isGoogleResultComplete(result) {
  return isCheckpointProductComplete(result);
}

function classifyGoogleFailure(diagnostics) {
  if (
    (diagnostics.rejeicoes || []).some(
      (item) =>
        item.reason === "imagens_insuficientes_para_melhorar" ||
        item.reason === "imagens_anexadas_insuficientes_para_melhorar",
    )
  ) {
    return "sem_anuncio_com_mais_imagens";
  }
  if (
    (diagnostics.rejeicoes || []).some(
      (item) => item.reason === "dados_insuficientes",
    )
  ) {
    return "sem_imagem_validada";
  }
  if ((diagnostics.rejeicoes || []).some((item) => item.reason === "gemini_reprovou")) {
    return "gemini_reprovou_todos";
  }
  if ((diagnostics.queries || []).some((item) => item.erroTecnico)) {
    return "erro_tecnico_google";
  }
  return "sem_resultado_google";
}

function hasUsableCandidateData(result) {
  return (
    result?.titulo_encontrado &&
    result?.url_anuncio &&
    Array.isArray(result.imagens) &&
    result.imagens.length > 0
  );
}

function isRejectedCandidate(candidate, rejectedCandidates) {
  const key = candidateUrlKey(candidate.href);
  return rejectedCandidates.some((rejected) => rejected.candidateKey === key);
}

function rejectCandidate(rejectedCandidates, candidate, motivo) {
  const key = candidateUrlKey(candidate.href);
  if (!key || rejectedCandidates.some((rejected) => rejected.candidateKey === key)) {
    return;
  }
  rejectedCandidates.push({
    ...candidate,
    candidateKey: key,
    motivo,
  });
}

function candidateUrlKey(value) {
  try {
    const url = new URL(String(value || "").trim());
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return String(value || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

function buildColumnIndex(headers) {
  return new Map(headers.map((header, index) => [String(header), index + 1]));
}

function cellToText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object") {
    if ("text" in value) return String(value.text || "");
    if ("hyperlink" in value) return String(value.hyperlink || "");
    if (Array.isArray(value.richText)) {
      return value.richText.map((entry) => entry.text || "").join("");
    }
  }
  return String(value);
}

function readPositiveInt(value, fallback) {
  const parsed = Number(String(value || "").trim());
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.floor(parsed);
  return rounded >= 1 ? rounded : fallback;
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

export {
  GOOGLE_STORE,
  cellToText,
  collectGoogleCandidates,
  hasGoogleImageUpgrade,
  isCaptchaPage,
  isGoogleResultComplete,
  normalizeGoogleResultHref,
  selectGoogleImageTargets,
  selectProductsWithoutImages,
  shouldIgnoreGoogleResultHref,
  writeGoogleResults,
};
