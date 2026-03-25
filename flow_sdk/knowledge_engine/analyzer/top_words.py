import asyncio
import re

import tiktoken

from flow_sdk import service_log


def _sklearn_tfidf_vectorizer():
    from sklearn.feature_extraction.text import TfidfVectorizer

    return TfidfVectorizer()


_stopwords = None


async def _nltk_stopwords():
    global _stopwords
    if _stopwords is None:
        import nltk
        from nltk.corpus import stopwords

        # Download necessary NLTK data (if you haven't already)
        try:
            await asyncio.to_thread(nltk.data.find, "corpora/stopwords")
        except LookupError:
            service_log.info("Downloading NLTK stopwords. This may take a few seconds.")
            await asyncio.to_thread(nltk.download, "stopwords")

        _stopwords = await asyncio.to_thread(stopwords.words, "english")
    return _stopwords


_nlp = None


async def _spacy_model():
    global _nlp
    if _nlp is None:
        import spacy
        from spacy.cli.download import download as spacy_download

        # Load the multilingual NER model from spaCy
        try:
            _nlp = await asyncio.to_thread(spacy.load, "xx_ent_wiki_sm")
        except OSError:
            service_log.info("Downloading xx_ent_wiki_sm spaCy model. This may take a few seconds.")
            await asyncio.to_thread(spacy_download, "xx_ent_wiki_sm")
            _nlp = await asyncio.to_thread(spacy.load, "xx_ent_wiki_sm")
    return _nlp


async def get_top_words(text: str, n: int = 10) -> tuple[tuple[str], tuple[float]]:
    """
    Runs NER (Named Entity Resolution).
    Calculates TF-IDF (Term Frequency-Inverse Document Frequency).
    This is done on (Text + Entities - Stopwords) and returns the top N words.
    """
    try:
        # 1. Preprocessing: Remove special characters, Tokenization, Lowercasing, and Stop Word Removal
        stop_words = set(await _nltk_stopwords())
        text = re.sub(r"[^a-zA-Z\s]", "", text, re.I | re.A).strip()

        # Use spaCy for NER
        nlp = await _spacy_model()
        doc = nlp(text)
        tokens = []
        for token in doc:
            if token.ent_type_:
                # If it's a named entity, treat the whole entity as one token
                tokens.append(token.text.lower())
            else:
                # Tokenize using tiktoken
                tokenizer = tiktoken.get_encoding("cl100k_base")
                tiktoken_tokens = [tokenizer.decode([t]).strip().lower() for t in tokenizer.encode(token.text)]
                tokens.extend(tiktoken_tokens)
        # Remove stop words and short words
        tokens = [word for word in tokens if word not in stop_words and len(word) > 2]

        # 2. TF-IDF Calculation
        vectorizer = _sklearn_tfidf_vectorizer()
        vectorizer.fit([" ".join(tokens)])  # Fit on the tokenized text (as a single "document")
        tfidf_matrix = vectorizer.transform([" ".join(tokens)])
        feature_names = vectorizer.get_feature_names_out()
        tfidf_scores = tfidf_matrix.todense()
        scores = [tfidf_scores[0, i] for i in range(tfidf_scores.shape[1])]

        # 3.  Get top N words
        n = min(n, len(feature_names))
        top_indices = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[
            :n
        ]  # Get indices of top N scores
        top_words_and_scores: list[tuple[str, float]] = [
            (feature_names[i], scores[i]) for i in top_indices
        ]  # Create (word, score) tuples
        top_words, top_scores = zip(*top_words_and_scores)  # Unzip into two lists: words and scores
        return top_words, top_scores
    except Exception as e:
        service_log.highlighted_error(f"Error in get_top_words: {e}")
        return (), ()  # type: ignore
