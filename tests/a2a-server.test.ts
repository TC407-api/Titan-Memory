/**
 * A2A Server Tests
 * Comprehensive tests for lock management, conflict resolution,
 * subscription filtering, heartbeat timeout, and connection cleanup.
 * Tests the A2AServer class by simulating WebSocket message handling.
 */

import { EventEmitter } from 'events';
import { A2AServer } from '../src/a2a/server.js';
import {
  A2AMessage,
  AgentRegisterPayload,
  AgentHeartbeatPayload,
  LockRequestPayload,
  LockReleasePayload,
  SubscribePayload,
  UnsubscribePayload,
  ConflictResolutionPayload,
  serializeMessage,
  createMessageId,
} from '../src/a2a/protocol.js';

// Mock the auth module so all connections are allowed
jest.mock('../src/utils/auth.js', () => ({
  initAuth: jest.fn(),
  getAuthConfig: jest.fn(() => ({
    enabled: false,
    dashboardTokens: [],
    a2aTokens: [],
    tokenHeader: 'X-Titan-Token',
    allowLocalhostWithoutAuth: true,
  })),
  validateA2AToken: jest.fn(() => true),
  shouldBypassAuth: jest.fn(() => true),
}));

// ---- WebSocket mock ----

const WS_OPEN = 1;
const WS_CLOSED = 3;

class MockWebSocket extends EventEmitter {
  readyState = WS_OPEN;
  sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = WS_CLOSED;
    this.emit('close');
  }

  /** Helper: get all parsed messages sent by the server */
  getSentMessages(): A2AMessage[] {
    return this.sent.map(s => JSON.parse(s));
  }

  /** Helper: get the last sent message */
  lastMessage(): A2AMessage {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }

  /** Simulate receiving a raw WS message */
  simulateMessage(msg: A2AMessage) {
    this.emit('message', Buffer.from(serializeMessage(msg)));
  }
}

// ---- Helpers ----

function makeRegisterMsg(
  agentId: string,
  capabilities: string[] = ['memory_read', 'memory_write', 'coordinate'],
  resumeToken?: string,
): A2AMessage<AgentRegisterPayload> {
  return {
    id: createMessageId(),
    timestamp: new Date(),
    sender: agentId,
    type: 'agent.register',
    payload: {
      agent: {
        id: agentId,
        name: `Agent ${agentId}`,
        type: 'primary',
        capabilities: capabilities as any,
      },
      resumeToken,
    },
  };
}

function makeHeartbeatMsg(agentId: string): A2AMessage<AgentHeartbeatPayload> {
  return {
    id: createMessageId(),
    timestamp: new Date(),
    sender: agentId,
    type: 'agent.heartbeat',
    payload: { timestamp: new Date() },
  };
}

function makeLockRequestMsg(
  resource: LockRequestPayload['resource'],
  mode: 'exclusive' | 'shared' = 'exclusive',
  timeoutMs?: number,
): A2AMessage<LockRequestPayload> {
  return {
    id: createMessageId(),
    timestamp: new Date(),
    sender: 'agent',
    type: 'coordination.lock_request',
    payload: { resource, mode, timeoutMs },
  };
}

function makeLockReleaseMsg(
  lockId: string,
  resource: LockReleasePayload['resource'],
): A2AMessage<LockReleasePayload> {
  return {
    id: createMessageId(),
    timestamp: new Date(),
    sender: 'agent',
    type: 'coordination.lock_release',
    payload: { lockId, resource },
  };
}

function makeSubscribeMsg(
  filter: SubscribePayload['filter'],
): A2AMessage<SubscribePayload> {
  return {
    id: createMessageId(),
    timestamp: new Date(),
    sender: 'agent',
    type: 'subscribe',
    payload: { filter },
  };
}

function makeUnsubscribeMsg(subscriptionId: string): A2AMessage<UnsubscribePayload> {
  return {
    id: createMessageId(),
    timestamp: new Date(),
    sender: 'agent',
    type: 'unsubscribe',
    payload: { subscriptionId },
  };
}

// ---- Utility to register an agent via the server's internal handling ----

/**
 * Start server, connect a mock WS, register it, and return both.
 * The server is started on a random port to avoid conflicts.
 */
