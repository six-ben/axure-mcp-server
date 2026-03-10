import { chromium, type Page } from "playwright";
import type { AxureFetchOptions, AxureFetchResult, AxureImageItem, AxurePageItem } from "./types.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_IMAGES = 30;
const DEFAULT_MAX_TEXTS = 200;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_OCR_MIN_TEXT_COUNT = 6;
const DEFAULT_OCR_MAX_IMAGES = 3;
const DEFAULT_OCR_LANGUAGE = "chi_sim+eng";

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function uniqueKeepOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function clipTextBlocks(textBlocks: string[], maxChars = 12_000): string[] {
  const result: string[] = [];
  let used = 0;
  for (const block of textBlocks) {
    if (used >= maxChars) break;
    if (used + block.length > maxChars) {
      result.push(block.slice(0, Math.max(0, maxChars - used)));
      break;
    }
    result.push(block);
    used += block.length;
  }
  return result;
}

function isLikelyAxurePage(url: URL): boolean {
  return url.hostname.includes("axshare.com") || url.searchParams.has("id") || url.searchParams.has("p");
}

function toAbsoluteUrl(rawUrl: string, baseUrl: string): string {
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return "";
  }
}

async function runOcrFallback(
  page: Page,
  imageItems: AxureImageItem[],
  options: {
    timeoutMs: number;
    ocrMaxImages: number;
    ocrLanguage: string;
  },
): Promise<{ texts: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (imageItems.length === 0) return { texts: [], warnings };

  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(options.ocrLanguage);
    const ocrTexts: string[] = [];

    try {
      for (const imageItem of imageItems.slice(0, options.ocrMaxImages)) {
        try {
          const resp = await page.request.get(imageItem.url, {
            timeout: Math.min(options.timeoutMs, 15_000),
          });
          if (!resp.ok()) {
            warnings.push(`OCR skipped non-200 image: ${imageItem.url}`);
            continue;
          }
          const buffer = await resp.body();
          const result = await worker.recognize(buffer);
          const text = normalizeText(result?.data?.text || "");
          if (text.length >= 2) ocrTexts.push(text);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`OCR failed image: ${imageItem.url}. ${message}`);
        }
      }
    } finally {
      await worker.terminate();
    }

    return { texts: uniqueKeepOrder(ocrTexts), warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`OCR module unavailable or initialization failed: ${message}`);
    return { texts: [], warnings };
  }
}

