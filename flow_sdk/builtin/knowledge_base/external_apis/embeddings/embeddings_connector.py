"""Embeddings connector stub for generating text embeddings."""

from typing import List
import numpy as np


async def generate_embeddings(texts: List[str]) -> List[List[float]]:
    """Generate embeddings for a list of texts.

    This is a stub implementation that returns random embeddings.
    In production, this should connect to an actual embedding service.

    Args:
        texts: List of texts to generate embeddings for.

    Returns:
        List of embedding vectors (each a list of floats).
    """
    # Return random embeddings as placeholder (dimension 384 common for small models)
    return [np.random.randn(384).tolist() for _ in texts]