async function setupServerAndAgent(
  agentId: string,
  capabilities?: string[],
  serverConfig?: Record<string, unknown>,
) {
  const port = 29000 + Math.floor(Math.random() * 1000);
  const server = new A2AServer({ port, ...serverConfig });
  await server.start();

  const ws = new MockWebSocket();
  // Trigger the connection handler via the internal WSS
  // We access the private wss to simulate a connection
  (server as any).handleConnection(ws as any);

  // Register the agent
  ws.simulateMessage(makeRegisterMsg(agentId, capabilities));

  // The server should have sent an agent.registered reply
  const regMsg = ws.lastMessage();
  expect(regMsg.type).toBe('agent.registered');

  return { server, ws, port };
}

// ==================== Tests ====================

describe('A2AServer - Lock Grant / Deny / Queue', () => {
  let server: A2AServer;
  let ws1: MockWebSocket;
  let ws2: MockWebSocket;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should grant an exclusive lock when no lock exists', async () => {
    ({ server, ws: ws1 } = await setupServerAndAgent('agent-1'));

    const resource = { type: 'memory' as const, memoryId: 'mem-1' };
    ws1.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));

    const reply = ws1.lastMessage();
    expect(reply.type).toBe('coordination.lock_granted');
    expect(reply.payload).toHaveProperty('lockId');
    expect(reply.payload).toHaveProperty('expiresAt');
  });

  it('should deny exclusive lock when resource is already locked', async () => {
    const port = 29900 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    // Agent 1
    ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-1'));

    // Agent 2
    ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-2'));

    const resource = { type: 'memory' as const, memoryId: 'mem-1' };

    // Agent 1 grabs lock
    ws1.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    expect(ws1.lastMessage().type).toBe('coordination.lock_granted');

    // Agent 2 tries same resource
    ws2.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    const deny = ws2.lastMessage();
    expect(deny.type).toBe('coordination.lock_denied');
    expect(deny.payload).toHaveProperty('reason', 'already_locked');
    expect(deny.payload).toHaveProperty('waitQueuePosition', 1);
  });

  it('should allow shared locks to coexist', async () => {
    const port = 29800 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-1'));

    ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-2'));

    const resource = { type: 'memory' as const, memoryId: 'mem-shared' };

    // Both request shared locks
    ws1.simulateMessage(makeLockRequestMsg(resource, 'shared'));
    expect(ws1.lastMessage().type).toBe('coordination.lock_granted');

    ws2.simulateMessage(makeLockRequestMsg(resource, 'shared'));
    expect(ws2.lastMessage().type).toBe('coordination.lock_granted');
  });

  it('should deny lock when wait queue is full', async () => {
    const port = 29700 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port, maxWaitQueueSize: 1 });
    await server.start();

    // Register 3 agents
    ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-1'));

    ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-2'));

    const ws3 = new MockWebSocket();
    (server as any).handleConnection(ws3 as any);
    ws3.simulateMessage(makeRegisterMsg('agent-3'));

    const resource = { type: 'memory' as const, memoryId: 'mem-q' };

    // Agent 1 grabs lock
    ws1.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    expect(ws1.lastMessage().type).toBe('coordination.lock_granted');

    // Agent 2 enters queue (queue size 1)
    ws2.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    expect(ws2.lastMessage().type).toBe('coordination.lock_denied');
    expect((ws2.lastMessage().payload as any).reason).toBe('already_locked');

    // Agent 3 should be denied with queue_full
    ws3.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    expect(ws3.lastMessage().type).toBe('coordination.lock_denied');
    expect((ws3.lastMessage().payload as any).reason).toBe('queue_full');
  });

  it('should grant lock to next waiter on release', async () => {
    const port = 29600 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port, maxWaitQueueSize: 10 });
    await server.start();

    ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-1'));

    ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-2'));

    const resource = { type: 'memory' as const, memoryId: 'mem-wait' };

    // Agent 1 grabs lock
    ws1.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    const lockGrant = ws1.lastMessage();
    expect(lockGrant.type).toBe('coordination.lock_granted');
    const lockId = (lockGrant.payload as any).lockId;

    // Agent 2 tries, gets queued
    ws2.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    expect(ws2.lastMessage().type).toBe('coordination.lock_denied');

    // Agent 1 releases lock
    ws1.simulateMessage(makeLockReleaseMsg(lockId, resource));

    // Agent 2 should now get a lock_granted
    const ws2Messages = ws2.getSentMessages();
    const grantedMsg = ws2Messages.find(m => m.type === 'coordination.lock_granted');
    expect(grantedMsg).toBeDefined();
  });

  it('should reject lock request from unregistered agent', async () => {
    const port = 29500 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);

    // Do NOT register, just request lock
    const resource = { type: 'memory' as const, memoryId: 'mem-1' };
    ws.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));

    const reply = ws.lastMessage();
    expect(reply.type).toBe('error');
    expect((reply.payload as any).code).toBe('AGENT_NOT_REGISTERED');
  });

  it('should reject lock request from agent without coordinate capability', async () => {
    const port = 29400 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('agent-nocap', ['memory_read']));

    const resource = { type: 'memory' as const, memoryId: 'mem-1' };
    ws.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));

    const reply = ws.lastMessage();
    expect(reply.type).toBe('error');
    expect((reply.payload as any).code).toBe('INVALID_CAPABILITY');
  });
});

