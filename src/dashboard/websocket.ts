/**
 * Titan Memory Dashboard WebSocket Server
 * Real-time event streaming for dashboard updates
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { validateDashboardToken, shouldBypassAuth } from '../utils/auth.js';

export interface DashboardEvent {
  event: string;
  data: unknown;
  timestamp: string;
}

export class DashboardWebSocket {
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start heartbeat to keep connections alive
    this.startHeartbeat();
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Auth check: allow localhost bypass, otherwise require valid token
    const remoteAddress = req.socket.remoteAddress;
    if (!shouldBypassAuth(remoteAddress)) {
      const url = new URL(req.url || '', 'http://localhost');
      const token = url.searchParams.get('token') ||
        req.headers.authorization?.replace('Bearer ', '');
      if (!validateDashboardToken(token ?? undefined)) {
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    const clientId = Date.now().toString(36);
    console.log(`Dashboard WebSocket client connected: ${clientId}`);

    this.clients.add(ws);

    // Send welcome message
    this.send(ws, {
      event: 'connected',
      data: { clientId, message: 'Connected to Titan Memory Dashboard' },
      timestamp: new Date().toISOString(),
    });

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch {
        console.warn('Invalid WebSocket message:', data.toString());
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      console.log(`Dashboard WebSocket client disconnected: ${clientId}`);
      this.clients.delete(ws);
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.clients.delete(ws);
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(ws: WebSocket, message: { type?: string; data?: unknown }): void {
    switch (message.type) {
      case 'ping':
        this.send(ws, {
          event: 'pong',
          data: {},
          timestamp: new Date().toISOString(),
        });
        break;

      case 'subscribe':
        // Could implement event subscriptions here
        this.send(ws, {
          event: 'subscribed',
          data: message.data,
          timestamp: new Date().toISOString(),
        });
        break;

      default:
        // Echo unknown messages for debugging
        this.send(ws, {
          event: 'echo',
          data: message,
          timestamp: new Date().toISOString(),
        });
    }
  }

  /**
   * Send message to single client
   */
  private send(ws: WebSocket, event: DashboardEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  /**
   * Broadcast event to all connected clients
   */
  broadcast(event: DashboardEvent): void {
    const message = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  /**
   * Start heartbeat to keep connections alive
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.broadcast({
        event: 'heartbeat',
        data: { clients: this.clients.size },
        timestamp: new Date().toISOString(),
      });
    }, 30000); // Every 30 seconds
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Close WebSocket server
   */
  close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all client connections
    for (const client of this.clients) {
      client.close(1000, 'Server shutting down');
    }
    this.clients.clear();

    // Close server
    this.wss.close();
  }
}
