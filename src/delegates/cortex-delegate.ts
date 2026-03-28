/**
 * CortexDelegate - Extracted from TitanMemory
 * Handles content classification, category summaries, drift monitoring, and intent guardrails
 */

import { CortexPipeline } from '../cortex/pipeline.js';
import { CategorySummarizer } from '../cortex/summarizer.js';
import { IntentGuardrails } from '../cortex/guardrails.js';
import { DriftMonitor } from '../cortex/drift-monitor.js';
import { ProjectHooksManager } from '../cortex/project-hooks.js';
import type { MemoryCategory, CategoryClassification } from '../cortex/types.js';
import { classifyContent } from '../cortex/classifier.js';

export class CortexDelegate {
  constructor(
    private getCortexPipeline: () => CortexPipeline | undefined,
    private getCategorySummarizer: () => CategorySummarizer | undefined,
    private getIntentGuardrails: () => IntentGuardrails | undefined,
    private getDriftMonitor: () => DriftMonitor | undefined,
    private getProjectHooks: () => ProjectHooksManager | undefined,
  ) {}

  /**
   * Classify content into a memory category
   */
  classifyContent(content: string): CategoryClassification {
    return classifyContent(content);
  }

  /**
   * Get category summary for a specific category
   */
  getCategorySummary(category: MemoryCategory): { category: string; summary: string; entryCount: number; version: number } | null {
    const summarizer = this.getCategorySummarizer();
    if (!summarizer) return null;
    const summary = summarizer.getSummary(category);
    if (!summary) return null;
    return {
      category: summary.category,
      summary: summary.summary,
      entryCount: summary.entryCount,
      version: summary.version,
    };
  }

  /**
   * Inspect a tool call via intent guardrails
   */
  inspectIntent(toolName: string, args: Record<string, unknown>): { action: string; reason: string; rule?: string } {
    const guardrails = this.getIntentGuardrails();
    if (!guardrails) {
      return { action: 'allow', reason: 'Guardrails not enabled' };
    }
    return guardrails.inspect(toolName, args);
  }

  /**
   * Record drift feedback for a categorized memory
   */
  recordDriftFeedback(memoryId: string, category: MemoryCategory, signal: 'helpful' | 'harmful'): void {
    const monitor = this.getDriftMonitor();
    if (monitor) {
      monitor.recordFeedback(memoryId, category, signal);
    }
  }

  /**
   * Get Cortex status for MIRAS stats
   */
  getCortexStatus(): {
    enabled: boolean;
    pipelineActive: boolean;
    guardrailsEnabled: boolean;
    driftMonitorEnabled: boolean;
    projectHooksEnabled: boolean;
    categorySummaries: number;
  } {
    const pipeline = this.getCortexPipeline();
    const guardrails = this.getIntentGuardrails();
    const monitor = this.getDriftMonitor();
    const hooks = this.getProjectHooks();
    const summarizer = this.getCategorySummarizer();
    return {
      enabled: !!pipeline,
      pipelineActive: pipeline?.isEnabled() ?? false,
      guardrailsEnabled: guardrails?.isEnabled() ?? false,
      driftMonitorEnabled: monitor?.isEnabled() ?? false,
      projectHooksEnabled: hooks?.isEnabled() ?? false,
      categorySummaries: summarizer?.getAllSummaries().length ?? 0,
    };
  }
}