describe('A2AServer - Lock key generation for all resource types', () => {
  let server: A2AServer;
  let ws: MockWebSocket;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it.each([
    [{ type: 'memory' as const, memoryId: 'mem-1' }],
    [{ type: 'layer' as const, layer: 'semantic' }],
    [{ type: 'project' as const, projectId: 'proj-1' }],
    [{ type: 'global' as const }],
  ])('should grant lock for resource type %j', async (resource) => {
    ({ server, ws } = await setupServerAndAgent('agent-lr'));
    ws.simulateMessage(makeLockRequestMsg(resource as any, 'exclusive'));
    expect(ws.lastMessage().type).toBe('coordination.lock_granted');
  });
});

describe('A2AServer - Subscription Filtering', () => {
  let server: A2AServer;
  let ws1: MockWebSocket;
  let ws2: MockWebSocket;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should subscribe and receive matching events', async () => {
    const port = 28900 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-sub1'));

    ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-sub2'));

    // Agent 1 subscribes to memory.added events
    ws1.simulateMessage(makeSubscribeMsg({ eventTypes: ['memory.added'] }));
    const subAck = ws1.lastMessage();
    expect(subAck.type).toBe('subscribe_ack');
    expect(subAck.payload).toHaveProperty('subscriptionId');

    // Agent 2 broadcasts a memory.added event
    const memAddMsg: A2AMessage = {
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'agent-sub2',
      type: 'memory.added',
      payload: { memoryId: 'mem-1', content: 'test' },
    };
    ws2.simulateMessage(memAddMsg);

    // Agent 1 should receive the broadcast
    const ws1Messages = ws1.getSentMessages();
    const broadcastMsg = ws1Messages.find(m => m.type === 'memory.added');
    expect(broadcastMsg).toBeDefined();
  });

  it('should NOT deliver events that do not match filter', async () => {
    const port = 28800 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-filter1'));

    ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-filter2'));

    // Subscribe only to memory.deleted
    ws1.simulateMessage(makeSubscribeMsg({ eventTypes: ['memory.deleted'] }));

    const sentBefore = ws1.sent.length;

    // Send memory.added (should NOT match)
    const memAddMsg: A2AMessage = {
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'agent-filter2',
      type: 'memory.added',
      payload: { memoryId: 'mem-1' },
    };
    ws2.simulateMessage(memAddMsg);

    // Agent 1 should NOT have received the broadcast
    expect(ws1.sent.length).toBe(sentBefore);
  });

  it('should filter by agentIds in subscription', async () => {
    const port = 28700 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('listener'));

    ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('sender-a'));

    const ws3 = new MockWebSocket();
    (server as any).handleConnection(ws3 as any);
    ws3.simulateMessage(makeRegisterMsg('sender-b'));

    // Subscribe only to events from sender-a
    ws1.simulateMessage(makeSubscribeMsg({ agentIds: ['sender-a'] }));

    const sentBefore = ws1.sent.length;

    // sender-b sends an event
    ws3.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'sender-b',
      type: 'memory.added',
      payload: {},
    });

    // listener should NOT receive it
    expect(ws1.sent.length).toBe(sentBefore);

    // sender-a sends an event
    ws2.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'sender-a',
      type: 'memory.added',
      payload: {},
    });

    // listener SHOULD receive it
    expect(ws1.sent.length).toBe(sentBefore + 1);
  });

  it('should unsubscribe successfully', async () => {
    ({ server, ws: ws1 } = await setupServerAndAgent('agent-unsub'));

    ws1.simulateMessage(makeSubscribeMsg({ eventTypes: ['memory.added'] }));
    const subAck = ws1.lastMessage();
    const subscriptionId = (subAck.payload as any).subscriptionId;

    ws1.simulateMessage(makeUnsubscribeMsg(subscriptionId));
    const unsubAck = ws1.lastMessage();
    expect(unsubAck.type).toBe('unsubscribe_ack');
    expect((unsubAck.payload as any).success).toBe(true);
  });

  it('should return success=false for unknown subscription ID', async () => {
    ({ server, ws: ws1 } = await setupServerAndAgent('agent-unsub2'));

    ws1.simulateMessage(makeUnsubscribeMsg('nonexistent-sub'));
    const unsubAck = ws1.lastMessage();
    expect(unsubAck.type).toBe('unsubscribe_ack');
    expect((unsubAck.payload as any).success).toBe(false);
  });

  it('should reject subscribe from unregistered agent', async () => {
    const port = 28600 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);

    ws.simulateMessage(makeSubscribeMsg({ eventTypes: ['memory.added'] }));
    expect(ws.lastMessage().type).toBe('error');
    expect((ws.lastMessage().payload as any).code).toBe('AGENT_NOT_REGISTERED');
  });
});

