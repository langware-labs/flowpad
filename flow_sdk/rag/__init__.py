"""Retrieval over a folder of documents.

Pure, dependency-light pieces the RAG asset scripts are built from: a markdown chunker and a
vector store. Nothing here touches an entity, the database or the network — a RAG
implementation is a script in an asset folder, and these are the parts it imports.
"""
