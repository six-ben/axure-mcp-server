# axure-mcp-server

MCP server for extracting visible text and image links from public Axure share pages, so AI tools (Cursor/Claude Desktop/others with MCP support) can summarize prototype content.

## Features

- Extract visible text blocks from Axure page DOM
- Extract image URLs (optionally image base64 payload)
- Auto-discover and crawl additional same-origin Axure pages
- OCR fallback when text is image-only or too little
- Return structured JSON for downstream AI summarization
- Build an AI-ready summary prompt in one call
- Works with MCP clients via stdio

## Requirements

- Node.js >= 18
- npm >= 9

If your local Node is old (for example Node 16), upgrade first:

```bash
# if you use nvm
nvm install 20
nvm use 20
node -v
```

## Quick Start

```bash
npm install
npx playwright install chromium
npm run build
npm start
```

## MCP Tools

### 1) `axure_health`

Health check of runtime.

### 2) `axure_fetch`

Input:

```json
{
  "url": "https://vscn2w.axshare.com/?id=xpnh6e&p=%E5%8E%9F%E5%9E%8B%E6%96%B9%E6%A1%88&sc=3",
  "timeoutMs": 45000,
  "maxImages": 30,
  "maxTexts": 300,
  "crawlPages": true,
  "maxPages": 5,
  "enableOcrFallback": true,
  "ocrMinTextCount": 8,
  "ocrMaxImages": 3,
  "ocrLanguage": "chi_sim+eng",
  "includeImageBase64": false
}
```

Output: JSON with `status`, `textBlocks`, `imageItems`, `pages`, `warnings`, `stats` (including `ocrTextCount`).

### 3) `axure_summary_prompt`

Input:

```json
{
  "url": "https://vscn2w.axshare.com/?id=xpnh6e&p=%E5%8E%9F%E5%9E%8B%E6%96%B9%E6%A1%88&sc=3",
  "focus": "请提炼核心流程和页面功能点",
  "crawlPages": true,
  "maxPages": 6,
  "enableOcrFallback": true
}
```

Output: an AI-ready plain text prompt including extracted texts and image links.

## Use in Cursor

Add to MCP config (example):

```json
{
  "mcpServers": {
    "axure-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/axure-mcp-server/dist/index.js"]
    }
  }
}
```

If published to npm:

```json
{
  "mcpServers": {
    "axure-mcp": {
      "command": "npx",
      "args": ["-y", "axure-mcp-server"]
    }
  }
}
```

### Compatibility: keep Node 16 globally, run MCP on Node 20

If your main frontend stack (for example Vue2) must stay on Node 16, you can still run this MCP safely by pinning only this server to Node 20 in Cursor:

```json
{
  "mcpServers": {
    "axure-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "node@20",
        "/Users/55haitao/Desktop/axure-mcp-server/dist/index.js"
      ]
    }
  }
}
```

This keeps your global Node unchanged while ensuring `axure-mcp-server` runs with a compatible runtime.

### Compatibility after npm publish

If you publish this package to npm, and still need to keep global Node 16, use Node 20 only for this MCP process:

```json
{
  "mcpServers": {
    "axure-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "node@20",
        "/usr/local/bin/npx",
        "-y",
        "axure-mcp-server"
      ]
    }
  }
}
```

If your system `npx` path is different, replace `"/usr/local/bin/npx"` with your actual path from `which npx`.

## Publish to GitHub

```bash
git init
git add .
git commit -m "feat: init axure mcp server"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

## Publish to npm

Before publish:

1. Update `package.json` fields (`name`, `author`, `repository`, `homepage`)
2. Ensure build output exists: `npm run build`

Then:

```bash
npm login
npm publish --access public
```

## Roadmap

- Add optional multi-page navigation and auto-click flow
- Export markdown report and downloadable screenshot package

## Notes

- Designed for public/no-login Axure links.
- Respect source site terms and data usage permissions.