describe('A2AServer - Heartbeat Timeout & Connection Cleanup', () => {
  let server: A2AServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should disconnect agent after heartbeat timeout', async () => {
    jest.useFakeTimers();

    const port = 28500 + Math.floor(Math.random() * 100);
    server = new A2AServer({
      port,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 200,
    });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('agent-timeout'));

    expect(server.getStats().connectedAgents).toBe(1);

    const disconnectPromise = new Promise<void>(resolve => {
      server.on('agentDisconnected', ({ agentId, reason }: any) => {
        expect(agentId).toBe('agent-timeout');
        expect(reason).toBe('timeout');
        resolve();
      });
    });

    // Advance time past heartbeat timeout
    jest.advanceTimersByTime(250);

    await disconnectPromise;
    expect(server.getStats().connectedAgents).toBe(0);

    jest.useRealTimers();
  });

  it('should reset heartbeat timer on heartbeat message', async () => {
    jest.useFakeTimers();

    const port = 28400 + Math.floor(Math.random() * 100);
    server = new A2AServer({
      port,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 200,
    });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('agent-hb'));

    // Advance 150ms (within timeout)
    jest.advanceTimersByTime(150);
    expect(server.getStats().connectedAgents).toBe(1);

    // Send heartbeat to reset timer
    ws.simulateMessage(makeHeartbeatMsg('agent-hb'));

    // Verify heartbeat_ack response
    const ackMsg = ws.getSentMessages().find(m => m.type === 'agent.heartbeat_ack');
    expect(ackMsg).toBeDefined();

    // Advance another 150ms (still within new timeout window)
    jest.advanceTimersByTime(150);
    expect(server.getStats().connectedAgents).toBe(1);

    jest.useRealTimers();
  });

  it('should reject heartbeat from unregistered agent', async () => {
    const port = 28350 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);

    ws.simulateMessage(makeHeartbeatMsg('ghost-agent'));
    expect(ws.lastMessage().type).toBe('error');
    expect((ws.lastMessage().payload as any).code).toBe('AGENT_NOT_REGISTERED');
  });

  it('should clean up locks and subscriptions on disconnect', async () => {
    const port = 28300 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('agent-cleanup'));

    // Acquire a lock
    const resource = { type: 'memory' as const, memoryId: 'mem-cleanup' };
    ws.simulateMessage(makeLockRequestMsg(resource, 'exclusive'));
    expect(ws.lastMessage().type).toBe('coordination.lock_granted');

    // Subscribe
    ws.simulateMessage(makeSubscribeMsg({ eventTypes: ['memory.added'] }));
    expect(ws.lastMessage().type).toBe('subscribe_ack');

    expect(server.getStats().connectedAgents).toBe(1);
    expect(server.getStats().activeLocks).toBe(1);
    expect(server.getStats().activeSubscriptions).toBe(1);

    // Simulate WS close
    ws.emit('close');

    expect(server.getStats().connectedAgents).toBe(0);
    expect(server.getStats().activeLocks).toBe(0);
    expect(server.getStats().activeSubscriptions).toBe(0);
  });

  it('should handle WS error and disconnect agent', async () => {
    const port = 28250 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('agent-err'));

    expect(server.getStats().connectedAgents).toBe(1);

    ws.emit('error', new Error('Connection reset'));

    expect(server.getStats().connectedAgents).toBe(0);
  });
});