async function extractSinglePage(
  url: string,
  options: {
    timeoutMs: number;
    maxImages: number;
    maxTexts: number;
    enableOcrFallback: boolean;
    ocrMinTextCount: number;
    ocrMaxImages: number;
    ocrLanguage: string;
    includeImageBase64: boolean;
  },
): Promise<AxurePageItem & { discoveredUrls: string[]; pageWarnings: string[] }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page.waitForLoadState("networkidle", { timeout: options.timeoutMs }).catch(() => {
      // Some Axure pages keep long-polling.
    });

    const pageUrl = page.url();
    const payload = await page.evaluate(() => {
      const hiddenTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH"]);
      const textCandidates: string[] = [];
      const discoveredLinks: string[] = [];

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const node = walker.currentNode as HTMLElement;
        if (!node || hiddenTags.has(node.tagName)) continue;
        const style = window.getComputedStyle(node);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number.parseFloat(style.opacity || "1") === 0
        ) {
          continue;
        }
        const ownText = (node.innerText || "").trim();
        if (!ownText || ownText.length < 2 || ownText.length > 2000) continue;
        textCandidates.push(ownText);
      }

      const imageCandidates: Array<{ url: string; alt?: string }> = [];
      const imgElements = Array.from(document.querySelectorAll("img"));
      for (const img of imgElements) {
        const src = img.getAttribute("src") || "";
        if (!src) continue;
        imageCandidates.push({ url: src, alt: img.getAttribute("alt") || undefined });
      }

      const bgElements = Array.from(document.querySelectorAll<HTMLElement>("[style*='background-image']"));
      for (const el of bgElements) {
        const style = el.getAttribute("style") || "";
        const match = style.match(/background-image:\s*url\((['"]?)(.*?)\1\)/i);
        if (match?.[2]) imageCandidates.push({ url: match[2] });
      }

      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
      for (const link of links) {
        const href = link.getAttribute("href") || "";
        if (href) discoveredLinks.push(href);
      }

      return {
        title: document.title || undefined,
        textCandidates,
        imageCandidates,
        discoveredLinks,
      };
    });

    const textBlocks = uniqueKeepOrder(payload.textCandidates.map(normalizeText))
      .filter((txt) => txt.length >= 2)
      .slice(0, options.maxTexts);

    const normalizedImageUrls = uniqueKeepOrder(
      payload.imageCandidates.map((img) => toAbsoluteUrl(img.url, pageUrl)).filter(Boolean),
    ).slice(0, options.maxImages);

    const altMap = new Map<string, string>();
    for (const item of payload.imageCandidates) {
      const normalized = toAbsoluteUrl(item.url, pageUrl);
      if (!normalized || !item.alt) continue;
      if (!altMap.has(normalized)) altMap.set(normalized, item.alt);
    }

    const imageItems: AxureImageItem[] = normalizedImageUrls.map((imageUrl) => ({
      url: imageUrl,
      alt: altMap.get(imageUrl),
    }));

    if (options.includeImageBase64) {
      for (const item of imageItems) {
        try {
          const resp = await page.request.get(item.url, { timeout: Math.min(10_000, options.timeoutMs) });
          if (!resp.ok()) continue;
          const contentType = resp.headers()["content-type"] || "image/png";
          const buffer = await resp.body();
          item.base64 = `data:${contentType};base64,${buffer.toString("base64")}`;
        } catch {
          // Keep URL even if image payload fetch fails.
        }
      }
    }

    let ocrTextBlocks: string[] = [];
    const localWarnings: string[] = [];
    if (options.enableOcrFallback && textBlocks.length < options.ocrMinTextCount && imageItems.length > 0) {
      const ocrResult = await runOcrFallback(page, imageItems, {
        timeoutMs: options.timeoutMs,
        ocrMaxImages: options.ocrMaxImages,
        ocrLanguage: options.ocrLanguage,
      });
      ocrTextBlocks = ocrResult.texts.slice(0, options.maxTexts);
      localWarnings.push(...ocrResult.warnings);
    }

    const discoveredUrls = uniqueKeepOrder(
      payload.discoveredLinks
        .map((raw) => toAbsoluteUrl(raw, pageUrl))
        .filter(Boolean)
        .filter((candidate) => {
          try {
            const base = new URL(pageUrl);
            const next = new URL(candidate);
            return base.origin === next.origin && isLikelyAxurePage(next);
          } catch {
            return false;
          }
        }),
    );

    return {
      url: pageUrl,
      title: payload.title,
      textBlocks: uniqueKeepOrder([...textBlocks, ...ocrTextBlocks]).slice(0, options.maxTexts),
      ocrTextBlocks,
      imageItems,
      stats: {
        textCount: uniqueKeepOrder([...textBlocks, ...ocrTextBlocks]).slice(0, options.maxTexts).length,
        ocrTextCount: ocrTextBlocks.length,
        imageCount: imageItems.length,
      },
      discoveredUrls,
      pageWarnings: localWarnings,
    };
  } finally {
    await browser.close();
  }
}

