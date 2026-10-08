"""
Titan Memory - Semantic Highlight Sidecar Service
Runs the Zilliz semantic-highlight-bilingual-v1 model as a local HTTP API.

Usage:
  python highlight-service.py [--port 8079] [--model-path ./models/semantic-highlight-bilingual-v1]

The MCP server calls this service for sentence-level semantic highlighting.
"""

import argparse
import os
import sys
import logging
from contextlib import asynccontextmanager

import torch
from transformers import AutoModel
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("highlight-service")

# Global model reference
_model = None

# Largest context accepted. Measured 2026-10-08 on M1 (CPU, inference_mode): 192k chars
# peaked at 5.5 GB and took 61 s. Larger inputs are refused with 413, never truncated
# silently, so a caller learns its input was too big instead of getting a partial highlight.
MAX_CONTEXT_CHARS = int(os.environ.get("HIGHLIGHT_MAX_CONTEXT_CHARS", "200000"))


class HighlightRequest(BaseModel):
    question: str = Field(..., description="Query text")
    context: str = Field(..., description="Document text to highlight")
    # 0.2, not 0.5. The model's absolute probabilities are low even when it is
    # very confident: measured 0.4517 / 0.5655 / 0.2719 on correct answers with
    # 544x separation from the next-best sentence. At 0.5 two of three realistic
    # queries returned an EMPTY highlight, which a caller reads as "nothing
    # relevant here" rather than "the threshold ate the answer".
    threshold: float = Field(0.2, description="Relevance threshold 0-1")
    return_sentence_metrics: bool = Field(True, description="Return per-sentence scores")


class HighlightResponse(BaseModel):
    highlighted_sentences: list[str]
    compression_rate: float
    sentence_probabilities: list[float] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup."""
    global _model
    model_path = app.state.model_path

    logger.info(f"Loading Zilliz semantic-highlight model from: {model_path}")
    _model = AutoModel.from_pretrained(model_path, trust_remote_code=True)

    # Move to GPU if available
    if torch.cuda.is_available():
        _model = _model.cuda()
        logger.info("Model loaded on GPU")
    else:
        logger.info("Model loaded on CPU")

    yield

    # Cleanup
    _model = None
    logger.info("Model unloaded")


app = FastAPI(
    title="Titan Semantic Highlight Service",
    version="1.0.0",
    lifespan=lifespan,
)


@app.post("/highlight", response_model=HighlightResponse)
async def highlight(req: HighlightRequest):
    """Score and highlight relevant sentences in context based on query."""
    if _model is None:
        return HighlightResponse(
            highlighted_sentences=[],
            compression_rate=0.0,
            sentence_probabilities=[],
        )

    if len(req.context) > MAX_CONTEXT_CHARS:
        logger.warning(f"refused context of {len(req.context)} chars (max {MAX_CONTEXT_CHARS})")
        raise HTTPException(status_code=413, detail=f"context exceeds {MAX_CONTEXT_CHARS} chars")
    logger.info(f"highlight request: context {len(req.context)} chars, question {len(req.question)} chars")

    # inference_mode, not plain process(): the model's batch inference path is not wrapped
    # in no_grad, so autograd kept every layer's activations. Memory then scaled with input
    # size: 12k chars peaked 7.9 GB, 24k exceeded 8 GB, and on 2026-10-06 it reached ~31 GB,
    # was OOM-killed 11 times, and the memory storm left M1's network links failed until
    # their DHCP leases expired. With inference_mode: 12k 2.4 GB, 192k 5.5 GB, back to ~2 GB.
    # The endpoint stays async (one request at a time on the event loop) on purpose:
    # a sync handler would run requests in parallel threads and multiply peak memory.
    with torch.inference_mode():
        result = _model.process(
            question=req.question,
            context=req.context,
            threshold=req.threshold,
            return_sentence_metrics=req.return_sentence_metrics,
        )

    return HighlightResponse(
        highlighted_sentences=result.get("highlighted_sentences", []),
        compression_rate=result.get("compression_rate", 0.0),
        sentence_probabilities=result.get("sentence_probabilities", []),
    )


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "ok",
        "model_loaded": _model is not None,
        "gpu_available": torch.cuda.is_available(),
    }


def main():
    parser = argparse.ArgumentParser(description="Titan Semantic Highlight Service")
    parser.add_argument("--port", type=int, default=8079, help="Port to listen on")
    parser.add_argument(
        "--model-path",
        type=str,
        default=os.path.join(os.path.dirname(__file__), "models", "semantic-highlight-bilingual-v1"),
        help="Path to the Zilliz model directory",
    )
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()

    # Check model exists
    if not os.path.exists(args.model_path):
        logger.error(f"Model not found at: {args.model_path}")
        logger.error("Download it first: hf download zilliz/semantic-highlight-bilingual-v1")
        sys.exit(1)

    app.state.model_path = args.model_path

    logger.info(f"Starting Titan Highlight Service on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
