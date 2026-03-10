export interface AxureImageItem {
  url: string;
  alt?: string;
  base64?: string;
}

export interface AxurePageItem {
  url: string;
  title?: string;
  textBlocks: string[];
  ocrTextBlocks?: string[];
  imageItems: AxureImageItem[];
  stats: {
    textCount: number;
    ocrTextCount: number;
    imageCount: number;
  };
}

export interface AxureFetchResult {
  status: "full" | "partial" | "failed";
  sourceUrl: string;
  finalUrl?: string;
  title?: string;
  fetchedAt: string;
  textBlocks: string[];
  imageItems: AxureImageItem[];
  pages: AxurePageItem[];
  stats: {
    textCount: number;
    ocrTextCount: number;
    imageCount: number;
    pageCount: number;
  };
  warnings: string[];
  error?: string;
}

export interface AxureFetchOptions {
  timeoutMs?: number;
  maxImages?: number;
  maxTexts?: number;
  crawlPages?: boolean;
  maxPages?: number;
  enableOcrFallback?: boolean;
  ocrMinTextCount?: number;
  ocrMaxImages?: number;
  ocrLanguage?: string;
  includeImageBase64?: boolean;
}
