/**
 * Titan Memory MCP Tools
 * Tool definitions and handlers for the MCP server
 */

import { z } from 'zod';
import { TitanMemory, initTitan } from '../titan.js';
import { getToolHandler } from './tool-registry.js';

// Tool input schemas using Zod for validation
export const ToolSchemas = {
  titan_add: z.object({
    content: z.string().describe('Memory content to store'),
    layer: z.number().min(2).max(5).optional().describe('Force specific layer (2=factual, 3=longterm, 4=semantic, 5=episodic)'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    projectId: z.string().optional().describe('Project identifier'),
  }),

  titan_recall: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().default(10).optional().describe('Maximum results to return'),
    layers: z.array(z.number()).optional().describe('Specific layers to query (2-5)'),
    projectId: z.string().optional().describe('Filter by project'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    mode: z.enum(['full', 'summary', 'metadata']).default('full').optional()
      .describe('FR-2: Response mode - full (default), summary (100 chars + metadata), or metadata only'),
  }),

  titan_get: z.object({
    id: z.string().describe('Memory ID to retrieve'),
  }),

  titan_delete: z.object({
    id: z.string().describe('Memory ID to delete'),
  }),

  titan_stats: z.object({}),

  titan_flush: z.object({
    sessionId: z.string().optional().describe('Current session ID'),
    insights: z.array(z.string()).optional().describe('Important insights to preserve'),
    decisions: z.array(z.string()).optional().describe('Key decisions made'),
    errors: z.array(z.string()).optional().describe('Errors encountered'),
    solutions: z.array(z.string()).optional().describe('Solutions found'),
  }),

  titan_curate: z.object({
    content: z.string().describe('Content to add to curated MEMORY.md'),
    section: z.string().optional().describe('Section in MEMORY.md (e.g., "Patterns", "Preferences")'),
  }),

  titan_today: z.object({}),

  titan_prune: z.object({
    decayThreshold: z.number().default(0.05).optional().describe('Decay score threshold (0-1)'),
    dryRun: z.boolean().default(false).optional().describe('Preview without deleting'),
    utilityThreshold: z.number().default(0.4).optional()
      .describe('FR-1: Utility score threshold (0-1). Memories with utility below this are candidates for pruning'),
  }),

  // FR-1: Utility Tracking - Feedback tool
  titan_feedback: z.object({
    id: z.string().describe('Memory ID to provide feedback for'),
    signal: z.enum(['helpful', 'harmful']).describe('Feedback signal - helpful if memory aided task, harmful if caused confusion'),
    context: z.string().optional().describe('Optional context about why the memory was helpful/harmful'),
    sessionId: z.string().optional().describe('Session ID for idempotency within session'),
  }),

  // MIRAS Enhancement: Proactive Suggestions
  titan_suggest: z.object({
    context: z.string().describe('Current context or task description to get suggestions for'),
    limit: z.number().default(5).optional().describe('Maximum suggestions to return (default: 5)'),
    minRelevance: z.number().default(0.5).optional().describe('Minimum relevance threshold (0-1)'),
    includeHighlighting: z.boolean().default(true).optional().describe('Include highlighted relevant portions'),
  }),

  // MIRAS Enhancement: Find Cross-Project Patterns
  titan_patterns: z.object({
    query: z.string().describe('Query to find relevant patterns'),
    limit: z.number().default(5).optional().describe('Maximum patterns to return'),
    minRelevance: z.number().default(0.6).optional().describe('Minimum relevance threshold'),
    domain: z.string().optional().describe('Filter by domain (e.g., "backend", "frontend", "general")'),
  }),

  // MIRAS Enhancement: Get MIRAS Stats
  titan_miras_stats: z.object({}),

  // Cortex: Classify content
  titan_classify: z.object({
    content: z.string().describe('Content to classify into a memory category'),
  }),

  // Cortex: Get category summary
  titan_category_summary: z.object({
    category: z.enum(['knowledge', 'profile', 'event', 'behavior', 'skill'])
      .describe('Memory category to get summary for'),
  }),

  // Cortex: Check category sufficiency
  titan_sufficiency: z.object({
    query: z.string().describe('Query to check category coverage for'),
    memoryIds: z.array(z.string()).optional().describe('Specific memory IDs to check (uses recent recall if not provided)'),
  }),

  // v2.0: NOOP/Skip Operation (Mem0 AUDN pattern)
  titan_noop: z.object({
    reason: z.enum(['routine', 'duplicate', 'low_value', 'temporary', 'off_topic', 'noise'])
      .describe('Why the memory update is being skipped'),
    context: z.string().optional()
      .describe('Optional context about the skip decision'),
    contentPreview: z.string().optional()
      .describe('Preview of content that was skipped (for debugging)'),
    sessionId: z.string().optional()
      .describe('Current session ID'),
    projectId: z.string().optional()
      .describe('Current project ID'),
  }),

  // v2.0: Get NOOP statistics
  titan_noop_stats: z.object({}),

  // v2.0: Intent-Aware Retrieval
  titan_intent: z.object({
    query: z.string().describe('Query to analyze for intent'),
  }),

  // v2.0: Causal Graph - Link memories
  titan_link: z.object({
    fromMemoryId: z.string().describe('Source memory ID (cause)'),
    toMemoryId: z.string().describe('Target memory ID (effect)'),
    relationship: z.enum(['causes', 'enables', 'blocks', 'follows', 'contradicts', 'requires', 'supports', 'refutes'])
      .describe('Type of causal relationship'),
    strength: z.number().min(0).max(1).optional().describe('Confidence in relationship (0-1, default 0.5)'),
    evidence: z.string().optional().describe('Why this relationship exists'),
  }),

  // v2.0: Causal Graph - Trace causal chain
  titan_trace: z.object({
    memoryId: z.string().describe('Memory ID to trace from'),
    depth: z.number().optional().describe('Max traversal depth (default 5)'),
    direction: z.enum(['forward', 'backward', 'both']).optional().describe('Trace direction (default backward)'),
  }),

  // v2.0: Causal Graph - Explain why (root cause analysis)
  titan_why: z.object({
    memoryId: z.string().describe('Memory ID to explain'),
    maxDepth: z.number().optional().describe('Max depth for cause tracing (default 5)'),
  }),

  // v2.0 Working Memory schemas
  titan_focus_add: z.object({
    content: z.string().describe('Content to add to working memory focus'),
    priority: z.enum(['high', 'normal', 'low']).default('normal').optional(),
    ttlMs: z.number().optional().describe('Time-to-live in milliseconds'),
    source: z.string().optional().describe('Source of this focus item'),
  }),

  titan_focus_list: z.object({
    asContext: z.boolean().default(false).optional().describe('Return as formatted context string'),
  }),

  titan_focus_clear: z.object({}),

  titan_focus_remove: z.object({
    id: z.string().describe('ID of the focus item to remove'),
  }),

  titan_scratchpad: z.object({
    action: z.enum(['get', 'set', 'append', 'clear']).describe('Action to perform'),
    content: z.string().optional().describe('Content for set/append actions'),
  }),

  // v2.0 Compression schemas
  titan_compress: z.object({
    memoryId: z.string().describe('Memory ID to compress'),
    targetRatio: z.number().optional().describe('Target compression ratio (default: 20)'),
    contextQuery: z.string().optional().describe('Optional query to bias compression toward relevant content'),
  }),

  titan_expand: z.object({
    compressed: z.string().describe('Compressed memory JSON string (output from titan_compress)'),
    verbosity: z.enum(['minimal', 'normal', 'detailed']).default('normal').optional()
      .describe('Output verbosity level'),
    format: z.enum(['prose', 'structured', 'bullet']).default('prose').optional()
      .describe('Output format'),
  }),

  // v2.1 Benchmark schema with rawMode + multi-run
  titan_benchmark: z.object({
    categories: z.array(z.enum(['retrieval', 'latency', 'token-efficiency', 'accuracy'])).optional()
      .describe('Categories to run (default: all)'),
    verbose: z.boolean().default(false).optional().describe('Show detailed output'),
    llmMode: z.boolean().default(false).optional()
      .describe('v2.1: Temporarily enable LLM Turbo Layer for this benchmark run'),
    rawMode: z.boolean().default(false).optional()
      .describe('v2.1: Disable safety overhead (validator, adaptive reordering, post-store) for clean measurement'),
    runs: z.number().min(1).max(10).default(1).optional()
      .describe('v2.1: Number of runs for statistical averaging (default: 1, max: 10)'),
  }),
};

