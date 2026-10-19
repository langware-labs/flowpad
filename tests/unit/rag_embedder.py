"""A real embedder for tests: L2-normalised character trigram counts.

Not a stub. It is a genuine bag-of-ngrams embedding, so cosine similarity actually means
something — two sentences about summer really do land nearer each other than either lands to a
sentence about a blizzard. That is what lets a test assert *ranking* rather than merely
asserting that a function was called.

The alternative, returning fixed vectors, proves the plumbing and nothing else: an index that
ranked its results backwards would pass every such test. Retrieval quality is the only thing a
RAG index does, so it is the thing the tests have to be able to see.

Deterministic and offline: the same text always yields the same vector, and no key is needed.
"""

from __future__ import annotations

import hashlib
import math

#: Vector width. Small enough to be quick, wide enough that unrelated trigrams rarely collide.
DIMENSIONS = 256

#: Character window. Trigrams survive typos and word endings the way whole words do not.
NGRAM = 3


def _bucket(gram: str) -> int:
    """Hashing trick: fold an unbounded vocabulary into a fixed width."""
    return int.from_bytes(hashlib.blake2b(gram.encode("utf-8"), digest_size=4).digest(), "big") % DIMENSIONS


def embed(text: str) -> list[float]:
    """One text to one unit vector."""
    vector = [0.0] * DIMENSIONS
    cleaned = " ".join(text.lower().split())
    for i in range(max(len(cleaned) - NGRAM + 1, 0)):
        vector[_bucket(cleaned[i : i + NGRAM])] += 1.0
    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0.0:  # empty or shorter than one n-gram: a zero vector matches nothing
        return vector
    return [v / norm for v in vector]


def embed_all(texts: list[str]) -> list[list[float]]:
    return [embed(t) for t in texts]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


__all__ = ["DIMENSIONS", "NGRAM", "cosine", "embed", "embed_all"]
