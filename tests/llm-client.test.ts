/**
 * LLM Client + Turbo Layer Tests
 * Mocks all HTTP calls — never hits real LLM APIs.
 *
 * Coverage targets:
 *   client.ts:
 *     - constructor: config merging, API key resolution (explicit, env vars)
 *     - isAvailable: enabled + key checks
 *     - complete: Anthropic path, OpenAI path, openai-compatible path, unknown provider
 *     - completeJSON: parse success, markdown fence stripping, parse failure
 *     - getConfig: returns copy
 *     - completeAnthropic: system message extraction, timeout/abort, HTTP errors
 *     - completeOpenAI: baseUrl routing, timeout/abort, HTTP errors
 *   turbo.ts:
 *     - llmClassify: happy path, invalid category, null from LLM
 *     - llmExtract: all 5 categories, null fallback
 *     - llmRerank: empty input, single batch, multi-batch, missing indices, null fallback
 *     - llmSummarize: happy path, with context query, error fallback
 */

import { LLMClient } from '../src/llm/client';
import { DEFAULT_LLM_CONFIG } from '../src/llm/types';
import { llmClassify, llmExtract, llmRerank, llmSummarize } from '../src/llm/turbo';
import type { GoldSentence } from '../src/cortex/types';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

function mockFetchResponse(body: unknown, ok = true, status = 200): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  global.fetch = fn;
  return fn;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// client.ts — LLMClient
// ---------------------------------------------------------------------------

