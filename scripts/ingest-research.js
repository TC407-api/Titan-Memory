#!/usr/bin/env node
/**
 * Batch ingest D:/Research into Titan Memory
 * Reads .md, .json, .jsonl, .txt files from each subdirectory
 * Stores as research memories with directory-based tags
 */
const fs = require("fs");
const path = require("path");
const { ToolHandler } = require("../dist/mcp/tools.js");

const RESEARCH_DIR = "D:/Research";
const SKIP_DIRS = ["inbox", "_archive", "_staging", "_templates"];
const EXTENSIONS = [".md", ".json", ".jsonl", ".txt"];
const MAX_CONTENT = 3000;

async function main() {
  const h = new ToolHandler();
  let totalIngested = 0;
  let totalSkipped = 0;

  const dirs = fs.readdirSync(RESEARCH_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !SKIP_DIRS.includes(d.name) && !d.name.startsWith("_"))
    .map(d => d.name);

  console.log(`Found ${dirs.length} research directories to ingest\n`);

  for (const dir of dirs) {
    const dirPath = path.join(RESEARCH_DIR, dir);
    let files;
    try {
      files = fs.readdirSync(dirPath).filter(f => EXTENSIONS.some(ext => f.endsWith(ext)));
    } catch (e) {
      console.log(`  SKIP ${dir}: ${e.message}`);
      continue;
    }

    if (files.length === 0) {
      console.log(`  SKIP ${dir}: no matching files`);
      totalSkipped++;
      continue;
    }

    console.log(`\n[${dir}] — ${files.length} files`);

    for (const file of files) {
      try {
        let content = fs.readFileSync(path.join(dirPath, file), "utf8").trim();
        if (!content || content.length < 50) {
          totalSkipped++;
          continue;
        }

        // For JSON, try to extract meaningful text
        if (file.endsWith(".json") || file.endsWith(".jsonl")) {
          try {
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed)) {
              content = parsed.map(item => item.content || item.text || item.summary || JSON.stringify(item).substring(0, 500)).join("\n\n");
            } else if (parsed.content) {
              content = parsed.content;
            } else if (parsed.text) {
              content = parsed.text;
            }
          } catch (e) {
            // JSONL — take first few lines
            content = content.split("\n").slice(0, 5).join("\n");
          }
        }

        if (content.length > MAX_CONTENT) content = content.substring(0, MAX_CONTENT) + "...[truncated]";

        const topic = dir.replace(/-/g, " ");
        const fileName = file.replace(/\.[^.]+$/, "").replace(/-/g, " ");

        await h.handleToolCall("titan_add", {
          content: `RESEARCH [${topic}]: ${fileName}\n\n${content}`,
          tags: ["research", dir, fileName.split(" ")[0]],
        });

        totalIngested++;
        console.log(`  ✓ ${file} (${content.length} chars)`);
      } catch (e) {
        console.log(`  ✗ ${file}: ${e.message}`);
        totalSkipped++;
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`Research ingestion complete.`);
  console.log(`Ingested: ${totalIngested} files`);
  console.log(`Skipped: ${totalSkipped} files`);
  console.log(`========================================`);
}

main().catch(e => console.error("FATAL:", e.message));
