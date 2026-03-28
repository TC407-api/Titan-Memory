/**
 * ContextDelegate - Extracted from TitanMemory
 * Handles context capture and buffer management
 */

import { ContextCaptureManager } from '../utils/context-capture.js';
import { ContextCaptureResult } from '../types.js';

export class ContextDelegate {
  constructor(
    private getContextCaptureManager: () => ContextCaptureManager | undefined,
    private getCurrentMomentum: () => number,
  ) {}

  /**
   * Capture context automatically based on momentum
   * Feature 4: Auto Context Capture
   */
  async captureContext(
    trigger: string,
    momentum?: number
  ): Promise<ContextCaptureResult | null> {
    const mgr = this.getContextCaptureManager();
    if (!mgr) {
      return null;
    }

    const currentMomentum = momentum ?? this.getCurrentMomentum();
    return mgr.captureContext(trigger, currentMomentum);
  }

  /**
   * Update context buffer for auto-capture
   * Feature 4: Auto Context Capture
   */
  updateContextBuffer(content: string): void {
    const mgr = this.getContextCaptureManager();
    if (mgr) {
      mgr.addToBuffer(content);
    }
  }
}