// JSON Schema versions for MCP tool registration
export const ToolDefinitions = [
  {
    name: 'titan_add',
    description: 'Store a memory with automatic layer routing based on content type. Uses surprise detection to filter noise.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Memory content to store' },
        layer: { type: 'number', description: 'Force specific layer (2=factual, 3=longterm, 4=semantic, 5=episodic)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        projectId: { type: 'string', description: 'Project identifier' },
      },
      required: ['content'],
    },
  },
  {
    name: 'titan_recall',
    description: 'Query memories across all layers with intelligent fusion. Returns fused results ranked by relevance and utility score.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum results (default: 10)' },
        layers: { type: 'array', items: { type: 'number' }, description: 'Specific layers to query (2-5)' },
        projectId: { type: 'string', description: 'Filter by project' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        mode: {
          type: 'string',
          enum: ['full', 'summary', 'metadata'],
          description: 'FR-2: Response mode - full (default), summary (100 chars + metadata), or metadata only for context efficiency',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'titan_get',
    description: 'Retrieve a specific memory by its unique ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory ID to retrieve' },
      },
      required: ['id'],
    },
  },
  {
    name: 'titan_delete',
    description: 'Delete a memory by its unique ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'titan_stats',
    description: 'Get memory statistics including counts per layer, storage usage, and performance metrics.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'titan_flush',
    description: 'Pre-compaction memory flush. Saves important context before context window compaction to prevent loss.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: { type: 'string', description: 'Current session ID' },
        insights: { type: 'array', items: { type: 'string' }, description: 'Important insights to preserve' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Key decisions made' },
        errors: { type: 'array', items: { type: 'string' }, description: 'Errors encountered' },
        solutions: { type: 'array', items: { type: 'string' }, description: 'Solutions found' },
      },
      required: [],
    },
  },
  {
    name: 'titan_curate',
    description: 'Add content to human-curated MEMORY.md file for permanent high-value knowledge storage.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Content to add to curated MEMORY.md' },
        section: { type: 'string', description: 'Section in MEMORY.md (e.g., "Patterns", "Preferences")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'titan_today',
    description: "Get today's episodic memory entries - useful for session continuity.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'titan_prune',
    description: 'Prune old/decayed memories to maintain performance. Uses adaptive forgetting with configurable threshold and utility-based pruning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        decayThreshold: { type: 'number', description: 'Decay score threshold 0-1 (default: 0.05)' },
        dryRun: { type: 'boolean', description: 'Preview without deleting' },
        utilityThreshold: { type: 'number', description: 'FR-1: Utility score threshold 0-1 (default: 0.4). Memories below this are pruning candidates.' },
      },
      required: [],
    },
  },
  {
    name: 'titan_feedback',
    description: 'FR-1: Provide feedback on memory utility. Helpful feedback boosts recall ranking, harmful feedback makes memory a pruning candidate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory ID to provide feedback for' },
        signal: { type: 'string', enum: ['helpful', 'harmful'], description: 'Feedback signal' },
        context: { type: 'string', description: 'Optional context about why helpful/harmful' },
        sessionId: { type: 'string', description: 'Session ID for idempotency' },
      },
      required: ['id', 'signal'],
    },
  },
  {
    name: 'titan_suggest',
    description: 'MIRAS: Get proactive memory suggestions based on current context. Returns relevant memories ranked by utility, recency, and semantic relevance.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        context: { type: 'string', description: 'Current context or task description to get suggestions for' },
        limit: { type: 'number', description: 'Maximum suggestions to return (default: 5)' },
        minRelevance: { type: 'number', description: 'Minimum relevance threshold 0-1 (default: 0.5)' },
        includeHighlighting: { type: 'boolean', description: 'Include highlighted relevant portions (default: true)' },
      },
      required: ['context'],
    },
  },
  {
    name: 'titan_patterns',
    description: 'MIRAS: Find transferable patterns from cross-project learning. Returns patterns that may be applicable to the current context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Query to find relevant patterns' },
        limit: { type: 'number', description: 'Maximum patterns to return (default: 5)' },
        minRelevance: { type: 'number', description: 'Minimum relevance threshold 0-1 (default: 0.6)' },
        domain: { type: 'string', description: 'Filter by domain (e.g., "backend", "frontend", "general")' },
      },
      required: ['query'],
    },
  },
  {
    name: 'titan_miras_stats',
    description: 'MIRAS: Get statistics about MIRAS enhancement features including embedding, highlighting, surprise, decay, and cross-project learning.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'titan_classify',
    description: 'Cortex: Classify content into a memory category (knowledge/profile/event/behavior/skill). Returns category, confidence, and method.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Content to classify' },
      },
      required: ['content'],
    },
  },
  {
    name: 'titan_category_summary',
    description: 'Cortex: Get rolling summary for a specific memory category.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: ['knowledge', 'profile', 'event', 'behavior', 'skill'],
          description: 'Memory category',
        },
      },
      required: ['category'],
    },
  },
  {
    name: 'titan_sufficiency',
    description: 'Cortex: Check category coverage of recall results. Reports missing categories and coverage ratio.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Query to check coverage for' },
        memoryIds: { type: 'array', items: { type: 'string' }, description: 'Specific memory IDs to check' },
      },
      required: ['query'],
    },
  },
  // v2.0: NOOP/Skip Operation
  {
    name: 'titan_noop',
    description: 'v2.0: Explicitly skip a memory update. Use this when content should NOT be stored (routine interactions, duplicates, low value). Prevents memory bloat.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          enum: ['routine', 'duplicate', 'low_value', 'temporary', 'off_topic', 'noise'],
          description: 'Why skipping: routine (normal interaction), duplicate (already exists), low_value (not informative), temporary (ephemeral), off_topic (irrelevant), noise (filtered)',
        },
        context: { type: 'string', description: 'Optional context about the skip decision' },
        contentPreview: { type: 'string', description: 'Preview of skipped content (for debugging)' },
        sessionId: { type: 'string', description: 'Current session ID' },
        projectId: { type: 'string', description: 'Current project ID' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'titan_noop_stats',
    description: 'v2.0: Get statistics about NOOP/skip decisions. Shows skip reasons breakdown and memory write ratio.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  // v2.0: Intent-Aware Retrieval
  {
    name: 'titan_intent',
    description: 'v2.0: Detect query intent to optimize retrieval. Returns intent type, confidence, and recommended layers/strategy.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Query to analyze for intent' },
      },
      required: ['query'],
    },
  },
  // v2.0: Causal Graph
  {
    name: 'titan_link',
    description: 'v2.0: Create a causal relationship between two memories. Enables reasoning about causes, effects, dependencies, and contradictions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fromMemoryId: { type: 'string', description: 'Source memory ID (cause)' },
        toMemoryId: { type: 'string', description: 'Target memory ID (effect)' },
        relationship: {
          type: 'string',
          enum: ['causes', 'enables', 'blocks', 'follows', 'contradicts', 'requires', 'supports', 'refutes'],
          description: 'Type of relationship: causes (direct), enables (allows), blocks (prevents), follows (temporal), contradicts (conflicts), requires (depends on), supports (evidence for), refutes (evidence against)',
        },
        strength: { type: 'number', description: 'Confidence 0-1 (default 0.5)' },
        evidence: { type: 'string', description: 'Why this relationship exists' },
      },
      required: ['fromMemoryId', 'toMemoryId', 'relationship'],
    },
  },
  {
    name: 'titan_trace',
    description: 'v2.0: Trace causal chain from a memory. Returns the chain of relationships and their combined strength.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to trace from' },
        depth: { type: 'number', description: 'Max depth (default 5)' },
        direction: { type: 'string', enum: ['forward', 'backward', 'both'], description: 'Trace direction' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'titan_why',
    description: 'v2.0: Explain why a memory exists by tracing its causes. Returns direct causes, indirect causes, and root causes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to explain' },
        maxDepth: { type: 'number', description: 'Max cause tracing depth (default 5)' },
      },
      required: ['memoryId'],
    },
  },
  // v2.0 Working Memory tools
  {
    name: 'titan_focus_add',
    description: 'v2.0: Add an item to working memory focus. Working memory tracks what\'s currently "in scope" for the agent. Max 5 items by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Content to add to focus' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Priority level (default: normal)' },
        ttlMs: { type: 'number', description: 'Time-to-live in milliseconds (optional, 0 = no expiry)' },
        source: { type: 'string', description: 'Source of this focus item (e.g., "user", "recall", "agent")' },
      },
      required: ['content'],
    },
  },
  {
    name: 'titan_focus_list',
    description: 'v2.0: List current working memory focus items. Returns items sorted by priority and recency.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        asContext: { type: 'boolean', description: 'Return as formatted context string (default: false)' },
      },
      required: [],
    },
  },
  {
    name: 'titan_focus_clear',
    description: 'v2.0: Clear all items from working memory focus.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'titan_focus_remove',
    description: 'v2.0: Remove a specific item from working memory focus by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'ID of the focus item to remove' },
      },
      required: ['id'],
    },
  },
  {
    name: 'titan_scratchpad',
    description: 'v2.0: Get or set the agent scratchpad. Scratchpad is for agent notes/thinking during a session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'append', 'clear'], description: 'Action to perform' },
        content: { type: 'string', description: 'Content for set/append actions' },
      },
      required: ['action'],
    },
  },
  // v2.0 Compression tools
  {
    name: 'titan_compress',
    description: 'v2.0: Compress a memory into entities, relationships, summary, and key facts. Returns structured compressed representation with compression ratio and fidelity score.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        memoryId: { type: 'string', description: 'Memory ID to compress' },
        targetRatio: { type: 'number', description: 'Target compression ratio (default: 20)' },
        contextQuery: { type: 'string', description: 'Optional query to bias compression toward relevant content' },
      },
      required: ['memoryId'],
    },
  },
  {
    name: 'titan_expand',
    description: 'v2.0: Expand a compressed memory back into readable text. Supports prose, structured, and bullet formats with configurable verbosity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        compressed: { type: 'string', description: 'Compressed memory JSON string (output from titan_compress)' },
        verbosity: { type: 'string', enum: ['minimal', 'normal', 'detailed'], description: 'Output verbosity level' },
        format: { type: 'string', enum: ['prose', 'structured', 'bullet'], description: 'Output format' },
      },
      required: ['compressed'],
    },
  },
  // v2.0 Benchmark tool
  {
    name: 'titan_benchmark',
    description: 'v2.1: Run the Titan Memory benchmark suite. Tests latency, retrieval accuracy, and overall system health. Supports raw mode (safety off) and multi-run averaging.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        categories: {
          type: 'array',
          items: { type: 'string', enum: ['retrieval', 'latency', 'token-efficiency', 'accuracy'] },
          description: 'Categories to run (default: all)',
        },
        verbose: { type: 'boolean', description: 'Show detailed output (default: false)' },
        llmMode: { type: 'boolean', description: 'v2.1: Enable LLM Turbo Layer for this run (default: false)' },
        rawMode: { type: 'boolean', description: 'v2.1: Disable safety overhead for clean measurement (default: false)' },
        runs: { type: 'number', description: 'v2.1: Number of runs for statistical averaging (default: 1, max: 10)' },
      },
      required: [],
    },
  },
];

/**
 * Tool handler class - maps MCP tool calls to TitanMemory methods
 */
export class ToolHandler {
  private titan: TitanMemory | null = null;

  async ensureInitialized(): Promise<TitanMemory> {
    if (!this.titan) {
      this.titan = await initTitan();
    }
    return this.titan;
  }

  async handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
    try {
      const titan = await this.ensureInitialized();

      const handler = getToolHandler(name);
      if (!handler) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
      }

      return await handler(titan, args);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
      };
    }
  }

  async close(): Promise<void> {
    if (this.titan) {
      await this.titan.close();
      this.titan = null;
    }
  }
}
