# M1 Cron Setup for Zilliz Maintenance

## Prerequisites
- ZILLIZ_URI and ZILLIZ_TOKEN set in M1 environment
- Node.js installed on M1
- Titan Memory repo synced to M1

## Crontab entries (run `crontab -e` on M1)

```cron
# Zilliz maintenance — consolidation every 6 hours
0 */6 * * * ZILLIZ_URI="$ZILLIZ_URI" ZILLIZ_TOKEN="$ZILLIZ_TOKEN" /usr/local/bin/node ~/.claude/titan-memory/scripts/maintenance.mjs --consolidate >> ~/.claude/titan-memory/logs/maintenance.log 2>&1

# Zilliz maintenance — pruning + health check daily at 3 AM
0 3 * * * ZILLIZ_URI="$ZILLIZ_URI" ZILLIZ_TOKEN="$ZILLIZ_TOKEN" /usr/local/bin/node ~/.claude/titan-memory/scripts/maintenance.mjs --prune --health >> ~/.claude/titan-memory/logs/maintenance.log 2>&1
```

## Manual run
```bash
cd ~/.claude/titan-memory
node scripts/maintenance.mjs --all
node scripts/maintenance.mjs --health
node scripts/maintenance.mjs --prune
node scripts/maintenance.mjs --consolidate
```

## Also needed on M1
1. Copy updated config.json (hybridSearch.enabled: true, denseWeight: 0.6, sparseWeight: 0.4)
2. Verify ZILLIZ_URI and ZILLIZ_TOKEN env vars are set
3. Restart Titan MCP server: `pm2 restart titan-memory` or kill/restart the node process
