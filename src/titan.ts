/**
 * TitanMemory - Unified Cognitive Memory Manager
 * Orchestrates all 5 memory layers with intelligent routing
 *
 * Phase 3: Integrates Knowledge Graph, Decision Traces, World Models,
 * Behavioral Validation, and Adaptive Memory systems.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MemoryEntry,
  MemoryLayer,
  QueryOptions,
  QueryResult,
  UnifiedQueryResult,
  MemoryStats,
  CompactionContext,
  MemorySummary,
  ProactiveSuggestion,
  PatternMatchResult,
  TransferablePattern,
  ContextCaptureResult,
  HighlightedMemory,
} from './types.js';
import {
  BaseMemoryLayer,
  FactualMemoryLayer,
  LongTermMemoryLayer,
  SemanticMemoryLayer,
  EpisodicMemoryLayer,
} from './layers/index.js';
import {
  loadConfig,
  ensureDirectories,
  ensureProjectDirectories,
  listProjects,
} from './utils/config.js';
import { scoreImportance, calculatePatternBoost } from './utils/surprise.js';
import {
  UtilitySignal,
  applyFeedback,
  getUtilityTracker,
  weightByUtility,
  shouldPruneByUtility,
} from './utils/utility.js';

// Phase 3 imports
import { KnowledgeGraph, ExtractionResult, GraphQueryResult } from './graph/knowledge-graph.js';
import { DecisionTraceManager, DecisionTrace, DecisionQueryResult } from './trace/decision-trace.js';
import { WorldModel, MetaNode, WorldState, AggregationResult } from './world/world-model.js';
import { BehavioralValidator, ValidationReport, QualityScore } from './validation/behavioral-validator.js';
import { AdaptiveMemory, FusionResult } from './adaptive/adaptive-memory.js';
import { ContinualLearner } from './learning/continual-learner.js';

// Cortex imports
import { CortexPipeline } from './cortex/pipeline.js';
import { CategorySummarizer } from './cortex/summarizer.js';
import { IntentGuardrails } from './cortex/guardrails.js';
import { DriftMonitor } from './cortex/drift-monitor.js';
import { ProjectHooksManager } from './cortex/project-hooks.js';
import type { MemoryCategory, CategoryClassification, SufficiencyResult } from './cortex/types.js';
import { classifyContent } from './cortex/classifier.js';
import { checkSufficiency, getRelevantCategories } from './cortex/retrieval.js';

// MIRAS Enhancement imports
import { createEmbeddingGenerator, IEmbeddingGenerator } from './storage/index.js';
import { SemanticHighlighter, createSemanticHighlighter } from './utils/semantic-highlight.js';
import { createSurpriseCalculator, ISurpriseCalculator } from './utils/semantic-surprise.js';
import { DecayCalculator, createDecayCalculator } from './utils/decay-strategies.js';
import { ContextCaptureManager, createContextCaptureManager } from './utils/context-capture.js';
import { AutoConsolidationManager, createAutoConsolidationManager } from './adaptive/auto-consolidation.js';
import { ProactiveSuggestionsManager, createProactiveSuggestionsManager } from './mcp/proactive-suggestions.js';
import { CrossProjectLearningManager, createCrossProjectLearningManager } from './learning/cross-project.js';
import { PatternMatcher, createPatternMatcher } from './learning/pattern-matcher.js';

// v2.0 imports
import { NoopLogger, NoopReason, NoopDecision, NoopStats, getNoopLogger } from './trace/noop-log.js';
// v2.1 LLM Turbo Layer
import { LLMClient } from './llm/client.js';
import {
  IntentDetector,
  QueryIntent,
  QueryIntentType,
  getSearchConfig,
  getIntentDetector
} from './retrieval/intent.js';
import {
  CausalGraph,
  CausalEdge,
  CausalChain,
  ExplanationTree,
  CausalRelationType,
  CausalGraphStats,
  getCausalGraph
} from './graphs/causal.js';
import {
  WorkingMemory,
  FocusItem,
  WorkingMemoryState,
  getWorkingMemory
} from './layers/working.js';

/**
 * Gating decisions for intelligent routing
 */
interface GatingDecision {
  layers: MemoryLayer[];
  priority: MemoryLayer;
  reason: string;
}

export class TitanMemory {
  private factualLayer: FactualMemoryLayer;
  private longTermLayer: LongTermMemoryLayer;
  private semanticLayer: SemanticMemoryLayer;
  private episodicLayer: EpisodicMemoryLayer;
  private layers: Map<MemoryLayer, BaseMemoryLayer>;
  private initialized: boolean = false;

  // Project isolation
  private activeProjectId?: string;

  // Phase 3: Cognitive Enhancement Systems
  private knowledgeGraph: KnowledgeGraph;
  private decisionTracer: DecisionTraceManager;
  private worldModel: WorldModel;
  private validator: BehavioralValidator;
  private adaptiveMemory: AdaptiveMemory;
  private continualLearner: ContinualLearner;

  // Cortex Systems
  private cortexPipeline?: CortexPipeline;
  private categorySummarizer?: CategorySummarizer;
  private intentGuardrails?: IntentGuardrails;
  private driftMonitor?: DriftMonitor;
  private projectHooks?: ProjectHooksManager;

  // MIRAS Enhancement Systems
  private embeddingGenerator?: IEmbeddingGenerator;
  private semanticHighlighter?: SemanticHighlighter;
  private surpriseCalculator?: ISurpriseCalculator;
  private decayCalculator?: DecayCalculator;
  private contextCaptureManager?: ContextCaptureManager;
  private autoConsolidationManager?: AutoConsolidationManager;
  private proactiveSuggestionsManager?: ProactiveSuggestionsManager;
  private crossProjectLearner?: CrossProjectLearningManager;
  private patternMatcher?: PatternMatcher;

  // v2.1: LLM Turbo Layer
  private llmClient?: LLMClient;

  // v2.0: NOOP Logger
  private noopLogger: NoopLogger;

  // v2.0: Intent Detector
  private intentDetector: IntentDetector;

  // v2.0: Causal Graph
  private causalGraph: CausalGraph;

  // v2.0: Working Memory
  private workingMemory: WorkingMemory;

  constructor(configPath?: string, projectId?: string) {
    loadConfig(configPath);
    ensureDirectories();

    // Set active project and ensure project directories exist
    this.activeProjectId = projectId;
    if (projectId) {
      ensureProjectDirectories(projectId);
    }

    // Create layers with project isolation
    this.factualLayer = new FactualMemoryLayer(projectId);
    this.longTermLayer = new LongTermMemoryLayer(projectId);
    this.semanticLayer = new SemanticMemoryLayer(projectId);
    this.episodicLayer = new EpisodicMemoryLayer(projectId);

    this.layers = new Map<MemoryLayer, BaseMemoryLayer>([
      [MemoryLayer.FACTUAL, this.factualLayer as BaseMemoryLayer],
      [MemoryLayer.LONG_TERM, this.longTermLayer as BaseMemoryLayer],
      [MemoryLayer.SEMANTIC, this.semanticLayer as BaseMemoryLayer],
      [MemoryLayer.EPISODIC, this.episodicLayer as BaseMemoryLayer],
    ]);

    // Phase 3: Initialize cognitive systems
    this.knowledgeGraph = new KnowledgeGraph();
    this.decisionTracer = new DecisionTraceManager();
    this.worldModel = new WorldModel();
    this.validator = new BehavioralValidator();
    this.adaptiveMemory = new AdaptiveMemory();
    this.continualLearner = new ContinualLearner();

    // v2.0: Initialize NOOP logger
    this.noopLogger = getNoopLogger();

    // v2.0: Initialize Intent Detector
    this.intentDetector = getIntentDetector();

    // v2.0: Initialize Causal Graph
    this.causalGraph = getCausalGraph();

    // v2.0: Initialize Working Memory
    this.workingMemory = getWorkingMemory();

    // MIRAS Enhancements: Initialize based on config
    this.initializeMirasEnhancements();

    // Cortex: Initialize if enabled
    this.initializeCortex();
  }

