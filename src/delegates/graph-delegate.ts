/**
 * GraphDelegate - Extracted from TitanMemory
 * Handles knowledge graph, decision tracing, and causal graph operations
 */

import { DecisionTraceManager, DecisionTrace } from '../trace/decision-trace.js';
import { WorldModel, WorldState } from '../world/world-model.js';
import {
  CausalGraph,
  CausalEdge,
  CausalChain,
  ExplanationTree,
  CausalRelationType,
  CausalGraphStats,
} from '../graphs/causal.js';

export class GraphDelegate {
  constructor(
    private decisionTracer: DecisionTraceManager,
    private worldModel: WorldModel,
    private causalGraph: CausalGraph,
    private ensureInitialized: () => Promise<void>,
  ) {}

  /**
   * Trace an architectural/design decision
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
    await this.ensureInitialized();
    return this.decisionTracer.createDecision(params);
  }

  /**
   * Get the current world state
   */
  getWorldState(): WorldState {
    return this.worldModel.getWorldState();
  }

  /**
   * Create a causal link between two memories
   * v2.0: Connects memories with typed relationships
   */
  async createCausalLink(params: {
    fromMemoryId: string;
    toMemoryId: string;
    relationship: CausalRelationType;
    strength?: number;
    evidence?: string;
  }): Promise<CausalEdge> {
    await this.ensureInitialized();
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
    await this.ensureInitialized();
    return this.causalGraph.trace(memoryId, options);
  }

  /**
   * Explain why a memory exists (root cause analysis)
   * v2.0: Traces causes back to root
   */
  async explainMemory(memoryId: string, maxDepth?: number): Promise<ExplanationTree> {
    await this.ensureInitialized();
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
    await this.ensureInitialized();
    return this.causalGraph.getEdgesForMemory(memoryId);
  }

  /**
   * Find contradictions involving a memory
   * v2.0: Useful for conflict detection
   */
  async findContradictions(memoryId: string): Promise<CausalEdge[]> {
    await this.ensureInitialized();
    return this.causalGraph.findContradictions(memoryId);
  }

  /**
   * Get causal graph statistics
   * v2.0: Shows relationship distribution and graph health
   */
  async getCausalGraphStats(): Promise<CausalGraphStats> {
    await this.ensureInitialized();
    return this.causalGraph.getStats();
  }

  /**
   * Remove a causal link
   * v2.0: Unlinks two memories
   */
  async removeCausalLink(edgeId: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.causalGraph.unlink(edgeId);
  }
}