describe('A2AServer - Conflict Resolution', () => {
  let server: A2AServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should detect conflict on concurrent memory updates', async () => {
    const port = 28200 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port, enableConflictDetection: true });
    await server.start();

    const ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('writer-1'));

    const ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('writer-2'));

    // Subscribe both to receive conflict notifications
    ws1.simulateMessage(makeSubscribeMsg({ eventTypes: ['conflict.detected'] }));
    ws2.simulateMessage(makeSubscribeMsg({ eventTypes: ['conflict.detected'] }));

    const conflictPromise = new Promise<void>(resolve => {
      server.on('conflictDetected', (payload: any) => {
        expect(payload.memoryId).toBe('mem-conflict');
        expect(payload.conflictingAgents).toContain('writer-1');
        expect(payload.conflictingAgents).toContain('writer-2');
        resolve();
      });
    });

    // Both agents update the same memory
    ws1.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'writer-1',
      type: 'memory.updated',
      payload: { memoryId: 'mem-conflict', newContent: 'version A' },
    });

    ws2.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'writer-2',
      type: 'memory.updated',
      payload: { memoryId: 'mem-conflict', newContent: 'version B' },
    });

    await conflictPromise;
  });

  it('should handle conflict resolution from arbitrator', async () => {
    const port = 28100 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port, enableConflictDetection: true });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('arbitrator', ['memory_read', 'memory_write', 'coordinate', 'arbitrate']));

    const resolvedPromise = new Promise<void>(resolve => {
      server.on('conflictResolved', (payload: any) => {
        expect(payload.conflictId).toBe('conflict-1');
        expect(payload.strategy).toBe('last_write_wins');
        resolve();
      });
    });

    const resolutionMsg: A2AMessage<ConflictResolutionPayload> = {
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'arbitrator',
      type: 'conflict.resolution',
      payload: {
        conflictId: 'conflict-1',
        memoryId: 'mem-conflict',
        strategy: 'last_write_wins',
        resolvedContent: 'resolved content',
        resolvedBy: 'arbitrator',
      },
    };
    ws.simulateMessage(resolutionMsg);

    await resolvedPromise;
  });

  it('should ignore conflict resolution from non-arbitrator agent', async () => {
    const port = 28050 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port, enableConflictDetection: true });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('non-arb', ['memory_read', 'memory_write']));

    const handler = jest.fn();
    server.on('conflictResolved', handler);

    ws.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'non-arb',
      type: 'conflict.resolution',
      payload: {
        conflictId: 'conflict-1',
        memoryId: 'mem-1',
        strategy: 'last_write_wins',
        resolvedContent: 'attempt',
        resolvedBy: 'non-arb',
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('A2AServer - Agent Registration Edge Cases', () => {
  let server: A2AServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should reject registration when max agents reached', async () => {
    const port = 27900 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port, maxAgents: 1 });
    await server.start();

    // Register first agent
    const ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-1'));
    expect(ws1.lastMessage().type).toBe('agent.registered');

    // Second agent should be rejected
    const ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-2'));

    const errMsg = ws2.lastMessage();
    expect(errMsg.type).toBe('error');
    expect((errMsg.payload as any).code).toBe('RATE_LIMITED');
  });

  it('should handle agent resume with token', async () => {
    const port = 27800 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    // Register first time
    const ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-resume'));

    const regMsg = ws1.lastMessage();
    const resumeToken = (regMsg.payload as any).resumeToken;
    expect(resumeToken).toBeDefined();

    // Simulate disconnect
    ws1.emit('close');

    // Re-register with resume token
    const ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('different-id', undefined, resumeToken));

    const regMsg2 = ws2.lastMessage();
    expect(regMsg2.type).toBe('agent.registered');
    // Should get the original agent ID back
    expect((regMsg2.payload as any).agent.id).toBe('agent-resume');
  });

  it('should replace existing connection for same agent ID', async () => {
    const port = 27700 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-replace'));

    expect(server.getStats().connectedAgents).toBe(1);

    // Register again with same ID on new WS
    const ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-replace'));

    expect(server.getStats().connectedAgents).toBe(1);
    expect(ws2.lastMessage().type).toBe('agent.registered');
  });

  it('should handle disconnect message from agent', async () => {
    ({ server } = await setupServerAndAgent('agent-bye'));
    expect(server.getStats().connectedAgents).toBe(1);

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('agent-bye2'));

    ws.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'agent-bye2',
      type: 'agent.disconnect',
      payload: { reason: 'client_disconnect' },
    });

    // After explicit disconnect, agent count should decrease
    // (agent-bye is still connected, agent-bye2 disconnected)
    expect(server.getStats().connectedAgents).toBe(1);
  });
});