  /**
   * Initialize MIRAS enhancement systems based on configuration
   */
  private initializeMirasEnhancements(): void {
    const config = loadConfig();

    // Feature 1: Embedding generator (with caching)
    if (config.embedding.provider !== 'hash') {
      try {
        this.embeddingGenerator = createEmbeddingGenerator(config.embedding);
      } catch (error) {
        console.warn('Failed to create embedding generator, falling back to hash:', error);
      }
    }

    // Feature 1b: Semantic highlighting
    if (config.semanticHighlight.enabled) {
      this.semanticHighlighter = createSemanticHighlighter(
        config.semanticHighlight,
        this.embeddingGenerator
      );
    }

    // Feature 2: Semantic surprise calculator
    this.surpriseCalculator = createSurpriseCalculator(
      config.semanticSurprise,
      this.embeddingGenerator
    );

    // Feature 3: Data-dependent decay calculator
    this.decayCalculator = createDecayCalculator(config.dataDependentDecay);

    // Feature 4: Auto context capture
    if (config.contextCapture.enabled) {
      this.contextCaptureManager = createContextCaptureManager(config.contextCapture);
    }

    // Feature 5: Auto consolidation
    if (config.autoConsolidation.enabled) {
      this.autoConsolidationManager = createAutoConsolidationManager(config.autoConsolidation);
    }

    // Feature 6: Proactive suggestions
    if (config.proactiveSuggestions.enabled) {
      this.proactiveSuggestionsManager = createProactiveSuggestionsManager(
        config.proactiveSuggestions,
        this.embeddingGenerator
      );
    }

    // Feature 7: Cross-project learning
    if (config.crossProject.enabled) {
      this.crossProjectLearner = createCrossProjectLearningManager(config.crossProject);
      this.patternMatcher = createPatternMatcher(this.embeddingGenerator);
    }
  }

  /**
   * Initialize Cortex systems based on configuration
   */
  private initializeCortex(): void {
    const config = loadConfig();
    const cortexConfig = config.cortex;

    if (!cortexConfig?.enabled) return;

    try {
      // Core pipeline (uses existing semantic highlighter)
      this.cortexPipeline = new CortexPipeline(
        cortexConfig,
        this.semanticHighlighter
      );

      // v2.1: LLM Turbo Layer — inject into pipeline if enabled
      if (config.llm?.enabled) {
        try {
          this.llmClient = new LLMClient(config.llm);
          if (this.llmClient.isAvailable()) {
            this.cortexPipeline.setLLMClient(this.llmClient, config.llm);
          }
        } catch (error) {
          console.warn('Failed to initialize LLM Turbo Layer:', error);
          this.llmClient = undefined;
        }
      }

      // Category summarizer
      this.categorySummarizer = new CategorySummarizer();

      // Intent guardrails
      if (cortexConfig.enableGuardrails) {
        this.intentGuardrails = new IntentGuardrails(cortexConfig);
      }

      // Drift monitor
      if (cortexConfig.enableDriftMonitor) {
        this.driftMonitor = new DriftMonitor({
          enabled: true,
          alertThreshold: 0.7,
        });
      }

      // Project hooks
      if (cortexConfig.enableProjectHooks) {
        this.projectHooks = new ProjectHooksManager({
          enabled: true,
        });
      }
    } catch (error) {
      console.warn('Failed to initialize Cortex:', error);
      this.cortexPipeline = undefined;
    }
  }

  /**
   * Get the current active project ID
   */
  getActiveProject(): string | undefined {
    return this.activeProjectId;
  }

  /**
   * Set the active project - recreates all layer instances with new project isolation
   * This is a heavy operation and should be called sparingly
   * @param projectId - The project ID to switch to, or undefined for default
   */
  async setActiveProject(projectId?: string): Promise<void> {
    // Skip if already on this project
    if (this.activeProjectId === projectId) {
      return;
    }

    // Close existing layers if initialized
    if (this.initialized) {
      await this.close();
    }

    // Update active project
    this.activeProjectId = projectId;

    // Ensure project directories exist
    if (projectId) {
      ensureProjectDirectories(projectId);
    }

    // Recreate all layers with new projectId
    this.factualLayer = new FactualMemoryLayer(projectId);
    this.longTermLayer = new LongTermMemoryLayer(projectId);
    this.semanticLayer = new SemanticMemoryLayer(projectId);
    this.episodicLayer = new EpisodicMemoryLayer(projectId);

    this.layers = new Map<MemoryLayer, BaseMemoryLayer>([
      [MemoryLayer.FACTUAL, this.factualLayer as BaseMemoryLayer],
      [MemoryLayer.LONG_TERM, this.longTermLayer as BaseMemoryLayer],
      [MemoryLayer.SEMANTIC, this.semanticLayer as BaseMemoryLayer],
      [MemoryLayer.EPISODIC, this.episodicLayer as BaseMemoryLayer],
    ]);

    // Mark as not initialized so next operation triggers initialization
    this.initialized = false;
  }

  /**
   * List all available projects
   */
  static listProjects(): string[] {
    return listProjects();
  }

  /**
   * Initialize all memory layers and Phase 3 systems
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const initPromises = [
      // Core layers
      this.factualLayer.initialize(),
      this.longTermLayer.initialize(),
      this.semanticLayer.initialize(),
      this.episodicLayer.initialize(),
      // Phase 3 systems
      this.knowledgeGraph.initialize(),
      this.decisionTracer.initialize(),
      this.worldModel.initialize(),
      this.validator.initialize(),
      this.adaptiveMemory.initialize(),
      this.continualLearner.initialize(),
      // v2.0: Causal Graph
      this.causalGraph.initialize(),
      // v2.0: Working Memory
      this.workingMemory.initialize(),
    ];

    // MIRAS: Add cross-project learner initialization
    if (this.crossProjectLearner) {
      initPromises.push(this.crossProjectLearner.initialize());
    }

    await Promise.all(initPromises);

    this.initialized = true;
  }

  /**
   * Intelligent routing - decide which layers to use
   * v2.0: Now uses intent detection for optimized routing
   */
  private gateQuery(content: string): GatingDecision {
    // v2.0: Use intent detector for intelligent routing
    const intent = this.intentDetector.detect(content);
    const searchConfig = getSearchConfig(intent);

    // Always include LONG_TERM layer for Zilliz vector search
    // Local layers use weak LSH matching; LONG_TERM uses real Voyage embeddings
    const layers = searchConfig.layers.includes(MemoryLayer.LONG_TERM)
      ? searchConfig.layers
      : [...searchConfig.layers, MemoryLayer.LONG_TERM];

    // Convert intent to gating decision
    return {
      layers,
      priority: intent.priorityLayer,
      reason: intent.explanation,
    };
  }


  /**
   * Intelligent routing - decide which layer to store in
   */
  private gateStore(content: string): GatingDecision {
    const importance = scoreImportance(content);
    const patternBoost = calculatePatternBoost(content);
    const lower = content.toLowerCase();

    // High importance + patterns = semantic layer
    if (importance > 0.7 || patternBoost > 0.3) {
      return {
        layers: [MemoryLayer.SEMANTIC, MemoryLayer.LONG_TERM],
        priority: MemoryLayer.SEMANTIC,
        reason: 'High-value pattern detected',
      };
    }

    // Factual definitions - always include LONG_TERM for Zilliz vector indexing
    if (/\b(?:is defined as|means|refers to|is a|is the)\b/.test(lower)) {
      return {
        layers: [MemoryLayer.FACTUAL, MemoryLayer.LONG_TERM],
        priority: MemoryLayer.FACTUAL,
        reason: 'Factual definition',
      };
    }

    // Episode/event markers - require temporal or specific event context
    // More strict: must have date/time context OR be a significant event verb
    const hasTemporalContext = /\b(?:yesterday|today|last week|on \w+day|in \w+ \d{4}|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2})\b/.test(lower);
    const isSignificantEvent = /\b(?:deployed|released|launched|shipped|merged|committed|incident|outage|milestone|achieved|discovered|resolved|fixed bug|production)\b/.test(lower);
    const hasEventVerb = /\b(?:happened|occurred)\b/.test(lower); // Only strong event verbs, not "did/started/finished"

    if (hasTemporalContext || isSignificantEvent || hasEventVerb) {
      return {
        layers: [MemoryLayer.EPISODIC, MemoryLayer.LONG_TERM],
        priority: MemoryLayer.EPISODIC,
        reason: 'Event/episode with temporal or significance markers',
      };
    }

