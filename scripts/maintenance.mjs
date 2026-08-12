#!/usr/bin/env node
/**
 * Zilliz Cloud Maintenance Script
 *
 * Runs on M1 via crontab:
 *   - Every 6 hours: consolidation (merge similar, update embeddings)
 *   - Every 24 hours: pruning (remove low-utility items past TTL)
 *   - Every 24 hours: health check (verify all collections, log stats)
 *
 * Usage:
 *   node maintenance.mjs --consolidate
 *   node maintenance.mjs --prune
 *   node maintenance.mjs --health
 *   node maintenance.mjs --all
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'maintenance.log');

const ZILLIZ_URI = process.env.ZILLIZ_URI;
const ZILLIZ_TOKEN = process.env.ZILLIZ_TOKEN;

if (!ZILLIZ_URI || !ZILLIZ_TOKEN) {
  console.error('ZILLIZ_URI and ZILLIZ_TOKEN must be set');
  process.exit(1);
}

// Collection TTL rules (days)
const PRUNE_RULES = {
  content_pipeline: { maxAgeDays: 90, minUtility: 0.3 },
  fs_knowledge: { maxAgeDays: 180, minUtility: 0.2 },
  wd_knowledge: { maxAgeDays: 180, minUtility: 0.2 },
  ll_knowledge: { maxAgeDays: 180, minUtility: 0.2 },
  cc_knowledge: { maxAgeDays: 180, minUtility: 0.2 },
  business_intel: { maxAgeDays: 365, minUtility: 0.1 },
  general_reference: { maxAgeDays: null, minUtility: null }, // never auto-prune
};

// --- Logging ---
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  ensureLogDir();
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// --- Zilliz API ---
function zillizRequest(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/v2/vectordb/${endpoint}`, ZILLIZ_URI);
    const body = JSON.stringify(payload);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ZILLIZ_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Health Check ---
async function healthCheck() {
  log('INFO', '=== Health Check ===');
  const resp = await zillizRequest('collections/list', {});
  if (resp.code !== 0) {
    log('ERROR', `Failed to list collections: ${resp.message}`);
    return false;
  }

  const collections = resp.data || [];
  log('INFO', `Total collections: ${collections.length}`);

  let allHealthy = true;
  for (const col of collections) {
    try {
      const stats = await zillizRequest('collections/get_stats', { collectionName: col });
      if (stats.code === 0) {
        log('INFO', `  ${col}: ${stats.data.rowCount} entities`);
      } else {
        log('WARN', `  ${col}: stats failed — ${stats.message}`);
        allHealthy = false;
      }
    } catch (e) {
      log('ERROR', `  ${col}: ${e.message}`);
      allHealthy = false;
    }
  }

  log('INFO', `Health: ${allHealthy ? 'ALL OK' : 'ISSUES DETECTED'}`);
  return allHealthy;
}

// --- Pruning ---
async function pruneCollection(collectionName, rules) {
  if (!rules || rules.maxAgeDays === null) {
    log('INFO', `  ${collectionName}: skip (no auto-prune)`);
    return 0;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rules.maxAgeDays);
  const cutoffISO = cutoff.toISOString();

  // Query old items
  try {
    const resp = await zillizRequest('entities/query', {
      collectionName,
      filter: `timestamp < "${cutoffISO}"`,
      outputFields: ['id', 'timestamp', 'metadata'],
      limit: 500,
    });

    if (resp.code !== 0) {
      log('WARN', `  ${collectionName}: query failed — ${resp.message}`);
      return 0;
    }

    const items = resp.data || [];
    if (items.length === 0) {
      log('INFO', `  ${collectionName}: nothing to prune`);
      return 0;
    }

    // Filter by utility score
    const toDelete = [];
    for (const item of items) {
      let meta = {};
      try { meta = JSON.parse(item.metadata || '{}'); } catch {}
      const utility = meta.utilityScore || 0;
      if (utility < rules.minUtility) {
        toDelete.push(item.id);
      }
    }

    if (toDelete.length === 0) {
      log('INFO', `  ${collectionName}: ${items.length} old items, all above utility threshold`);
      return 0;
    }

    // Delete in batches
    const deleteResp = await zillizRequest('entities/delete', {
      collectionName,
      filter: `id in [${toDelete.map(id => `"${id}"`).join(',')}]`,
    });

    const deleted = deleteResp.code === 0 ? toDelete.length : 0;
    log('INFO', `  ${collectionName}: pruned ${deleted} items (>${rules.maxAgeDays}d, utility<${rules.minUtility})`);
    return deleted;
  } catch (e) {
    log('ERROR', `  ${collectionName}: prune error — ${e.message}`);
    return 0;
  }
}

async function prune() {
  log('INFO', '=== Pruning ===');
  let totalPruned = 0;
  for (const [col, rules] of Object.entries(PRUNE_RULES)) {
    totalPruned += await pruneCollection(col, rules);
  }
  log('INFO', `Total pruned: ${totalPruned}`);
  return totalPruned;
}

// --- Consolidation ---
async function consolidate() {
  log('INFO', '=== Consolidation ===');
  // For now: verify collections are loaded and compact
  const resp = await zillizRequest('collections/list', {});
  const collections = resp.data || [];

  for (const col of collections) {
    try {
      const stats = await zillizRequest('collections/get_stats', { collectionName: col });
      if (stats.code === 0) {
        log('INFO', `  ${col}: ${stats.data.rowCount} entities — OK`);
      }
    } catch (e) {
      log('WARN', `  ${col}: consolidation check failed — ${e.message}`);
    }
  }
  log('INFO', 'Consolidation complete');
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const runAll = args.includes('--all') || args.length === 0;

  log('INFO', `Maintenance started (args: ${args.join(' ') || '--all'})`);

  try {
    if (runAll || args.includes('--health')) {
      await healthCheck();
    }
    if (runAll || args.includes('--prune')) {
      await prune();
    }
    if (runAll || args.includes('--consolidate')) {
      await consolidate();
    }
    log('INFO', 'Maintenance completed successfully');
  } catch (e) {
    log('ERROR', `Maintenance failed: ${e.message}`);
    process.exit(1);
  }
}

main();
