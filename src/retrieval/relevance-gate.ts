/**
 * Relevance Gate - Token-Efficient Memory Injection
 * Titan Memory v2.2 Phase 4
 *
 * Caps total output at a token budget, preserving top-k most relevant memories.
 * Token estimation: chars / 4 (standard approximation).
 */

/** Minimal interface for a scored memory */
export interface ScoredMemory {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

/**
 * Estimate token count from character length.
 * Uses the standard chars/4 approximation.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Gate memories by relevance within a token budget.
 *
 * - Sorts by score descending (most relevant first)
 * - Accumulates token count per memory
 * - Stops adding when budget would be exceeded
 *
 * @param memories - Array of scored memories
 * @param budget - Maximum total tokens to return
 * @returns Filtered array of memories within budget, sorted by score desc
 */
export function gateByRelevance(
  memories: ScoredMemory[],
  budget: number,
): ScoredMemory[] {
  if (budget <= 0 || memories.length === 0) {
    return [];
  }

  // Sort by score descending — most relevant first
  const sorted = [...memories].sort((a, b) => b.score - a.score);

  const result: ScoredMemory[] = [];
  let usedTokens = 0;

  for (const memory of sorted) {
    const tokens = estimateTokens(memory.content);
    if (usedTokens + tokens > budget) {
      break;
    }
    result.push(memory);
    usedTokens += tokens;
  }

  return result;
}