    // Default to long-term with surprise filtering
    return {
      layers: [MemoryLayer.LONG_TERM],
      priority: MemoryLayer.LONG_TERM,
      reason: 'Default storage with surprise filtering',
    };
  }

  /**
   * Add a memory (with intelligent routing and Phase 3 processing)
   */
  async add(
    content: string,
    metadata?: Partial<MemoryEntry['metadata']>
  ): Promise<MemoryEntry> {
    // Input validation
    if (typeof content !== 'string') {
      throw new Error('Content must be a string');
    }
    if (content.trim().length === 0) {
      throw new Error('Content cannot be empty');
    }
    if (content.length > 100000) {
      throw new Error('Content exceeds maximum length of 100,000 characters');
    }
    if (metadata !== undefined && metadata !== null && typeof metadata !== 'object') {
      throw new Error('Metadata must be an object or undefined');
    }

    if (!this.initialized) await this.initialize();

    const decision = this.gateStore(content);

    // Cortex Hook 1: Classify content and enrich metadata
    let cortexMeta: Record<string, unknown> = {};
    if (this.cortexPipeline) {
      try {
        const pipelineResult = await this.cortexPipeline.processForStore(content);
        cortexMeta = pipelineResult.enrichedMetadata;
      } catch (error) {
        // Cortex failures are non-blocking
        console.warn('Cortex classification failed:', error);
      }
    }

    // Phase 3: Get context inheritance from world model
    const activeContext = this.worldModel.getWorldState().activeContext;
    const inheritance = await this.worldModel.getContextInheritance(activeContext);
    const inheritedTags = inheritance?.inheritedTags || [];

    // Generate a shared ID so all layers use the same ID for this memory
    const sharedId = uuidv4();

    const entry = {
      id: sharedId,
      content,
      timestamp: new Date(),
      metadata: {
        ...metadata,
        ...cortexMeta,
        routingReason: decision.reason,
        tags: [...(metadata?.tags || []), ...inheritedTags],
      },
    };

    // Phase 3: Validate before storing (skip in rawMode to remove overhead)
    const isRawMode = loadConfig().rawMode;
    if (!isRawMode) {
      const validation = await this.validator.validateBeforeStore(entry as MemoryEntry);
      if (!validation.valid) {
        console.warn('Memory validation issues:', validation.issues.map(i => i.description));
      }
    }

    // Store in primary layer
    const layer = this.layers.get(decision.priority)!;
    const result = await layer.store(entry);

    // Optionally store in secondary layers
    for (const layerId of decision.layers) {
      if (layerId !== decision.priority) {
        try {
          await this.layers.get(layerId)!.store(entry);
        } catch {
          // Secondary storage failures are acceptable
        }
      }
    }

    // v2.0: Record memory write for NOOP ratio tracking
    if (!isRawMode) {
      this.noopLogger.recordMemoryWrite().catch(() => {});
    }

    // Phase 3: Post-storage processing (skip in rawMode — removes graph extraction,
    // decision tracing, world model linking, continual learning, forgetting risk checks)
    if (!isRawMode) {
      this.processPostStore(result, content).catch(error => {
        console.error('Post-store processing failed:', {
          memoryId: result.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return result;
  }

  /**
   * Phase 3: Process after storage (entity extraction, context linking, continual learning)
   */
  private async processPostStore(memory: MemoryEntry, content: string): Promise<void> {
    try {
      // Extract entities and relationships
      await this.knowledgeGraph.extract(content, memory.id);

      // Extract decision traces if present
      await this.decisionTracer.extractFromContent(content, {
        projectId: memory.metadata?.projectId as string,
        sessionId: memory.metadata?.sessionId as string,
      });

      // Detect and link to relevant contexts
      const contexts = await this.worldModel.detectContext(content);
      for (const context of contexts.slice(0, 3)) {
        await this.worldModel.linkMemory(context.id, memory.id, memory.layer);
      }

      // Record memory activity
      await this.worldModel.recordMemoryActivity(memory.id);

      // Process for continual learning
      await this.continualLearner.processNewMemory(memory);

      // Cortex Hook 2: Update category summaries
      if (this.categorySummarizer && memory.metadata?.category) {
        try {
          this.categorySummarizer.updateSummary(
            memory.metadata.category as MemoryCategory,
            content
          );
        } catch {
          // Non-critical
        }
      }

      // Check for catastrophic forgetting
      const forgettingRisk = await this.continualLearner.checkForgettingRisk();
      if (forgettingRisk.alert) {
        console.warn('Forgetting risk detected:', forgettingRisk.riskLevel, forgettingRisk.affectedPatterns.length, 'patterns affected');
      }
    } catch (error) {
      // Non-critical, log and continue
      console.warn('Post-store processing error:', error);
    }
  }

  /**
   * Store directly to a specific layer (bypass routing)
   */
  async addToLayer(
    layer: MemoryLayer,
    content: string,
    metadata?: Partial<MemoryEntry['metadata']>
  ): Promise<MemoryEntry> {
    if (!this.initialized) await this.initialize();

    const targetLayer = this.layers.get(layer);
    if (!targetLayer) {
      throw new Error(`Invalid layer: ${layer}`);
    }

    const result = await targetLayer.store({
      content,
      timestamp: new Date(),
      metadata: metadata || {},
    });

    // Mirror to LONG_TERM for Zilliz-powered retrieval (local layers have weak search)
    if (layer !== MemoryLayer.LONG_TERM) {
      const longTermLayer = this.layers.get(MemoryLayer.LONG_TERM);
      if (longTermLayer) {
        try {
          await longTermLayer.store({
            id: result.id,
            content,
            timestamp: new Date(),
            metadata: { ...(metadata || {}), originalLayer: layer },
          });
        } catch {
          // Mirror failure is non-blocking
        }
      }
    }

    return result;
  }

  /**
   * Query memories (with intelligent routing, fusion, and Phase 3 enhancements)
   * FR-1: Results weighted by utility score
   * FR-2: Supports progressive disclosure modes (full/summary/metadata)
   */
  async recall(query: string, options?: QueryOptions): Promise<UnifiedQueryResult | { summaries: MemorySummary[]; totalQueryTimeMs: number }> {
    if (!this.initialized) await this.initialize();

    const startTime = performance.now();
    const decision = this.gateQuery(query);
    const targetLayers = options?.layers || decision.layers;
    const limit = options?.limit || 10;
    const mode = options?.mode || 'full';

    // Query all target layers with bounded concurrency
    const allResults: (QueryResult | null)[] = [];
    const concurrencyLimit = 5;
    for (let i = 0; i < targetLayers.length; i += concurrencyLimit) {
      const chunk = targetLayers.slice(i, i + concurrencyLimit);
      const chunkResults = await Promise.all(chunk.map(layerId => {
        const layer = this.layers.get(layerId);
        if (!layer) return Promise.resolve(null);
        return layer.query(query, { ...options, limit: limit * 2 }); // Get extra for fusion
      }));
      allResults.push(...chunkResults);
    }

    const results = allResults.filter(
      (r): r is QueryResult => r !== null
    );

    // Fuse results with priority weighting
    let fusedMemories = this.fuseResults(results, decision.priority, limit);

    // Restore originalLayer for memories mirrored to LONG_TERM via addToLayer
    for (const mem of fusedMemories) {
      if (mem.metadata?.originalLayer != null) {
        mem.layer = mem.metadata.originalLayer as MemoryLayer;
      }
    }

    // FR-1: Apply utility weighting to results
    const baseScores = fusedMemories.map((_, idx) => 1.0 - (idx * 0.05)); // Position-based scores
    const weightedResults = weightByUtility(fusedMemories, baseScores);
    weightedResults.sort((a, b) => b.weightedScore - a.weightedScore);
    fusedMemories = weightedResults.map(w => w.memory).slice(0, limit);

    // Phase 3: Prioritize using adaptive memory (skip in rawMode to remove reordering overhead)
    const isRawRecall = loadConfig().rawMode;
    if (!isRawRecall) {
      fusedMemories = await this.adaptiveMemory.prioritizeForRecall(
        fusedMemories,
        query,
        limit
      );

      // Phase 3: Record access for each returned memory
      for (const memory of fusedMemories) {
        await this.adaptiveMemory.recordAccess(memory.id, query);
      }
    }

    // Cortex Hook 3: Enrich results with category info
    if (this.cortexPipeline) {
      try {
        for (const memory of fusedMemories) {
          if (!memory.metadata.category) {
            const classification = classifyContent(memory.content);
            memory.metadata.category = classification.category;
            memory.metadata.categoryConfidence = classification.confidence;
          }
        }
      } catch {
        // Non-critical
      }
    }

    // Cortex Hook 4: Run Librarian pipeline - semantic highlight, prune, reconstruct
    const config = loadConfig();
    let highlightedContext: string | undefined;
    let highlightStats: UnifiedQueryResult['highlightStats'] | undefined;

    if (this.cortexPipeline && config.semanticHighlight?.highlightOnRecall !== false) {
      try {
        const librarianResult = await this.cortexPipeline.processForRecall(query, fusedMemories);
        if (librarianResult.goldSentences.length > 0) {
          highlightedContext = librarianResult.goldSentences.map(s => s.text).join(' ');
          highlightStats = {
            totalSentences: librarianResult.totalSentences,
            goldSentences: librarianResult.goldSentences.length,
            prunedCount: librarianResult.prunedCount,
            compressionRate: librarianResult.compressionRate,
          };

          // v2.1: When LLM rerank is active, blend gold sentence scores with original ranking
          // Skip reranking for temporal queries to preserve time ordering
          if (config.llm?.enabled && config.llm?.rerankEnabled) {
            const queryIntent = this.intentDetector.detect(query);
            // Temporal queries rely on time-based ordering — don't let LLM disrupt it
            if (queryIntent.type !== 'timeline_query') {
              const memoryScores = new Map<string, number>();
              for (const gs of librarianResult.goldSentences) {
                const current = memoryScores.get(gs.sourceMemoryId) || 0;
                memoryScores.set(gs.sourceMemoryId, Math.max(current, gs.score));
              }
              if (memoryScores.size > 0) {
                const originalRank = new Map(fusedMemories.map((m, i) => [m.id, i]));
                const total = fusedMemories.length;

                fusedMemories.sort((a, b) => {
                  const llmA = memoryScores.get(a.id) ?? 0;
                  const llmB = memoryScores.get(b.id) ?? 0;
                  const origA = 1 - (originalRank.get(a.id) ?? total) / total;
                  const origB = 1 - (originalRank.get(b.id) ?? total) / total;
                  // 60% LLM semantic + 40% original ordering
                  return (llmB * 0.6 + origB * 0.4) - (llmA * 0.6 + origA * 0.4);
                });
              }
            }
          }
        }
      } catch {
        // Non-critical - continue without highlighting
      }
    }

    const totalQueryTimeMs = performance.now() - startTime;

    // FR-2: Progressive disclosure - return based on mode
    if (mode === 'metadata' || mode === 'summary') {
      const summaries: MemorySummary[] = fusedMemories.map((memory, idx) => ({
        id: memory.id,
        summary: mode === 'summary'
          ? memory.content.substring(0, 100) + (memory.content.length > 100 ? '...' : '')
          : '',
        tags: (memory.metadata.tags as string[]) || [],
        layer: memory.layer,
        relevanceScore: weightedResults[idx]?.weightedScore || 0,
        tokenEstimate: Math.ceil(memory.content.length / 4), // Rough token estimate
        timestamp: memory.timestamp,
        utilityScore: memory.metadata.utilityScore as number | undefined,
      }));

      return {
        summaries,
        totalQueryTimeMs,
      };
    }

    return {
      results,
      fusedMemories,
      totalQueryTimeMs,
      highlightedContext,
      highlightStats,
    };
  }

  /**
   * Fuse results from multiple layers with intelligent ranking
   */
  private fuseResults(
    results: QueryResult[],
    priorityLayer: MemoryLayer,
    limit: number
  ): MemoryEntry[] {
    const allMemories: Array<{ memory: MemoryEntry; score: number }> = [];

    for (const result of results) {
      // LONG_TERM layer uses Voyage embeddings (real semantic search) — always boost it
      const isPriority = result.layer === priorityLayer;
      const isLongTerm = result.layer === MemoryLayer.LONG_TERM;
      const layerWeight = (isPriority || isLongTerm) ? 1.5 : 1.0;
      const positionDecay = 0.9; // Fallback for layers without searchScore

      result.memories.forEach((memory, idx) => {
        // Use effectiveScore (includes recency tiebreak) when available,
        // fall back to searchScore (raw reranker/Zilliz), then position-based for local layers
        const effectiveScore = memory.metadata?.effectiveScore as number | undefined;
        const searchScore = memory.metadata?.searchScore as number | undefined;
        const baseScore = effectiveScore ?? searchScore ?? Math.pow(positionDecay, idx);
        const score = layerWeight * baseScore;
        allMemories.push({ memory, score });
      });
    }

    // Sort by score and deduplicate by content similarity
    allMemories.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const fused: MemoryEntry[] = [];

    for (const { memory } of allMemories) {
      // Use full content hash for deduplication to avoid collision on documents with same prefix
      const contentKey = this.hashContent(memory.content);
      if (!seen.has(contentKey)) {
        seen.add(contentKey);
        fused.push(memory);
        if (fused.length >= limit) break;
      }
    }

    return fused;
  }

  /**
   * Generate a hash for content deduplication
   * Uses a simple but effective string hashing algorithm
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Include length to further reduce collisions
    return `${hash.toString(36)}_${content.length}`;
  }

  /**
   * Get a specific memory by ID
   */
  async get(id: string): Promise<MemoryEntry | null> {
    if (!this.initialized) await this.initialize();

    // Search through all layers
    for (const layer of this.layers.values()) {
      const memory = await layer.get(id);
      if (memory) return memory;
    }

    return null;
  }

  /**
   * Delete a memory from ALL layers (memories may exist in multiple layers)
   */
  async delete(id: string): Promise<boolean> {
    if (!this.initialized) await this.initialize();

    let deletedFromAny = false;

    // Delete from ALL layers since memories can be stored in multiple layers
    for (const layer of this.layers.values()) {
      try {
        const deleted = await layer.delete(id);
        if (deleted) deletedFromAny = true;
      } catch (error) {
        // Log but continue - try to delete from all layers
        console.error(`Delete failed in layer: ${error}`);
      }
    }

    return deletedFromAny;
  }

  /**
   * Pre-compaction flush - save important context before compaction
   */
  async flushPreCompaction(context: CompactionContext): Promise<MemoryEntry[]> {
    if (!this.initialized) await this.initialize();

    // Use episodic layer's specialized flush
    return this.episodicLayer.flushPreCompaction(context);
  }

  /**
   * Add to curated MEMORY.md
   */
  async curate(content: string, section?: string): Promise<void> {
    if (!this.initialized) await this.initialize();

    await this.episodicLayer.addToCurated(content, section);
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<MemoryStats> {
    if (!this.initialized) await this.initialize();

    const [factualCount, longTermCount, semanticCount, episodicCount, availableDates] =
      await Promise.all([
        this.factualLayer.count(),
        this.longTermLayer.count(),
        this.semanticLayer.count(),
        this.episodicLayer.count(),
        this.episodicLayer.getAvailableDates(),
      ]);

    const totalMemories =
      factualCount + longTermCount + semanticCount + episodicCount;

    // Dates are returned newest-first; last entry is oldest
    const oldestMemory = availableDates.length > 0
      ? new Date(availableDates[availableDates.length - 1])
      : new Date();
    const newestMemory = availableDates.length > 0
      ? new Date(availableDates[0])
      : new Date();

    const projectKey = this.activeProjectId || 'default';

    return {
      totalMemories,
      byLayer: {
        [MemoryLayer.WORKING]: 0, // Managed by LLM
        [MemoryLayer.FACTUAL]: factualCount,
        [MemoryLayer.LONG_TERM]: longTermCount,
        [MemoryLayer.SEMANTIC]: semanticCount,
        [MemoryLayer.EPISODIC]: episodicCount,
      },
      avgSurpriseScore: 0, // Requires O(n) scan across all memories
      avgRetrievalTimeMs: 0, // Requires query-time instrumentation
      oldestMemory,
      newestMemory,
      projectCounts: { [projectKey]: totalMemories },
      storageBytes: 0, // Requires storage-layer API
    };
  }

  /**
   * Prune old/decayed memories
   * FR-1: Also prunes memories with low utility scores
   */
  async prune(options?: {
    decayThreshold?: number;
    maxAge?: number; // days
    utilityThreshold?: number; // FR-1: Utility threshold for pruning
  }): Promise<{ pruned: number; prunedByDecay: number; prunedByUtility: number }> {
    if (!this.initialized) await this.initialize();

    let prunedByDecay = 0;
    let prunedByUtility = 0;

    // Prune long-term layer by decay
    prunedByDecay = await this.longTermLayer.pruneDecayed(
      options?.decayThreshold || 0.05
    );

    // FR-1: Prune by utility score
    if (options?.utilityThreshold !== undefined) {
      // Get all memories and check utility
      for (const layer of this.layers.values()) {
        const result = await layer.query('', { limit: 1000 });
        for (const memory of result.memories) {
          if (shouldPruneByUtility(memory.metadata, options.utilityThreshold)) {
            const deleted = await layer.delete(memory.id);
            if (deleted) prunedByUtility++;
          }
        }
      }
    }

    return {
      pruned: prunedByDecay + prunedByUtility,
      prunedByDecay,
      prunedByUtility,
    };
  }

  /**
   * FR-1: Record utility feedback for a memory
   * @param id - Memory ID
   * @param signal - 'helpful' or 'harmful'
   * @param sessionId - Optional session ID for idempotency
   * @param context - Optional context about why helpful/harmful
   */
  async recordFeedback(
    id: string,
    signal: UtilitySignal,
    sessionId?: string,
    context?: string
  ): Promise<{
    success: boolean;
    memoryId: string;
    signal: UtilitySignal;
    newUtilityScore?: number;
    message?: string;
  }> {
    if (!this.initialized) await this.initialize();

    // Find the memory
    const memory = await this.get(id);
    if (!memory) {
      return {
        success: false,
        memoryId: id,
        signal,
        message: `Memory not found: ${id}`,
      };
    }

    // Check for duplicate feedback in same session
    const tracker = getUtilityTracker();
    const recorded = tracker.recordFeedback(id, signal, sessionId, context);

    if (!recorded) {
      return {
        success: false,
        memoryId: id,
        signal,
        newUtilityScore: memory.metadata.utilityScore as number | undefined,
        message: 'Feedback already recorded in this session (idempotent)',
      };
    }

    // Apply the feedback to the memory metadata
    const updatedMetadata = applyFeedback(memory.metadata, signal);

    // Update the memory in its layer
    // We need to find which layer it's in and update it
    for (const [, layer] of this.layers) {
      const existingMemory = await layer.get(id);
      if (existingMemory) {
        // Update the memory with new metadata
        // First delete, then re-store with updated metadata
        await layer.delete(id);
        await layer.store({
          content: existingMemory.content,
          timestamp: existingMemory.timestamp,
          metadata: updatedMetadata,
        });
        break;
      }
    }

    return {
      success: true,
      memoryId: id,
      signal,
      newUtilityScore: updatedMetadata.utilityScore,
    };
  }

  /**
   * Get today's episodic entries
   */
  async getToday(): Promise<MemoryEntry[]> {
    if (!this.initialized) await this.initialize();
    return this.episodicLayer.getToday();
  }

  /**
   * Generate daily summary
   */
  async summarizeDay(date?: string): Promise<string> {
    if (!this.initialized) await this.initialize();

    const targetDate = date || new Date().toISOString().split('T')[0];
    return this.episodicLayer.generateDailySummary(targetDate);
  }

  /**
   * Get hash statistics (factual layer)
   */
  async getHashStats(): Promise<{
    totalHashes: number;
    avgEntriesPerHash: number;
    collisionRate: number;
  }> {
    if (!this.initialized) await this.initialize();
    return this.factualLayer.getHashStats();
  }

  /**
   * Get semantic pattern stats
   */
  async getPatternStats(): Promise<{
    byType: Record<string, number>;
    byFrequency: Record<string, number>;
  }> {
    if (!this.initialized) await this.initialize();

    const [typeStats, freqStats] = await Promise.all([
      this.semanticLayer.getTypeStats(),
      this.semanticLayer.getFrequencyStats(),
    ]);

    return {
      byType: typeStats,
      byFrequency: freqStats,
    };
  }

  /**
   * Get available episodic dates
   */
  async getAvailableDates(): Promise<string[]> {
    if (!this.initialized) await this.initialize();
    return this.episodicLayer.getAvailableDates();
  }

  /**
   * Get current momentum (from long-term layer)
   */
  getCurrentMomentum(): number {
    return this.longTermLayer.getCurrentMomentum();
  }

  /**
   * Export all memories
   */
  async export(): Promise<{
    version: string;
    exportedAt: Date;
    stats: MemoryStats;
    layers: Record<string, MemoryEntry[]>;
  }> {
    if (!this.initialized) await this.initialize();

    const stats = await this.getStats();
    const layers: Record<string, MemoryEntry[]> = {};

    // Export each layer
    for (const [layerId, layer] of this.layers) {
      const result = await layer.query('', { limit: 10000 });
      layers[MemoryLayer[layerId]] = result.memories;
    }

    return {
      version: '1.0.0',
      exportedAt: new Date(),
      stats,
      layers,
    };
  }

  // ==================== Phase 4: Compression ====================

  /**
   * Compress a memory by ID into a structured compressed representation
   * Uses SimpleMem-style entity extraction, relationship distilling,
   * and extractive summarization.
   */
  async compress(
    memoryId: string,
    options?: import('./compression/types.js').CompressionOptions
  ): Promise<import('./compression/types.js').CompressedMemory> {
    const memory = await this.get(memoryId);
    if (!memory) {
      throw new Error(`Memory not found: ${memoryId}`);
    }
    const { compressMemory } = await import('./compression/compressor.js');
    const config = loadConfig();
    const llm = (config.llm?.enabled && config.llm?.summarizeEnabled) ? this.llmClient : undefined;
    return compressMemory(memory.content, options, llm);
  }

  /**
   * Expand a compressed memory back into readable text
   */
  async expand(
    compressed: import('./compression/types.js').CompressedMemory,
    options?: import('./compression/types.js').ExpansionOptions
  ): Promise<import('./compression/types.js').ExpandedMemory> {
    const { expandMemory } = await import('./compression/expander.js');
    return expandMemory(compressed, options);
  }

  /**
   * Close all layers, Phase 3 systems, and MIRAS systems
   */
  async close(): Promise<void> {
    const closePromises: Promise<void>[] = [
      // Core layers
      ...[...this.layers.values()].map(l => l.close()),
      // Phase 3 systems
      this.knowledgeGraph.close(),
      this.decisionTracer.close(),
      this.worldModel.close(),
      this.validator.close(),
      this.adaptiveMemory.close(),
      this.continualLearner.close(),
    ];

    // MIRAS: Close cross-project learner (the only MIRAS system that needs explicit closing)
    if (this.crossProjectLearner) {
      closePromises.push(this.crossProjectLearner.close());
    }

    // v2.0: Close causal graph, noop logger, and working memory
    if (this.causalGraph) {
      closePromises.push(this.causalGraph.close());
    }
    if (this.noopLogger) {
      closePromises.push(this.noopLogger.close());
    }
    if (this.workingMemory) {
      closePromises.push(this.workingMemory.close());
    }

    await Promise.all(closePromises);
    this.initialized = false;
  }

  // ==================== Phase 3 API Methods ====================

  // --- Knowledge Graph ---

  /**
   * Extract entities and relationships from content
   */
  async extractGraph(content: string): Promise<ExtractionResult> {
    if (!this.initialized) await this.initialize();
    return this.knowledgeGraph.extract(content);
  }

  /**
   * Query the knowledge graph
   */
  async queryGraph(entityNames: string[], options?: {
    maxDepth?: number;
    minStrength?: number;
  }): Promise<GraphQueryResult> {
    if (!this.initialized) await this.initialize();
    return this.knowledgeGraph.query(entityNames, options);
  }

  /**
   * Get knowledge graph statistics
   */
  async getGraphStats(): Promise<{
    entityCount: number;
    relationshipCount: number;
    avgConnections: number;
  }> {
    if (!this.initialized) await this.initialize();
    return this.knowledgeGraph.getStats();
  }

  // --- Decision Traces ---

  /**
   * Create a decision trace
   */
  async traceDecision(params: {
    type: DecisionTrace['type'];
    summary: string;
    description: string;
    rationale: string;
    alternatives?: Array<{
      description: string;
      pros?: string[];
      cons?: string[];
    }>;
    confidence?: number;
    tags?: string[];
  }): Promise<DecisionTrace> {
    if (!this.initialized) await this.initialize();
    return this.decisionTracer.createDecision(params);
  }

  /**
   * Record outcome for a decision
   */
  async recordDecisionOutcome(decisionId: string, outcome: {
    status: 'success' | 'partial' | 'failure';
    description?: string;
    feedback?: string;
  }): Promise<DecisionTrace | null> {
    if (!this.initialized) await this.initialize();
    return this.decisionTracer.recordOutcome(decisionId, outcome);
  }

  /**
   * Query decisions
   */
  async queryDecisions(options?: {
    type?: DecisionTrace['type'];
    outcomeStatus?: 'pending' | 'success' | 'failure';
    limit?: number;
  }): Promise<DecisionQueryResult> {
    if (!this.initialized) await this.initialize();
    return this.decisionTracer.query(options);
  }

  /**
   * Find similar past decisions
   */
  async findSimilarDecisions(summary: string, limit?: number): Promise<DecisionTrace[]> {
    if (!this.initialized) await this.initialize();
    return this.decisionTracer.findSimilar(summary, { limit });
  }

  // --- World Model ---

  /**
   * Create a context (project, session, domain, etc.)
   */
  async createContext(params: {
    type: MetaNode['type'];
    name: string;
    description?: string;
    parentId?: string;
  }): Promise<MetaNode> {
    if (!this.initialized) await this.initialize();
    return this.worldModel.createNode(params);
  }

  /**
   * Get or create a context by name
   */
  async getOrCreateContext(
    type: MetaNode['type'],
    name: string
  ): Promise<MetaNode> {
    if (!this.initialized) await this.initialize();
    return this.worldModel.getOrCreate(type, name);
  }

  /**
   * Set active context for memory operations
   */
  async setActiveContext(contextIds: string[]): Promise<void> {
    if (!this.initialized) await this.initialize();
    await this.worldModel.setActiveContext(contextIds);
  }

  /**
   * Get current world state
   */
  getWorldState(): WorldState {
    return this.worldModel.getWorldState();
  }

  /**
   * Aggregate insights for a context
   */
  async aggregateContext(contextId: string): Promise<AggregationResult> {
    if (!this.initialized) await this.initialize();
    const memoryIds = await this.worldModel.getMemoriesForNode(contextId);
    const memories: MemoryEntry[] = [];

    for (const id of memoryIds) {
      const memory = await this.get(id);
      if (memory) memories.push(memory);
    }

    return this.worldModel.aggregate(contextId, memories);
  }

  // --- Behavioral Validation ---

  /**
   * Run full validation on all memories
   */
  async validate(): Promise<ValidationReport> {
    if (!this.initialized) await this.initialize();

    // Collect all memories
    const memories: MemoryEntry[] = [];
    for (const layer of this.layers.values()) {
      const result = await layer.query('', { limit: 1000 });
      memories.push(...result.memories);
    }

    return this.validator.runFullValidation(memories);
  }

  /**
   * Get quality score for a memory
   */
  getQualityScore(memory: MemoryEntry): QualityScore {
    return this.validator.calculateQualityScore(memory);
  }

  /**
   * Get open validation issues
   */
  async getValidationIssues(severity?: 'critical' | 'warning' | 'info'): Promise<{
    issues: Array<{
      id: string;
      type: string;
      severity: string;
      description: string;
    }>;
  }> {
    if (!this.initialized) await this.initialize();
    const issues = await this.validator.getOpenIssues(severity);
    return {
      issues: issues.map(i => ({
        id: i.id,
        type: i.type,
        severity: i.severity,
        description: i.description,
      })),
    };
  }

  // --- Adaptive Memory ---

  /**
   * Consolidate similar memories
   */
  async consolidate(): Promise<{
    consolidated: number;
    mergedIds: string[][];
  }> {
    if (!this.initialized) await this.initialize();

    // Get all memories
    const memories: MemoryEntry[] = [];
    for (const layer of this.layers.values()) {
      const result = await layer.query('', { limit: 500 });
      memories.push(...result.memories);
    }

    // Find consolidation candidates
    const candidates = await this.adaptiveMemory.findConsolidationCandidates(memories);
    const mergedIds: string[][] = [];

    // Consolidate top candidates
    for (const candidate of candidates.slice(0, 10)) {
      await this.adaptiveMemory.consolidate(candidate.memory1, candidate.memory2);
      mergedIds.push([candidate.memory1.id, candidate.memory2.id]);
    }

    return {
      consolidated: mergedIds.length,
      mergedIds,
    };
  }

  /**
   * Fuse memories into coherent response
   */
  async fuseMemories(
    memoryIds: string[],
    strategy?: 'merge' | 'summarize' | 'extract'
  ): Promise<FusionResult> {
    if (!this.initialized) await this.initialize();

    const memories: MemoryEntry[] = [];
    for (const id of memoryIds) {
      const memory = await this.get(id);
      if (memory) memories.push(memory);
    }

    return this.adaptiveMemory.fuse(memories, strategy);
  }

  /**
   * Cluster related memories
   */
  async clusterMemories(): Promise<{
    clusters: Array<{
      id: string;
      memoryCount: number;
      avgImportance: number;
      commonTags: string[];
    }>;
  }> {
    if (!this.initialized) await this.initialize();

    // Get all memories
    const memories: MemoryEntry[] = [];
    for (const layer of this.layers.values()) {
      const result = await layer.query('', { limit: 500 });
      memories.push(...result.memories);
    }

    const clusters = await this.adaptiveMemory.clusterMemories(memories);

    return {
      clusters: clusters.map(c => ({
        id: c.id,
        memoryCount: c.memoryIds.length,
        avgImportance: c.avgImportance,
        commonTags: c.commonTags,
      })),
    };
  }

  /**
   * Get adaptive memory statistics
   */
  async getAdaptiveStats(): Promise<{
    totalConsolidations: number;
    clusterCount: number;
    avgImportance: number;
  }> {
    if (!this.initialized) await this.initialize();
    return this.adaptiveMemory.getStats();
  }

  // --- Continual Learning ---

  /**
   * Get pattern lifecycle for a memory
   */
  async getPatternLifecycle(memoryId: string): Promise<import('./types.js').PatternLifecycle | undefined> {
    if (!this.initialized) await this.initialize();
    return this.continualLearner.findPatternByMemoryId(memoryId);
  }

  /**
   * Check for catastrophic forgetting risk
   */
  async checkForgettingRisk(): Promise<import('./types.js').ForgettingRisk> {
    if (!this.initialized) await this.initialize();
    return this.continualLearner.checkForgettingRisk();
  }

  /**
   * Execute scheduled rehearsals (spaced repetition)
   */
  async runRehearsalCycle(): Promise<Array<{ patternId: string; newInterval: number }>> {
    if (!this.initialized) await this.initialize();
    return this.continualLearner.executeRehearsals();
  }

  /**
   * Get pending rehearsals
   */
  async getPendingRehearsals(): Promise<import('./types.js').RehearsalEntry[]> {
    if (!this.initialized) await this.initialize();
    return this.continualLearner.getPendingRehearsals();
  }

  /**
   * Distill core insights from a pattern
   */
  async distillPattern(memoryId: string): Promise<string | undefined> {
    if (!this.initialized) await this.initialize();
    const pattern = this.continualLearner.findPatternByMemoryId(memoryId);
    if (!pattern) return undefined;
    return this.continualLearner.distillPattern(pattern);
  }

  /**
   * Get plasticity index for a pattern
   */
  getPlasticityIndex(patternId: string): number {
    return this.continualLearner.getPlasticityIndex(patternId);
  }

  /**
   * Get stability index for a pattern
   */
  getStabilityIndex(patternId: string): number {
    return this.continualLearner.getStabilityIndex(patternId);
  }

  /**
   * Get all patterns by lifecycle stage
   */
  async getPatternsByStage(stage: import('./types.js').PatternStage): Promise<import('./types.js').PatternLifecycle[]> {
    if (!this.initialized) await this.initialize();
    return this.continualLearner.getPatternsByStage(stage);
  }

  /**
   * Get learning statistics
   */
  async getLearningStats(): Promise<import('./types.js').LearningStats> {
    if (!this.initialized) await this.initialize();
    return this.continualLearner.getStats();
  }

  /**
   * Get forgetting alerts history
   */
  async getForgettingAlerts(): Promise<import('./types.js').ForgettingRisk[]> {
    if (!this.initialized) await this.initialize();
    return this.continualLearner.getForgettingAlerts();
  }

  /**
   * Update domain learning rate based on success/failure feedback
   */
  updateDomainLearningRate(domain: string, success: boolean): void {
    this.continualLearner.updateDomainLearningRate(domain, success);
  }

  // --- Combined Phase 3 Stats ---

  /**
   * Get comprehensive Phase 3 statistics
   */
  async getPhase3Stats(): Promise<{
    graph: Awaited<ReturnType<KnowledgeGraph['getStats']>>;
    decisions: Awaited<ReturnType<DecisionTraceManager['getStats']>>;
    world: Awaited<ReturnType<WorldModel['getStats']>>;
    validation: Awaited<ReturnType<BehavioralValidator['getStats']>>;
    adaptive: Awaited<ReturnType<AdaptiveMemory['getStats']>>;
    learning: Awaited<ReturnType<ContinualLearner['getStats']>>;
  }> {
    if (!this.initialized) await this.initialize();

    const [graph, decisions, world, validation, adaptive, learning] = await Promise.all([
      this.knowledgeGraph.getStats(),
      this.decisionTracer.getStats(),
      this.worldModel.getStats(),
      this.validator.getStats(),
      this.adaptiveMemory.getStats(),
      this.continualLearner.getStats(),
    ]);

    return { graph, decisions, world, validation, adaptive, learning };
  }

  // ==================== MIRAS Enhancement API Methods ====================

  /**
   * Get proactive memory suggestions based on current context
   * Feature 6: Proactive Suggestions
   */
  async suggest(context: string, options?: {
    limit?: number;
    minRelevance?: number;
    includeHighlighting?: boolean;
  }): Promise<ProactiveSuggestion[]> {
    if (!this.initialized) await this.initialize();

    if (!this.proactiveSuggestionsManager) {
      return [];
    }

    // Get available memories for suggestions
    const memories: MemoryEntry[] = [];
    for (const layer of this.layers.values()) {
      const result = await layer.query('', { limit: 100 });
      memories.push(...result.memories);
    }

    return this.proactiveSuggestionsManager.suggest(context, memories, options);
  }

  /**
   * Highlight relevant portions of memories for a query
   * Feature 1b: Semantic Highlighting
   */
  async highlightMemories(
    query: string,
    memories: MemoryEntry[],
    threshold?: number
  ): Promise<HighlightedMemory[]> {
    if (!this.initialized) await this.initialize();

    if (!this.semanticHighlighter) {
      // Return memories without highlighting if not enabled
      return memories.map(m => ({
        ...m,
        highlightedContent: m.content,
        highlightMetadata: {
          compressionRate: 0,
          originalLength: m.content.length,
          highlightedLength: m.content.length,
        },
      }));
    }

    // Bounded concurrent highlight calls to avoid resource exhaustion
    const highlightResults: Awaited<ReturnType<typeof this.semanticHighlighter.highlight>>[] = [];
    const highlightLimit = 5;
    for (let i = 0; i < memories.length; i += highlightLimit) {
      const chunk = memories.slice(i, i + highlightLimit);
      const chunkResults = await Promise.all(
        chunk.map(memory =>
          this.semanticHighlighter!.highlight(query, memory.content, threshold)
        )
      );
      highlightResults.push(...chunkResults);
    }

    return memories.map((memory, i) => {
      const highlighted = highlightResults[i];
      const highlightedContent = highlighted.highlightedSentences.join(' ');
      return {
        ...memory,
        highlightedContent,
        highlightMetadata: {
          compressionRate: highlighted.compressionRate,
          originalLength: memory.content.length,
          highlightedLength: highlightedContent.length,
        },
      };
    });
  }

  /**
   * Find relevant patterns from cross-project learning
   * Feature 7: Cross-Project Learning
   */
  async findRelevantPatterns(
    query: string,
    options?: {
      limit?: number;
      minRelevance?: number;
      domain?: string;
    }
  ): Promise<PatternMatchResult[]> {
    if (!this.initialized) await this.initialize();

    if (!this.crossProjectLearner || !this.patternMatcher) {
      return [];
    }

    const patterns = this.crossProjectLearner.getAllPatterns();
    return this.patternMatcher.match(query, patterns, {
      maxResults: options?.limit || 10,
      minRelevance: options?.minRelevance || 0.6,
      domains: options?.domain ? [options.domain] : undefined,
    });
  }

  /**
   * Extract transferable patterns from current project
   * Feature 7: Cross-Project Learning
   */
  async extractTransferablePatterns(): Promise<TransferablePattern[]> {
    if (!this.initialized) await this.initialize();

    if (!this.crossProjectLearner) {
      return [];
    }

    const projectId = this.activeProjectId || 'default';
    const stablePatterns = await this.continualLearner.getPatternsByStage('stable');
    const maturePatterns = await this.continualLearner.getPatternsByStage('mature');

    return this.crossProjectLearner.extractPatterns(
      projectId,
      [...stablePatterns, ...maturePatterns]
    );
  }

  /**
   * Record a pattern transfer for analytics
   * Feature 7: Cross-Project Learning
   */
  async recordPatternTransfer(patternId: string): Promise<boolean> {
    if (!this.crossProjectLearner) {
      return false;
    }

    const projectId = this.activeProjectId || 'default';
    return this.crossProjectLearner.recordTransfer(patternId, projectId);
  }

  /**
   * Capture context automatically based on momentum
   * Feature 4: Auto Context Capture
   */
  async captureContext(
    trigger: string,
    momentum?: number
  ): Promise<ContextCaptureResult | null> {
    if (!this.contextCaptureManager) {
      return null;
    }

    const currentMomentum = momentum ?? this.getCurrentMomentum();
    return this.contextCaptureManager.captureContext(trigger, currentMomentum);
  }

  /**
   * Update context buffer for auto-capture
   * Feature 4: Auto Context Capture
   */
  updateContextBuffer(content: string): void {
    if (this.contextCaptureManager) {
      this.contextCaptureManager.addToBuffer(content);
    }
  }

  /**
   * Get MIRAS enhancement statistics
   */
  async getMirasStats(): Promise<{
    embeddingEnabled: boolean;
    highlightingEnabled: boolean;
    surpriseAlgorithm: string;
    decayStrategy: string;
    contextCaptureEnabled: boolean;
    autoConsolidationEnabled: boolean;
    proactiveSuggestionsEnabled: boolean;
    crossProjectEnabled: boolean;
    autoConsolidationStats?: {
      pendingCandidates: number;
      totalConsolidations: number;
    };
    crossProjectStats?: {
      totalPatterns: number;
      totalTransfers: number;
      avgApplicability: number;
    };
  }> {
    const config = loadConfig();

    const result = {
      embeddingEnabled: config.embedding.provider !== 'hash',
      highlightingEnabled: config.semanticHighlight.enabled,
      surpriseAlgorithm: config.semanticSurprise.algorithm,
      decayStrategy: config.dataDependentDecay.strategy,
      contextCaptureEnabled: config.contextCapture.enabled,
      autoConsolidationEnabled: config.autoConsolidation.enabled,
      proactiveSuggestionsEnabled: config.proactiveSuggestions.enabled,
      crossProjectEnabled: config.crossProject.enabled,
      autoConsolidationStats: undefined as { pendingCandidates: number; totalConsolidations: number } | undefined,
      crossProjectStats: undefined as { totalPatterns: number; totalTransfers: number; avgApplicability: number } | undefined,
    };

    if (this.autoConsolidationManager) {
      const stats = this.autoConsolidationManager.getStats();
      result.autoConsolidationStats = {
        pendingCandidates: stats.pendingCount,
        totalConsolidations: stats.historyCount,
      };
    }

    if (this.crossProjectLearner) {
      const stats = this.crossProjectLearner.getStats();
      result.crossProjectStats = {
        totalPatterns: stats.totalPatterns,
        totalTransfers: stats.totalTransfers,
        avgApplicability: stats.avgApplicability,
      };
    }

    // Include Cortex status
    (result as Record<string, unknown>).cortex = this.getCortexStatus();

    // Include LLM Turbo Layer status
    (result as Record<string, unknown>).llmTurbo = this.getLLMStatus();

    return result;
  }

  /**
   * Get LLM Turbo Layer status for observability
   */
  getLLMStatus(): {
    enabled: boolean;
    available: boolean;
    provider?: string;
    model?: string;
    capabilities: {
      classify: boolean;
      extract: boolean;
      rerank: boolean;
      summarize: boolean;
    };
  } {
    const config = loadConfig();
    const enabled = config.llm?.enabled ?? false;
    const available = this.llmClient?.isAvailable() ?? false;

    return {
      enabled,
      available,
      provider: enabled ? config.llm.provider : undefined,
      model: enabled ? config.llm.model : undefined,
      capabilities: {
        classify: enabled && (config.llm.classifyEnabled ?? true),
        extract: enabled && (config.llm.extractEnabled ?? true),
        rerank: enabled && (config.llm.rerankEnabled ?? true),
        summarize: enabled && (config.llm.summarizeEnabled ?? false),
      },
    };
  }

  // ==================== Cortex API Methods ====================

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
    if (!this.categorySummarizer) return null;
    const summary = this.categorySummarizer.getSummary(category);
    if (!summary) return null;
    return {
      category: summary.category,
      summary: summary.summary,
      entryCount: summary.entryCount,
      version: summary.version,
    };
  }

  /**
   * Check sufficiency of recall results across categories
   */
  checkCategorySufficiency(memories: MemoryEntry[], query: string): SufficiencyResult {
    const targetCategories = getRelevantCategories(query);
    return checkSufficiency(memories, targetCategories);
  }

  /**
   * Inspect a tool call via intent guardrails
   */
  inspectIntent(toolName: string, args: Record<string, unknown>): { action: string; reason: string; rule?: string } {
    if (!this.intentGuardrails) {
      return { action: 'allow', reason: 'Guardrails not enabled' };
    }
    return this.intentGuardrails.inspect(toolName, args);
  }

  /**
   * Record drift feedback for a categorized memory
   */
  recordDriftFeedback(memoryId: string, category: MemoryCategory, signal: 'helpful' | 'harmful'): void {
    if (this.driftMonitor) {
      this.driftMonitor.recordFeedback(memoryId, category, signal);
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
    return {
      enabled: !!this.cortexPipeline,
      pipelineActive: this.cortexPipeline?.isEnabled() ?? false,
      guardrailsEnabled: this.intentGuardrails?.isEnabled() ?? false,
      driftMonitorEnabled: this.driftMonitor?.isEnabled() ?? false,
      projectHooksEnabled: this.projectHooks?.isEnabled() ?? false,
      categorySummaries: this.categorySummarizer?.getAllSummaries().length ?? 0,
    };
  }

  /**
   * Get the embedding generator (for advanced use cases)
   */
  getEmbeddingGenerator(): IEmbeddingGenerator | undefined {
    return this.embeddingGenerator;
  }

  /**
   * Calculate semantic surprise for content
   * Feature 2: Semantic Surprise
   */
  async calculateSurprise(
    content: string,
    recentMemories?: MemoryEntry[]
  ): Promise<{ score: number; shouldStore: boolean }> {
    if (!this.surpriseCalculator) {
      return { score: 0.5, shouldStore: true };
    }

    const memories = recentMemories || [];
    if (memories.length === 0) {
      // Get recent memories from long-term layer
      const result = await this.longTermLayer.query('', { limit: 50 });
      memories.push(...result.memories);
    }

    return this.surpriseCalculator.calculateSurprise(content, memories);
  }

  /**
   * Calculate decay score for a memory
   * Feature 3: Data-Dependent Decay
   */
  calculateDecay(memory: MemoryEntry): number {
    if (!this.decayCalculator) {
      // Simple time-based decay fallback
      const ageMs = Date.now() - new Date(memory.timestamp).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      return Math.pow(2, -ageDays / 180);
    }

    return this.decayCalculator.calculate(memory);
  }

  // ==================== v2.0 NOOP/Skip Operation ====================

  /**
   * Log a NOOP decision - agent explicitly skips memory storage
   * v2.0: Mem0 AUDN pattern - Add/Update/Delete/Noop
   */
  async logNoop(params: {
    reason: NoopReason;
    context?: string;
    contentPreview?: string;
    sessionId?: string;
    projectId?: string;
  }): Promise<NoopDecision> {
    if (!this.initialized) await this.initialize();

    return this.noopLogger.logNoop({
      reason: params.reason,
      context: params.context,
      contentPreview: params.contentPreview,
      sessionId: params.sessionId,
      projectId: params.projectId || this.activeProjectId,
    });
  }

  /**
   * Get NOOP statistics
   * v2.0: Shows skip decision analytics
   */
  async getNoopStats(): Promise<NoopStats> {
    if (!this.initialized) await this.initialize();
    return this.noopLogger.getStats();
  }

  /**
   * Get recent NOOP decisions
   * v2.0: For debugging and analytics
   */
  async getRecentNoops(limit: number = 10): Promise<NoopDecision[]> {
    if (!this.initialized) await this.initialize();
    return this.noopLogger.getRecent(limit);
  }

  // ==================== v2.0 Intent-Aware Retrieval ====================

  /**
   * Detect query intent for optimized retrieval
   * v2.0: Returns intent type, confidence, and recommended layers/strategy
   */
  detectQueryIntent(query: string): QueryIntent {
    return this.intentDetector.detect(query);
  }

  /**
   * Get intent detection statistics
   * v2.0: Shows distribution of query intents over time
   */
  getIntentStats(): {
    totalQueries: number;
    distribution: Record<QueryIntentType, number>;
    avgConfidence: number;
  } {
    return this.intentDetector.getStats();
  }

  /**
   * Get queries that matched a specific intent type
   * v2.0: For analytics and debugging
   */
  getQueriesByIntent(type: QueryIntentType, limit: number = 10): string[] {
    return this.intentDetector.getQueriesByIntent(type, limit);
  }

  // ==================== v2.0 Causal Graph ====================

  /**
   * Create a causal relationship between two memories
   * v2.0: MAGMA-inspired multi-graph architecture
   */
  async createCausalLink(params: {
    fromMemoryId: string;
    toMemoryId: string;
    relationship: CausalRelationType;
    strength?: number;
    evidence?: string;
  }): Promise<CausalEdge> {
    if (!this.initialized) await this.initialize();
    return this.causalGraph.link(params);
  }

  /**
   * Trace causal chain from a memory
   * v2.0: Follows cause/effect relationships
   */
  async traceCausalChain(memoryId: string, options?: {
    depth?: number;
    direction?: 'forward' | 'backward' | 'both';
    minStrength?: number;
    relationTypes?: CausalRelationType[];
  }): Promise<CausalChain> {
    if (!this.initialized) await this.initialize();
    return this.causalGraph.trace(memoryId, options);
  }

  /**
   * Explain why a memory exists (root cause analysis)
   * v2.0: Traces causes back to root
   */
  async explainMemory(memoryId: string, maxDepth?: number): Promise<ExplanationTree> {
    if (!this.initialized) await this.initialize();
    return this.causalGraph.why(memoryId, maxDepth);
  }

  /**
   * Get all causal edges for a memory
   * v2.0: Returns incoming and outgoing relationships
   */
  async getCausalEdges(memoryId: string): Promise<{
    outgoing: CausalEdge[];
    incoming: CausalEdge[];
  }> {
    if (!this.initialized) await this.initialize();
    return this.causalGraph.getEdgesForMemory(memoryId);
  }

  /**
   * Find contradictions involving a memory
   * v2.0: Useful for conflict detection
   */
  async findContradictions(memoryId: string): Promise<CausalEdge[]> {
    if (!this.initialized) await this.initialize();
    return this.causalGraph.findContradictions(memoryId);
  }

  /**
   * Get causal graph statistics
   * v2.0: Shows relationship distribution and graph health
   */
  async getCausalGraphStats(): Promise<CausalGraphStats> {
    if (!this.initialized) await this.initialize();
    return this.causalGraph.getStats();
  }

  /**
   * Remove a causal link
   * v2.0: Unlinks two memories
   */
  async removeCausalLink(edgeId: string): Promise<boolean> {
    if (!this.initialized) await this.initialize();
    return this.causalGraph.unlink(edgeId);
  }

  // ==================== v2.0 Working Memory Methods ====================

  /**
   * Add an item to working memory focus
   * v2.0: Explicit working memory management
   */
  async addFocus(content: string, options?: {
    priority?: 'high' | 'normal' | 'low';
    ttlMs?: number;
    source?: string;
    metadata?: Record<string, unknown>;
  }): Promise<FocusItem> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.addFocus({
      content,
      priority: options?.priority,
      ttlMs: options?.ttlMs,
      source: options?.source,
      metadata: options?.metadata,
    });
  }

  /**
   * Get current working memory focus items
   * v2.0: Returns items sorted by priority and recency
   */
  async getFocus(): Promise<FocusItem[]> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.getFocus();
  }

  /**
   * Get working memory focus as formatted context string
   * v2.0: Useful for injecting into prompts
   */
  async getFocusContext(): Promise<string> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.getFocusContext();
  }

  /**
   * Remove a specific focus item
   * v2.0: Explicit attention control
   */
  async removeFocus(id: string): Promise<boolean> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.removeFocus(id);
  }

  /**
   * Clear all focus items
   * v2.0: Reset working memory
   */
  async clearFocus(): Promise<number> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.clearFocus();
  }

  /**
   * Get scratchpad content
   * v2.0: Agent notes/thinking
   */
  async getScratchpad(): Promise<string> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.getScratchpad();
  }

  /**
   * Set scratchpad content
   * v2.0: Replace scratchpad
   */
  async setScratchpad(content: string): Promise<void> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.setScratchpad(content);
  }

  /**
   * Append to scratchpad
   * v2.0: Add to existing scratchpad
   */
  async appendScratchpad(content: string): Promise<void> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.appendScratchpad(content);
  }

  /**
   * Clear scratchpad
   * v2.0: Reset scratchpad
   */
  async clearScratchpad(): Promise<void> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.clearScratchpad();
  }

  /**
   * Get full working memory state
   * v2.0: Returns focus items, scratchpad, and metadata
   */
  async getWorkingMemoryState(): Promise<WorkingMemoryState> {
    if (!this.initialized) await this.initialize();
    return this.workingMemory.getState();
  }
}

// Export singleton instance
let instance: TitanMemory | null = null;

export function getTitan(projectId?: string): TitanMemory {
  if (!instance) {
    instance = new TitanMemory(undefined, projectId);
  }
  return instance;
}

export async function initTitan(
  configPath?: string,
  projectId?: string
): Promise<TitanMemory> {
  instance = new TitanMemory(configPath, projectId);
  await instance.initialize();
  return instance;
}

/**
 * Get or create a TitanMemory instance for a specific project
 * Use this when you need multiple projects simultaneously
 */
export async function initTitanForProject(projectId: string): Promise<TitanMemory> {
  const titan = new TitanMemory(undefined, projectId);
  await titan.initialize();
  return titan;
}