describe('LLMClient', () => {
  describe('constructor & config', () => {
    it('should merge partial config with defaults', () => {
      const client = new LLMClient({ model: 'custom-model', apiKey: 'k' });
      const cfg = client.getConfig();
      expect(cfg.model).toBe('custom-model');
      expect(cfg.timeout).toBe(DEFAULT_LLM_CONFIG.timeout);
      expect(cfg.provider).toBe('anthropic');
    });

    it('should use default config when no overrides given', () => {
      const client = new LLMClient({ apiKey: 'k' });
      const cfg = client.getConfig();
      expect(cfg).toEqual({ ...DEFAULT_LLM_CONFIG, apiKey: 'k' });
    });

    it('getConfig returns a copy (not a reference)', () => {
      const client = new LLMClient({ apiKey: 'k' });
      const a = client.getConfig();
      const b = client.getConfig();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe('resolveApiKey (via isAvailable)', () => {
    const savedEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...savedEnv };
    });

    it('should use explicit apiKey from config', () => {
      const client = new LLMClient({ enabled: true, apiKey: 'explicit-key' });
      expect(client.isAvailable()).toBe(true);
    });

    it('should fall back to ANTHROPIC_API_KEY for anthropic provider', () => {
      process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
      const client = new LLMClient({ enabled: true, provider: 'anthropic' });
      expect(client.isAvailable()).toBe(true);
    });

    it('should fall back to OPENAI_API_KEY for openai provider', () => {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = 'env-openai-key';
      const client = new LLMClient({ enabled: true, provider: 'openai' });
      expect(client.isAvailable()).toBe(true);
    });

    it('should fall back to GROQ_API_KEY for openai-compatible provider', () => {
      delete process.env.OPENAI_API_KEY;
      process.env.GROQ_API_KEY = 'env-groq-key';
      const client = new LLMClient({ enabled: true, provider: 'openai-compatible' });
      expect(client.isAvailable()).toBe(true);
    });

    it('should be unavailable when no key and no env vars', () => {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.GROQ_API_KEY;
      const client = new LLMClient({ enabled: true, provider: 'openai' });
      expect(client.isAvailable()).toBe(false);
    });
  });

  describe('isAvailable', () => {
    it('returns false when disabled even with key', () => {
      const client = new LLMClient({ enabled: false, apiKey: 'key' });
      expect(client.isAvailable()).toBe(false);
    });

    it('returns false when enabled but no key', () => {
      delete process.env.ANTHROPIC_API_KEY;
      const client = new LLMClient({ enabled: true });
      expect(client.isAvailable()).toBe(false);
    });

    it('returns true when enabled and key present', () => {
      const client = new LLMClient({ enabled: true, apiKey: 'key' });
      expect(client.isAvailable()).toBe(true);
    });
  });

  describe('complete — routing', () => {
    it('throws when client is not available', async () => {
      const client = new LLMClient({ enabled: false });
      await expect(client.complete([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('LLM client not available');
    });

    it('throws on unknown provider', async () => {
      const client = new LLMClient({
        enabled: true,
        apiKey: 'k',
        provider: 'unknown-provider' as any,
      });
      await expect(client.complete([{ role: 'user', content: 'hi' }]))
        .rejects.toThrow('Unknown LLM provider');
    });
  });

  describe('complete — Anthropic provider', () => {
    const makeClient = (overrides = {}) =>
      new LLMClient({ enabled: true, apiKey: 'test-key', provider: 'anthropic', ...overrides });

    it('sends correct request and parses response', async () => {
      const fetchMock = mockFetchResponse({
        content: [{ type: 'text', text: 'Hello world' }],
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const client = makeClient();
      const result = await client.complete([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Say hello' },
      ]);

      expect(result.content).toBe('Hello world');
      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
      expect(result.model).toBe('claude-sonnet-4-5-20250929');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify fetch call
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(opts.method).toBe('POST');
      expect(opts.headers['x-api-key']).toBe('test-key');
      expect(opts.headers['anthropic-version']).toBe('2023-06-01');

      const body = JSON.parse(opts.body);
      expect(body.system).toBe('You are helpful.');
      // System message should NOT appear in messages array
      expect(body.messages).toEqual([{ role: 'user', content: 'Say hello' }]);
    });

    it('handles response without system message', async () => {
      mockFetchResponse({
        content: [{ type: 'text', text: 'result' }],
        model: 'test',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const client = makeClient();
      const result = await client.complete([{ role: 'user', content: 'test' }]);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.system).toBeUndefined();
      expect(result.content).toBe('result');
    });

    it('handles empty content array gracefully', async () => {
      mockFetchResponse({
        content: [],
        model: 'test',
        usage: { input_tokens: 1, output_tokens: 0 },
      });

      const client = makeClient();
      const result = await client.complete([{ role: 'user', content: 'test' }]);
      expect(result.content).toBe('');
    });

    it('throws on HTTP error with status and body', async () => {
      mockFetchResponse('Rate limit exceeded', false, 429);

      const client = makeClient();
      await expect(client.complete([{ role: 'user', content: 'test' }]))
        .rejects.toThrow('Anthropic API error (429)');
    });

    it('throws on network error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('fetch failed'));

      const client = makeClient();
      await expect(client.complete([{ role: 'user', content: 'test' }]))
        .rejects.toThrow('fetch failed');
    });

    it('aborts on timeout', async () => {
      // Simulate a request that never resolves until abort
      global.fetch = jest.fn().mockImplementation((_url: string, opts: RequestInit) => {
        return new Promise((_resolve, reject) => {
          if (opts.signal) {
            opts.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
        });
      });

      const client = makeClient({ timeout: 50 });
      await expect(client.complete([{ role: 'user', content: 'test' }]))
        .rejects.toThrow();
    }, 10000);
  });

  describe('complete — OpenAI provider', () => {
    const makeClient = (overrides = {}) =>
      new LLMClient({ enabled: true, apiKey: 'test-key', provider: 'openai', ...overrides });

    it('sends correct request to OpenAI endpoint', async () => {
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'GPT response' } }],
        model: 'gpt-4',
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      });

      const client = makeClient();
      const result = await client.complete([
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hi' },
      ]);

      expect(result.content).toBe('GPT response');
      expect(result.inputTokens).toBe(8);
      expect(result.outputTokens).toBe(3);
      expect(result.model).toBe('gpt-4');

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(opts.headers['Authorization']).toBe('Bearer test-key');

      // OpenAI keeps system messages in the messages array
      const body = JSON.parse(opts.body);
      expect(body.messages).toHaveLength(2);
    });

    it('handles empty choices gracefully', async () => {
      mockFetchResponse({
        choices: [{ message: {} }],
        model: 'gpt-4',
        usage: { prompt_tokens: 1, completion_tokens: 0 },
      });

      const client = makeClient();
      const result = await client.complete([{ role: 'user', content: 'test' }]);
      expect(result.content).toBe('');
    });

    it('throws on HTTP error', async () => {
      mockFetchResponse('Server error', false, 500);

      const client = makeClient();
      await expect(client.complete([{ role: 'user', content: 'test' }]))
        .rejects.toThrow('OpenAI API error (500)');
    });
  });

  describe('complete — openai-compatible provider', () => {
    it('uses custom baseUrl when provided', async () => {
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'response' } }],
        model: 'llama-3',
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });

      const client = new LLMClient({
        enabled: true,
        apiKey: 'groq-key',
        provider: 'openai-compatible',
        baseUrl: 'https://api.groq.com/openai/v1',
      });

      await client.complete([{ role: 'user', content: 'test' }]);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    });

    it('falls back to OpenAI base URL when no baseUrl set', async () => {
      const fetchMock = mockFetchResponse({
        choices: [{ message: { content: 'response' } }],
        model: 'model',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });

      const client = new LLMClient({
        enabled: true,
        apiKey: 'key',
        provider: 'openai-compatible',
        // No baseUrl
      });

      await client.complete([{ role: 'user', content: 'test' }]);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
    });
  });

  describe('completeJSON', () => {
    const makeClient = () =>
      new LLMClient({ enabled: true, apiKey: 'k', provider: 'anthropic' });

    it('parses valid JSON response', async () => {
      mockFetchResponse({
        content: [{ type: 'text', text: '{"name": "test", "value": 42}' }],
        model: 'test',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const client = makeClient();
      const result = await client.completeJSON<{ name: string; value: number }>([
        { role: 'user', content: 'give json' },
      ]);
      expect(result).toEqual({ name: 'test', value: 42 });
    });

    it('strips markdown code fences before parsing', async () => {
      mockFetchResponse({
        content: [{ type: 'text', text: '```json\n{"key": "value"}\n```' }],
        model: 'test',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const client = makeClient();
      const result = await client.completeJSON<{ key: string }>([
        { role: 'user', content: 'give json' },
      ]);
      expect(result).toEqual({ key: 'value' });
    });

    it('strips code fences without language tag', async () => {
      mockFetchResponse({
        content: [{ type: 'text', text: '```\n{"a": 1}\n```' }],
        model: 'test',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const client = makeClient();
      const result = await client.completeJSON<{ a: number }>([
        { role: 'user', content: 'give json' },
      ]);
      expect(result).toEqual({ a: 1 });
    });

    it('returns null on invalid JSON', async () => {
      mockFetchResponse({
        content: [{ type: 'text', text: 'not valid json {{{' }],
        model: 'test',
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const client = makeClient();
      const result = await client.completeJSON([{ role: 'user', content: 'give json' }]);
      expect(result).toBeNull();
    });

    it('returns null on complete() failure', async () => {
      // Client is disabled, so complete() will throw
      const client = new LLMClient({ enabled: false });
      const result = await client.completeJSON([{ role: 'user', content: 'test' }]);
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// turbo.ts — Enhancement functions
// ---------------------------------------------------------------------------

describe('LLM Turbo Layer', () => {
  /**
   * Helper: create a client with mocked fetch that returns the given JSON
   * body as an Anthropic-style response.
   */
  function makeClientWithResponse(jsonBody: unknown) {
    const text = typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody);
    mockFetchResponse({
      content: [{ type: 'text', text }],
      model: 'test-model',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    return new LLMClient({ enabled: true, apiKey: 'test-key', provider: 'anthropic' });
  }

  function makeGoldSentence(overrides: Partial<GoldSentence> = {}): GoldSentence {
    return {
      text: 'test sentence',
      score: 0.5,
      sourceMemoryId: 'mem-1',
      ...overrides,
    };
  }

  describe('llmClassify', () => {
    it('returns classification for valid category', async () => {
      const client = makeClientWithResponse({ category: 'knowledge', confidence: 0.95 });
      const result = await llmClassify(client, 'TypeScript uses structural typing');

      expect(result).not.toBeNull();
      expect(result!.category).toBe('knowledge');
      expect(result!.confidence).toBe(0.95);
      expect(result!.method).toBe('llm');
    });

    it('clamps confidence to [0, 1]', async () => {
      const client = makeClientWithResponse({ category: 'event', confidence: 1.5 });
      const result = await llmClassify(client, 'something happened');

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(1);
    });

    it('clamps negative confidence to 0', async () => {
      const client = makeClientWithResponse({ category: 'profile', confidence: -0.5 });
      const result = await llmClassify(client, 'user prefs');

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0);
    });

    it('returns null for invalid category', async () => {
      const client = makeClientWithResponse({ category: 'invalid_cat', confidence: 0.9 });
      const result = await llmClassify(client, 'test');
      expect(result).toBeNull();
    });

    it('returns null when LLM returns null (parse failure)', async () => {
      const client = makeClientWithResponse('not json at all');
      const result = await llmClassify(client, 'test');
      expect(result).toBeNull();
    });

    it('handles all 5 valid categories', async () => {
      for (const cat of ['knowledge', 'profile', 'event', 'behavior', 'skill']) {
        const client = makeClientWithResponse({ category: cat, confidence: 0.8 });
        const result = await llmClassify(client, 'test content');
        expect(result).not.toBeNull();
        expect(result!.category).toBe(cat);
      }
    });
  });

  describe('llmExtract', () => {
    it('returns extracted data for knowledge category', async () => {
      const extracted = { definitions: ['TypeScript'], versions: ['5.0'] };
      const client = makeClientWithResponse(extracted);
      const result = await llmExtract(client, 'TypeScript 5.0 adds decorators', 'knowledge');
      expect(result).toEqual(extracted);
    });

    it('returns extracted data for each category', async () => {
      for (const cat of ['knowledge', 'profile', 'event', 'behavior', 'skill'] as const) {
        const data = { key: cat };
        const client = makeClientWithResponse(data);
        const result = await llmExtract(client, 'test content', cat);
        expect(result).toEqual(data);
      }
    });

    it('returns null on LLM failure', async () => {
      const client = makeClientWithResponse('broken json {{');
      const result = await llmExtract(client, 'content', 'knowledge');
      expect(result).toBeNull();
    });
  });

  describe('llmRerank', () => {
    it('returns empty array for empty input', async () => {
      // Should not even call the LLM
      const client = new LLMClient({ enabled: true, apiKey: 'k', provider: 'anthropic' });
      const result = await llmRerank(client, 'query', []);
      expect(result).toEqual([]);
    });

    it('reranks sentences by LLM scores', async () => {
      const sentences: GoldSentence[] = [
        makeGoldSentence({ text: 'first', score: 0.3, sourceMemoryId: 'a' }),
        makeGoldSentence({ text: 'second', score: 0.9, sourceMemoryId: 'b' }),
        makeGoldSentence({ text: 'third', score: 0.5, sourceMemoryId: 'c' }),
      ];

      const client = makeClientWithResponse([
        { index: 0, score: 0.2 },
        { index: 1, score: 0.95 },
        { index: 2, score: 0.7 },
      ]);

      const result = await llmRerank(client, 'test query', sentences);

      expect(result).not.toBeNull();
      expect(result!).toHaveLength(3);
      // Should be sorted descending by score
      expect(result![0].score).toBe(0.95);
      expect(result![1].score).toBe(0.7);
      expect(result![2].score).toBe(0.2);
    });

    it('includes sentences missed by LLM with original scores', async () => {
      const sentences: GoldSentence[] = [
        makeGoldSentence({ text: 'ranked', score: 0.5, sourceMemoryId: 'a' }),
        makeGoldSentence({ text: 'missed', score: 0.3, sourceMemoryId: 'b' }),
      ];

      // LLM only returns index 0
      const client = makeClientWithResponse([{ index: 0, score: 0.8 }]);

      const result = await llmRerank(client, 'query', sentences);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(2);
      // The missed sentence should still be in results with original score
      const missed = result!.find(s => s.text === 'missed');
      expect(missed).toBeDefined();
      expect(missed!.score).toBe(0.3);
    });

    it('clamps scores to [0, 1]', async () => {
      const sentences = [makeGoldSentence({ text: 'test', score: 0.5 })];

      const client = makeClientWithResponse([{ index: 0, score: 1.5 }]);
      const result = await llmRerank(client, 'query', sentences);

      expect(result).not.toBeNull();
      expect(result![0].score).toBe(1);
    });

    it('ignores out-of-bounds indices', async () => {
      const sentences = [makeGoldSentence({ text: 'only one', score: 0.5 })];

      const client = makeClientWithResponse([
        { index: 0, score: 0.9 },
        { index: 99, score: 0.1 }, // out of bounds, should be ignored
      ]);

      const result = await llmRerank(client, 'query', sentences);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
    });

    it('falls back to original batch on null LLM result', async () => {
      const sentences = [
        makeGoldSentence({ text: 'a', score: 0.8 }),
        makeGoldSentence({ text: 'b', score: 0.4 }),
      ];

      // Return non-JSON so completeJSON returns null
      const client = makeClientWithResponse('not json');
      const result = await llmRerank(client, 'query', sentences);

      expect(result).not.toBeNull();
      expect(result!).toHaveLength(2);
      // Should contain original sentences (sorted by score desc)
      expect(result![0].score).toBe(0.8);
      expect(result![1].score).toBe(0.4);
    });

    it('handles multi-batch reranking (>20 sentences)', async () => {
      // Create 25 sentences
      const sentences: GoldSentence[] = [];
      for (let i = 0; i < 25; i++) {
        sentences.push(makeGoldSentence({ text: `sentence-${i}`, score: 0.5, sourceMemoryId: `m-${i}` }));
      }

      // Mock fetch to respond to multiple calls
      let callCount = 0;
      global.fetch = jest.fn().mockImplementation(() => {
        callCount++;
        // First batch (20 items), second batch (5 items)
        const batchSize = callCount === 1 ? 20 : 5;
        const rankings: Array<{ index: number; score: number }> = [];
        for (let i = 0; i < batchSize; i++) {
          rankings.push({ index: i, score: (batchSize - i) / batchSize });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            content: [{ type: 'text', text: JSON.stringify(rankings) }],
            model: 'test',
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
          text: () => Promise.resolve(''),
        });
      });

      const client = new LLMClient({ enabled: true, apiKey: 'k', provider: 'anthropic' });
      const result = await llmRerank(client, 'query', sentences);

      expect(result).not.toBeNull();
      expect(result!).toHaveLength(25);
      // fetch should be called twice (2 batches)
      expect(global.fetch).toHaveBeenCalledTimes(2);
      // Results should be sorted by score descending
      for (let i = 0; i < result!.length - 1; i++) {
        expect(result![i].score).toBeGreaterThanOrEqual(result![i + 1].score);
      }
    });

    it('ignores negative indices', async () => {
      const sentences = [makeGoldSentence({ text: 'only', score: 0.5 })];
      const client = makeClientWithResponse([{ index: -1, score: 0.9 }, { index: 0, score: 0.7 }]);
      const result = await llmRerank(client, 'query', sentences);

      expect(result).not.toBeNull();
      // -1 is filtered out by the index >= 0 check
      expect(result!).toHaveLength(1);
      expect(result![0].score).toBe(0.7);
    });
  });

  describe('llmSummarize', () => {
    it('returns summary text', async () => {
      mockFetchResponse({
        content: [{ type: 'text', text: 'A concise summary of the content.' }],
        model: 'test',
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      const client = new LLMClient({ enabled: true, apiKey: 'k', provider: 'anthropic' });
      const result = await llmSummarize(client, 'Long content here...');
      expect(result).toBe('A concise summary of the content.');
    });

    it('includes context query in the prompt when provided', async () => {
      const fetchMock = mockFetchResponse({
        content: [{ type: 'text', text: 'Focused summary.' }],
        model: 'test',
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      const client = new LLMClient({ enabled: true, apiKey: 'k', provider: 'anthropic' });
      await llmSummarize(client, 'content', 'what is the version?');

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      const userMsg = body.messages.find((m: any) => m.role === 'user');
      expect(userMsg.content).toContain('what is the version?');
    });

    it('returns null on empty response', async () => {
      mockFetchResponse({
        content: [{ type: 'text', text: '   ' }],
        model: 'test',
        usage: { input_tokens: 50, output_tokens: 0 },
      });

      const client = new LLMClient({ enabled: true, apiKey: 'k', provider: 'anthropic' });
      const result = await llmSummarize(client, 'content');
      expect(result).toBeNull();
    });

    it('returns null on LLM error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

      const client = new LLMClient({ enabled: true, apiKey: 'k', provider: 'anthropic' });
      const result = await llmSummarize(client, 'content');
      expect(result).toBeNull();
    });

    it('returns null when client is unavailable', async () => {
      const client = new LLMClient({ enabled: false });
      const result = await llmSummarize(client, 'content');
      expect(result).toBeNull();
    });
  });
});
