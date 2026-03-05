/**
 * Titan Memory Dashboard API Routes
 * REST endpoint handlers for memory operations
 */

import { TitanMemory } from '../titan.js';
import { MemoryLayer, MemoryEntry } from '../types.js';
import { listProjects } from '../utils/config.js';
import type { DashboardServer } from './server.js';
import { getContextMonitor } from '../monitoring/context-monitor.js';
import { getProactiveFlushManager } from '../utils/proactive-flush.js';
import type { DecisionType } from '../trace/decision-trace.js';

const VALID_DECISION_TYPES = new Set<string>([
  'architecture', 'implementation', 'technology', 'debugging',
  'optimization', 'workflow', 'configuration', 'user_preference',
  'tradeoff', 'rollback', 'other',
]);

export interface ApiRequest {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface ApiRoute {
  method: string;
  path: string;
  handler: (req: ApiRequest) => Promise<unknown>;
}

/**
 * Create API router with all endpoints
 */
export function createApiRouter(titan: TitanMemory, server: DashboardServer): ApiRoute[] {
  return [
    // Health check
    {
      method: 'GET',
      path: '/api/health',
      handler: async () => ({
        status: 'ok',
        version: '1.0.0',
        project: titan.getActiveProject() || 'default',
        timestamp: new Date().toISOString(),
      }),
    },

    // Memory statistics
    {
      method: 'GET',
      path: '/api/stats',
      handler: async () => {
        const stats = await titan.getStats();
        return {
          ...stats,
          project: titan.getActiveProject() || 'default',
        };
      },
    },

    // Hash statistics (factual layer)
    {
      method: 'GET',
      path: '/api/stats/hash',
      handler: async () => titan.getHashStats(),
    },

    // Pattern statistics (semantic layer)
    {
      method: 'GET',
      path: '/api/stats/patterns',
      handler: async () => titan.getPatternStats(),
    },

    // Graph statistics
    {
      method: 'GET',
      path: '/api/stats/graph',
      handler: async () => titan.getGraphStats(),
    },

    // Learning statistics (continual learner)
    {
      method: 'GET',
      path: '/api/stats/learning',
      handler: async () => titan.getLearningStats(),
    },

    // Phase 3 combined statistics
    {
      method: 'GET',
      path: '/api/stats/phase3',
      handler: async () => titan.getPhase3Stats(),
    },

    // Knowledge graph data
    {
      method: 'GET',
      path: '/api/graph',
      handler: async () => {
        // Query graph with common entities as starting points
        const stats = await titan.getGraphStats();
        return {
          stats,
          // Return empty if no entities yet
          nodes: [],
          edges: [],
        };
      },
    },

    // Graph query
    {
      method: 'POST',
      path: '/api/graph/query',
      handler: async (req) => {
        const body = req.body as { entities?: string[]; maxDepth?: number; minStrength?: number };
        if (!body.entities || body.entities.length === 0) {
          return { nodes: [], edges: [], paths: [] };
        }
        return titan.queryGraph(body.entities, {
          maxDepth: body.maxDepth || 2,
          minStrength: body.minStrength || 0.1,
        });
      },
    },

    // Extract entities from content
    {
      method: 'POST',
      path: '/api/graph/extract',
      handler: async (req) => {
        const body = req.body as { content: string };
        if (!body.content) {
          throw new Error('Content is required');
        }
        return titan.extractGraph(body.content);
      },
    },

    // Decision history
    {
      method: 'GET',
      path: '/api/decisions',
      handler: async (req) => {
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 1000);
        const type = req.query.type as string | undefined;
        const status = req.query.status as 'pending' | 'success' | 'failure' | undefined;
        const validatedType = type && VALID_DECISION_TYPES.has(type) ? type as DecisionType : undefined;

        return titan.queryDecisions({
          type: validatedType,
          outcomeStatus: status,
          limit,
        });
      },
    },

    // Create decision trace
    {
      method: 'POST',
      path: '/api/decisions',
      handler: async (req) => {
        const body = req.body as {
          type: string;
          summary: string;
          description: string;
          rationale: string;
          alternatives?: Array<{ description: string; pros?: string[]; cons?: string[] }>;
          confidence?: number;
          tags?: string[];
        };

        const validatedBodyType = VALID_DECISION_TYPES.has(body.type) ? body.type as DecisionType : 'other' as DecisionType;
        return titan.traceDecision({
          type: validatedBodyType,
          summary: body.summary,
          description: body.description,
          rationale: body.rationale,
          alternatives: body.alternatives,
          confidence: body.confidence,
          tags: body.tags,
        });
      },
    },

    // Record decision outcome
    {
      method: 'POST',
      path: '/api/decisions/:id/outcome',
      handler: async (req) => {
        const body = req.body as {
          status: 'success' | 'partial' | 'failure';
          description?: string;
          feedback?: string;
        };
        return titan.recordDecisionOutcome(req.params.id, body);
      },
    },

    // Memory search
    {
      method: 'POST',
      path: '/api/search',
      handler: async (req) => {
        const body = req.body as {
          query: string;
          limit?: number;
          layers?: number[];
          tags?: string[];
          dateRange?: { start: string; end: string };
        };

        if (!body.query) {
          throw new Error('Query is required');
        }

        const result = await titan.recall(body.query, {
          limit: body.limit || 10,
          layers: body.layers as MemoryLayer[],
          tags: body.tags,
          dateRange: body.dateRange ? {
            start: new Date(body.dateRange.start),
            end: new Date(body.dateRange.end),
          } : undefined,
        });

        // Emit search event - handle both result types
        const resultCount = 'fusedMemories' in result
          ? result.fusedMemories.length
          : result.summaries.length;
        server.emitEvent('search', { query: body.query, resultCount });

        return result;
      },
    },

    // List all projects
    {
      method: 'GET',
      path: '/api/projects',
      handler: async () => {
        const projects = listProjects();
        return {
          active: titan.getActiveProject() || 'default',
          projects: ['default', ...projects],
        };
      },
    },

    // Switch project
    {
      method: 'POST',
      path: '/api/projects/switch',
      handler: async (req) => {
        const body = req.body as { projectId: string };
        const projectId = body.projectId === 'default' ? undefined : body.projectId;
        await titan.setActiveProject(projectId);
        server.emitEvent('project:switch', { projectId: body.projectId });
        return { success: true, project: body.projectId };
      },
    },

    // Get specific memory
    {
      method: 'GET',
      path: '/api/memories/:id',
      handler: async (req) => {
        const memory = await titan.get(req.params.id);
        if (!memory) {
          throw new Error('Memory not found');
        }
        return memory;
      },
    },

    // Add memory
    {
      method: 'POST',
      path: '/api/memories',
      handler: async (req) => {
        const body = req.body as {
          content: string;
          layer?: number;
          tags?: string[];
        };

        if (!body.content) {
          throw new Error('Content is required');
        }

        let memory: MemoryEntry;
        if (body.layer != null && body.layer >= 2 && body.layer <= 5) {
          memory = await titan.addToLayer(body.layer as MemoryLayer, body.content, { tags: body.tags });
        } else {
          memory = await titan.add(body.content, { tags: body.tags });
        }

        // Emit add event
        server.emitEvent('memory:add', { id: memory.id, layer: memory.layer });

        return memory;
      },
    },

    // Delete memory
    {
      method: 'DELETE',
      path: '/api/memories/:id',
      handler: async (req) => {
        const deleted = await titan.delete(req.params.id);
        if (deleted) {
          server.emitEvent('memory:delete', { id: req.params.id });
        }
        return { success: deleted };
      },
    },

    // Export memories
    {
      method: 'GET',
      path: '/api/export',
      handler: async (req) => {
        const format = req.query.format || 'json';
        const exportData = await titan.export();

        if (format === 'markdown') {
          return {
            format: 'markdown',
            content: generateMarkdownExport(exportData),
          };
        }

        return exportData;
      },
    },

    // Get today's episodic entries
    {
      method: 'GET',
      path: '/api/today',
      handler: async () => titan.getToday(),
    },

    // Get available dates
    {
      method: 'GET',
      path: '/api/dates',
      handler: async () => titan.getAvailableDates(),
    },

    // Daily summary
    {
      method: 'GET',
      path: '/api/summary/:date',
      handler: async (req) => {
        const summary = await titan.summarizeDay(req.params.date);
        return { date: req.params.date, summary };
      },
    },

    // World model state
    {
      method: 'GET',
      path: '/api/world',
      handler: async () => titan.getWorldState(),
    },

    // Validation report
    {
      method: 'GET',
      path: '/api/validation',
      handler: async () => titan.validate(),
    },

    // Validation issues
    {
      method: 'GET',
      path: '/api/validation/issues',
      handler: async (req) => {
        const severity = req.query.severity as 'critical' | 'warning' | 'info' | undefined;
        return titan.getValidationIssues(severity);
      },
    },

    // Cluster memories
    {
      method: 'GET',
      path: '/api/clusters',
      handler: async () => titan.clusterMemories(),
    },

    // Consolidate memories
    {
      method: 'POST',
      path: '/api/consolidate',
      handler: async () => {
        const result = await titan.consolidate();
        server.emitEvent('memory:consolidate', result);
        return result;
      },
    },

    // Pattern lifecycle
    {
      method: 'GET',
      path: '/api/patterns/:id/lifecycle',
      handler: async (req) => {
        const lifecycle = await titan.getPatternLifecycle(req.params.id);
        if (!lifecycle) {
          throw new Error('Pattern not found');
        }
        return lifecycle;
      },
    },

    // Forgetting risk
    {
      method: 'GET',
      path: '/api/forgetting-risk',
      handler: async () => titan.checkForgettingRisk(),
    },

    // Pending rehearsals
    {
      method: 'GET',
      path: '/api/rehearsals',
      handler: async () => titan.getPendingRehearsals(),
    },

    // Run rehearsal cycle
    {
      method: 'POST',
      path: '/api/rehearsals/run',
      handler: async () => {
        const result = await titan.runRehearsalCycle();
        server.emitEvent('rehearsal:complete', { count: result.length });
        return result;
      },
    },

    // Prune memories
    {
      method: 'POST',
      path: '/api/prune',
      handler: async (req) => {
        const body = req.body as { decayThreshold?: number; maxAge?: number };
        const result = await titan.prune(body);
        server.emitEvent('memory:prune', result);
        return result;
      },
    },

    // Curate to MEMORY.md
    {
      method: 'POST',
      path: '/api/curate',
      handler: async (req) => {
        const body = req.body as { content: string; section?: string };
        if (!body.content) {
          throw new Error('Content is required');
        }
        await titan.curate(body.content, body.section);
        server.emitEvent('memory:curate', { section: body.section });
        return { success: true };
      },
    },

    // ==================== FR-5: Context Monitoring ====================

    // Get current context status
    {
      method: 'GET',
      path: '/api/grade5/context-status',
      handler: async () => {
        const monitor = getContextMonitor();
        return monitor.getStatus();
      },
    },

    // Update context usage (for external integrations)
    {
      method: 'POST',
      path: '/api/grade5/context-status',
      handler: async (req) => {
        const body = req.body as {
          totalTokens: number;
          event?: string;
          agentId?: string;
        };

        if (typeof body.totalTokens !== 'number') {
          throw new Error('totalTokens is required');
        }

        const monitor = getContextMonitor();
        monitor.update(body.totalTokens, body.event, body.agentId);

        // Emit real-time update via WebSocket
        server.emitEvent('context:update', monitor.getStatus());

        return monitor.getStatus();
      },
    },

    // Configure context monitor
    {
      method: 'POST',
      path: '/api/grade5/context-config',
      handler: async (req) => {
        const body = req.body as {
          maxTokens?: number;
          warningThreshold?: number;
          criticalThreshold?: number;
        };

        const monitor = getContextMonitor();

        if (body.maxTokens !== undefined) {
          monitor.setMaxTokens(body.maxTokens);
        }

        if (body.warningThreshold !== undefined || body.criticalThreshold !== undefined) {
          monitor.setThresholds({
            warning: body.warningThreshold,
            critical: body.criticalThreshold,
          });
        }

        return monitor.getStatus();
      },
    },

    // Get context history for time range
    {
      method: 'GET',
      path: '/api/grade5/context-history',
      handler: async (req) => {
        const monitor = getContextMonitor();
        const startTime = req.query.start ? new Date(req.query.start) : new Date(Date.now() - 3600000); // Default: last hour
        const endTime = req.query.end ? new Date(req.query.end) : new Date();

        return {
          range: { start: startTime.toISOString(), end: endTime.toISOString() },
          snapshots: monitor.getHistoryRange(startTime, endTime),
        };
      },
    },

    // Get active context alerts
    {
      method: 'GET',
      path: '/api/grade5/context-alerts',
      handler: async () => {
        const monitor = getContextMonitor();
        return {
          alerts: monitor.getActiveAlerts(),
          total: monitor.getStatus().alerts.length,
        };
      },
    },

    // Acknowledge an alert
    {
      method: 'POST',
      path: '/api/grade5/context-alerts/:id/acknowledge',
      handler: async (req) => {
        const monitor = getContextMonitor();
        const acknowledged = monitor.acknowledgeAlert(req.params.id);
        return { success: acknowledged, alertId: req.params.id };
      },
    },

    // Clear acknowledged alerts
    {
      method: 'DELETE',
      path: '/api/grade5/context-alerts',
      handler: async () => {
        const monitor = getContextMonitor();
        const cleared = monitor.clearAcknowledgedAlerts();
        return { cleared };
      },
    },

    // Get proactive flush status
    {
      method: 'GET',
      path: '/api/grade5/proactive-flush',
      handler: async () => {
        const flushManager = getProactiveFlushManager();
        return flushManager.getStats();
      },
    },

    // Configure proactive flush
    {
      method: 'POST',
      path: '/api/grade5/proactive-flush',
      handler: async (req) => {
        const body = req.body as {
          enabled?: boolean;
          threshold?: number;
          debounceMs?: number;
        };

        const flushManager = getProactiveFlushManager();
        flushManager.configure(body);

        return flushManager.getStats();
      },
    },

    // Trigger manual flush
    {
      method: 'POST',
      path: '/api/grade5/proactive-flush/trigger',
      handler: async (req) => {
        const body = req.body as { contextRatio?: number };
        const flushManager = getProactiveFlushManager();
        const result = await flushManager.triggerManualFlush(body.contextRatio);

        if (result.flushed) {
          server.emitEvent('context:flush', result);
        }

        return result;
      },
    },

    // Reset context monitor
    {
      method: 'POST',
      path: '/api/grade5/context-reset',
      handler: async () => {
        const monitor = getContextMonitor();
        monitor.reset();
        server.emitEvent('context:reset', {});
        return { success: true };
      },
    },
  ];
}