export async function fetchAxureContent(
  sourceUrl: string,
  options: AxureFetchOptions = {},
): Promise<AxureFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES;
  const maxTexts = options.maxTexts ?? DEFAULT_MAX_TEXTS;
  const crawlPages = options.crawlPages ?? true;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const enableOcrFallback = options.enableOcrFallback ?? true;
  const ocrMinTextCount = options.ocrMinTextCount ?? DEFAULT_OCR_MIN_TEXT_COUNT;
  const ocrMaxImages = options.ocrMaxImages ?? DEFAULT_OCR_MAX_IMAGES;
  const ocrLanguage = options.ocrLanguage ?? DEFAULT_OCR_LANGUAGE;
  const includeImageBase64 = options.includeImageBase64 ?? false;

  const fetchedAt = new Date().toISOString();

  try {
    const queue: string[] = [sourceUrl];
    const visited = new Set<string>();
    const pages: AxurePageItem[] = [];
    const warnings: string[] = [];

    while (queue.length > 0 && pages.length < maxPages) {
      const currentUrl = queue.shift() as string;
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);
      try {
        const pageResult = await extractSinglePage(currentUrl, {
          timeoutMs,
          maxImages,
          maxTexts,
          enableOcrFallback,
          ocrMinTextCount,
          ocrMaxImages,
          ocrLanguage,
          includeImageBase64,
        });
        warnings.push(...pageResult.pageWarnings);
        pages.push({
          url: pageResult.url,
          title: pageResult.title,
          textBlocks: pageResult.textBlocks,
          ocrTextBlocks: pageResult.ocrTextBlocks,
          imageItems: pageResult.imageItems,
          stats: pageResult.stats,
        });

        if (crawlPages) {
          for (const candidate of pageResult.discoveredUrls) {
            if (visited.has(candidate)) continue;
            if (!queue.includes(candidate)) queue.push(candidate);
            if (queue.length + pages.length >= maxPages * 3) break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Failed page: ${currentUrl}. ${message}`);
      }
      if (!crawlPages) break;
    }

    const allTexts = uniqueKeepOrder(
      pages.flatMap((pageItem) => pageItem.textBlocks.map(normalizeText)).filter((txt) => txt.length >= 2),
    ).slice(0, maxTexts);

    const allImageMap = new Map<string, AxureImageItem>();
    for (const pageItem of pages) {
      for (const img of pageItem.imageItems) {
        if (allImageMap.has(img.url)) continue;
        allImageMap.set(img.url, img);
      }
      if (allImageMap.size >= maxImages) break;
    }
    const allImages = Array.from(allImageMap.values()).slice(0, maxImages);

    if (pages.length === 0) warnings.push("No page extracted successfully.");
    if (allTexts.length === 0) warnings.push("No visible text extracted from page(s).");
    if (allImages.length === 0) warnings.push("No image URL extracted from page(s).");

    const status: AxureFetchResult["status"] =
      allTexts.length > 0 && allImages.length > 0
        ? "full"
        : allTexts.length > 0 || allImages.length > 0
          ? "partial"
          : "failed";

    const firstPage = pages[0];
    return {
      status,
      sourceUrl,
      finalUrl: firstPage?.url,
      title: firstPage?.title,
      fetchedAt,
      textBlocks: clipTextBlocks(allTexts),
      imageItems: allImages,
      pages,
      stats: {
        textCount: allTexts.length,
        ocrTextCount: pages.reduce((sum, pageItem) => sum + (pageItem.stats.ocrTextCount || 0), 0),
        imageCount: allImages.length,
        pageCount: pages.length,
      },
      warnings,
      error: status === "failed" ? "Page loaded but no useful text/image content extracted." : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      sourceUrl,
      fetchedAt,
      textBlocks: [],
      imageItems: [],
      pages: [],
      stats: {
        textCount: 0,
        ocrTextCount: 0,
        imageCount: 0,
        pageCount: 0,
      },
      warnings: ["Fetch failed before extraction completed."],
      error: message,
    };
  }
}

export function buildSummaryPrompt(
  result: AxureFetchResult,
  focus = "请总结该原型的核心页面结构、关键流程、主要功能点与风险点。",
): string {
  const lines: string[] = [];
  lines.push("你是产品与交互分析助手，请根据以下 Axure 原型提取内容做总结。");
  lines.push("");
  lines.push(`源链接: ${result.sourceUrl}`);
  if (result.title) lines.push(`页面标题: ${result.title}`);
  lines.push(`抓取状态: ${result.status}`);
  lines.push(
    `页面数量: ${result.stats.pageCount}，文本数量: ${result.stats.textCount}（OCR补充: ${result.stats.ocrTextCount}），图片数量: ${result.stats.imageCount}`,
  );
  if (result.pages.length > 0) {
    lines.push("");
    lines.push("【页面清单】");
    result.pages.slice(0, 20).forEach((pageItem, idx) => {
      const pageTitle = pageItem.title ? ` - ${pageItem.title}` : "";
      lines.push(`${idx + 1}. ${pageItem.url}${pageTitle}`);
    });
  }
  lines.push("");
  lines.push("【文本内容】");
  result.textBlocks.slice(0, 80).forEach((block, idx) => {
    lines.push(`${idx + 1}. ${block}`);
  });
  lines.push("");
  lines.push("【图片链接】");
  result.imageItems.slice(0, 30).forEach((img, idx) => {
    lines.push(`${idx + 1}. ${img.url}`);
  });
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("【警告】");
    result.warnings.forEach((w, idx) => lines.push(`${idx + 1}. ${w}`));
  }
  lines.push("");
  lines.push("【任务】");
  lines.push(focus);
  return lines.join("\n");
}