describe('A2AServer - Agent List', () => {
  let server: A2AServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should list all connected agents', async () => {
    const port = 27600 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-list-1'));

    const ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-list-2', ['memory_read']));

    // Request agent list
    ws1.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'agent-list-1',
      type: 'agent.list',
      payload: { filter: {} },
    });

    const listResponse = ws1.lastMessage();
    expect(listResponse.type).toBe('agent.list_response');
    expect((listResponse.payload as any).totalCount).toBe(2);
  });

  it('should filter agents by capability', async () => {
    const port = 27550 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws1 = new MockWebSocket();
    (server as any).handleConnection(ws1 as any);
    ws1.simulateMessage(makeRegisterMsg('agent-cap-1', ['memory_read', 'memory_write', 'coordinate']));

    const ws2 = new MockWebSocket();
    (server as any).handleConnection(ws2 as any);
    ws2.simulateMessage(makeRegisterMsg('agent-cap-2', ['memory_read']));

    ws1.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'agent-cap-1',
      type: 'agent.list',
      payload: { filter: { capability: 'coordinate' } },
    });

    const listResponse = ws1.lastMessage();
    expect(listResponse.type).toBe('agent.list_response');
    expect((listResponse.payload as any).totalCount).toBe(1);
    expect((listResponse.payload as any).agents[0].id).toBe('agent-cap-1');
  });
});

describe('A2AServer - Error Handling', () => {
  let server: A2AServer;

  afterEach(async () => {
    if (server) await server.stop();
  });

  it('should send error for invalid/unparseable message', async () => {
    const port = 27500 + Math.floor(Math.random() * 100);
    server = new A2AServer({ port });
    await server.start();

    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);

    // Send garbage data
    ws.emit('message', Buffer.from('this is not json'));

    const errMsg = ws.lastMessage();
    expect(errMsg.type).toBe('error');
    expect((errMsg.payload as any).code).toBe('INVALID_MESSAGE');
  });

  it('should send error for unknown message type', async () => {
    ({ server } = await setupServerAndAgent('agent-unknown'));
    const ws = new MockWebSocket();
    (server as any).handleConnection(ws as any);
    ws.simulateMessage(makeRegisterMsg('agent-unknown2'));

    ws.simulateMessage({
      id: createMessageId(),
      timestamp: new Date(),
      sender: 'agent-unknown2',
      type: 'totally.fake.type' as any,
      payload: {},
    });

    const errMsg = ws.lastMessage();
    expect(errMsg.type).toBe('error');
    expect((errMsg.payload as any).code).toBe('INVALID_MESSAGE');
  });
});