/**
 * Generate markdown export from memory data
 */
function generateMarkdownExport(data: Awaited<ReturnType<TitanMemory['export']>>): string {
  const lines: string[] = [
    '# Titan Memory Export',
    '',
    `**Exported At:** ${data.exportedAt.toISOString()}`,
    `**Version:** ${data.version}`,
    '',
    '## Statistics',
    '',
    `- **Total Memories:** ${data.stats.totalMemories}`,
    `- **Factual:** ${data.stats.byLayer[MemoryLayer.FACTUAL]}`,
    `- **Long-Term:** ${data.stats.byLayer[MemoryLayer.LONG_TERM]}`,
    `- **Semantic:** ${data.stats.byLayer[MemoryLayer.SEMANTIC]}`,
    `- **Episodic:** ${data.stats.byLayer[MemoryLayer.EPISODIC]}`,
    '',
  ];

  for (const [layerName, memories] of Object.entries(data.layers)) {
    lines.push(`## ${layerName} Layer`, '');
    for (const memory of memories as MemoryEntry[]) {
      lines.push(`### ${memory.id.slice(0, 8)}`, '');
      lines.push(`**Timestamp:** ${memory.timestamp}`, '');
      lines.push('```');
      lines.push(memory.content);
      lines.push('```');
      if (memory.metadata?.tags) {
        lines.push(`**Tags:** ${(memory.metadata.tags as string[]).join(', ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
