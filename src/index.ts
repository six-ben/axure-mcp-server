#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { buildSummaryPrompt, fetchAxureContent } from "./extractor.js";

const server = new McpServer({
  name: "axure-mcp-server",
  version: "0.3.0",
});

server.registerTool(
  "axure_health",
  {
    description: "Health check for Axure MCP server runtime.",
    inputSchema: {},
  },
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              service: "axure-mcp-server",
              version: "0.3.0",
              nodeVersion: process.version,
              now: new Date().toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "axure_fetch",
  {
    description: "Fetch visible text and image URLs from a public Axure share link.",
    inputSchema: {
      url: z.url().describe("Public Axure URL, e.g. https://xxx.axshare.com/?id=..."),
      timeoutMs: z.number().int().min(5000).max(120000).optional(),
      maxImages: z.number().int().min(1).max(200).optional(),
      maxTexts: z.number().int().min(20).max(2000).optional(),
      crawlPages: z
        .boolean()
        .optional()
        .describe("If true, discovers and crawls additional same-origin Axure links."),
      maxPages: z.number().int().min(1).max(30).optional(),
      enableOcrFallback: z
        .boolean()
        .optional()
        .describe("If true, OCR fallback will run when extracted text is too little."),
      ocrMinTextCount: z.number().int().min(0).max(100).optional(),
      ocrMaxImages: z.number().int().min(1).max(20).optional(),
      ocrLanguage: z
        .string()
        .optional()
        .describe("Tesseract language codes, e.g. chi_sim+eng"),
      includeImageBase64: z
        .boolean()
        .optional()
        .describe("If true, tries to attach image base64 data for each URL."),
    },
  },
  async ({
    url,
    timeoutMs,
    maxImages,
    maxTexts,
    crawlPages,
    maxPages,
    enableOcrFallback,
    ocrMinTextCount,
    ocrMaxImages,
    ocrLanguage,
    includeImageBase64,
  }) => {
    const result = await fetchAxureContent(url, {
      timeoutMs,
      maxImages,
      maxTexts,
      crawlPages,
      maxPages,
      enableOcrFallback,
      ocrMinTextCount,
      ocrMaxImages,
      ocrLanguage,
      includeImageBase64,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

server.registerTool(
  "axure_summary_prompt",
  {
    description: "Build an AI-ready summary prompt from a public Axure link.",
    inputSchema: {
      url: z.url().describe("Public Axure URL"),
      focus: z
        .string()
        .optional()
        .describe("Optional instruction for what you want AI to focus on."),
      timeoutMs: z.number().int().min(5000).max(120000).optional(),
      maxImages: z.number().int().min(1).max(200).optional(),
      maxTexts: z.number().int().min(20).max(2000).optional(),
      crawlPages: z.boolean().optional(),
      maxPages: z.number().int().min(1).max(30).optional(),
      enableOcrFallback: z.boolean().optional(),
      ocrMinTextCount: z.number().int().min(0).max(100).optional(),
      ocrMaxImages: z.number().int().min(1).max(20).optional(),
      ocrLanguage: z.string().optional(),
    },
  },
  async ({
    url,
    focus,
    timeoutMs,
    maxImages,
    maxTexts,
    crawlPages,
    maxPages,
    enableOcrFallback,
    ocrMinTextCount,
    ocrMaxImages,
    ocrLanguage,
  }) => {
    const result = await fetchAxureContent(url, {
      timeoutMs,
      maxImages,
      maxTexts,
      crawlPages,
      maxPages,
      enableOcrFallback,
      ocrMinTextCount,
      ocrMaxImages,
      ocrLanguage,
      includeImageBase64: false,
    });

    const prompt = buildSummaryPrompt(result, focus);

    return {
      content: [
        {
          type: "text",
          text: prompt,
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[axure-mcp-server] fatal:", error);
  process.exit(1);
});
