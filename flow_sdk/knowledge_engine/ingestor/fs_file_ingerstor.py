import asyncio
import logging

from fastapi import UploadFile

from flow_sdk.config import default_service_config
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.fs_entities import FSItem
from flow_sdk.builtin.knowledge_base import KnowledgeBase
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.knowledge_engine.crawler.crawler import crawl
from flow_sdk.knowledge_engine.knowledge_utils import get_text_splitter_for_extension
from flow_sdk.utils import sanitize_filename


async def ingest_fs_items(fs_items: list[FSItem], knowledge: KnowledgeBase, semaphore: asyncio.Semaphore):
    fs_chunks = await asyncio.gather(
        *(to_fs_chunks(fs_item, default_service_config.chunk_size, semaphore) for fs_item in fs_items)
    )
    all_fs_chunks = [fs_chunk for fs_chunk_list in fs_chunks if fs_chunk_list is not None for fs_chunk in fs_chunk_list]
    # Embed chunks concurrently
    await asyncio.gather(
        *(
            save_fs_items(knowledge, fs_item, fs_chunk, semaphore)
            for fs_item, fs_chunk in zip(fs_items, fs_chunks)
            if fs_chunk is not None
        ),
        knowledge.add_items_to_knowledge(all_fs_chunks),
    )


async def to_fs_chunks(fs_item: FSItem, chunk_size: int, semaphore: asyncio.Semaphore):
    if not fs_item.blob:
        return None
    if not isinstance(fs_item.blob, bytes):
        raise ValueError("Blob must be a string.")
    # Split blob into chunks
    text_splitter = get_text_splitter_for_extension(
        fs_item.extension,
        chunk_size=chunk_size,
    )
    async with semaphore:
        chunk_strings = await asyncio.to_thread(text_splitter.split_text, fs_item.blob.decode(fs_item.encoding))
    # If the blob is too small, return the whole blob as a single chunk
    if len(chunk_strings) == 0:
        return None
    if len(chunk_strings) == 1:
        fs_item.blob = chunk_strings[0].encode(fs_item.encoding)
        fs_item.size = len(fs_item.blob)
        fs_item.offset = 0
        return [fs_item]
    chunk_blobs = [chunk_blob.encode(fs_item.encoding) for chunk_blob in chunk_strings]
    # Calculate offsets
    offsets = []
    offset = 0
    for chunk_blob in chunk_blobs:
        offsets.append(offset)
        offset += len(chunk_blob)
    # Create FSItem for each chunk
    fs_chunks = [
        FSItem(
            display_name=fs_item.display_name,
            vfs_abs_path=fs_item.vfs_abs_path,
            encoding=fs_item.encoding,
            blob=chunk_blob,
            offset=offset,
            size=len(chunk_blob),
        )
        for offset, chunk_blob in zip(offsets, chunk_blobs)
    ]
    return fs_chunks


async def save_fs_items(
    knowledge: KnowledgeBase, fs_item_root: FSItem, fs_chunks: list[FSItem], semaphore: asyncio.Semaphore
):
    async with semaphore:
        # add knowledge -> fs_item_root -> fs_chunks to db
        await fs_item_root.save()
        await knowledge.attach_child(fs_item_root)
        await asyncio.gather(
            *(fs_item_root.add_child(fs_chunk) for fs_chunk in fs_chunks if fs_chunk.typeid != fs_item_root.typeid),
        )


async def ingest_text(
    vfs_path_start: str, current_knowledge: KnowledgeBase, text_i: int, text: str, semaphore: asyncio.Semaphore
):
    async with semaphore:
        striped_text = text.strip()
        encoded_text = striped_text.encode("utf-8")
        text_fs_file = FSItem(
            blob=encoded_text,
            encoding="utf-8",
            display_name=striped_text[:30],
            vfs_abs_path=f"{vfs_path_start}/text_{text_i}_{sanitize_filename(striped_text[:30])}.txt",
            size=len(encoded_text),
        )
        await text_fs_file.upload()
    await ingest_fs_items([text_fs_file], current_knowledge, semaphore)


async def ingest_deep_link(
    vfs_path_start: str,
    current_knowledge: KnowledgeBase,
    link_i: int,
    link: str,
    semaphore: asyncio.Semaphore,
    is_shallow: bool,
):
    async with semaphore:
        striped_link = link.strip()
        if is_shallow:
            max_depth, max_urls = (0, 1)
        else:
            max_depth, max_urls = (
                default_service_config.deep_crawl_max_depth,
                default_service_config.deep_crawl_max_urls,
            )
        link_markdowns = await crawl([striped_link], max_depth=max_depth, max_urls=max_urls)
        link_fs_items = [
            FSItem(
                blob=link_markdown.strip().encode("utf-8"),
                encoding="utf-8",
                display_name=url,
                vfs_abs_path=f"{vfs_path_start}/link_{link_i}_{deep_link_i}_{sanitize_filename(link)}.md",
                size=len(link_markdown.strip().encode("utf-8")),
            )
            for deep_link_i, (url, link_markdown) in enumerate(link_markdowns)
            if isinstance(link_markdown, str)
        ]

    async def upload_link_fs_items(link_fs_item: FSItem):
        async with semaphore:
            await link_fs_item.upload()

    upload_link_fs_items_results = await asyncio.gather(
        *(upload_link_fs_items(link_fs_item) for link_fs_item in link_fs_items),
        return_exceptions=True,
    )
    for upload_result in upload_link_fs_items_results:
        if isinstance(upload_result, Exception):
            logging.error(f"Failed to upload link {link}: {upload_result}")
    if all(isinstance(upload_result, Exception) for upload_result in upload_link_fs_items_results):
        raise Exception(f"Failed to upload link {link}: {upload_link_fs_items_results}")

    uploaded_link_fs_items = [
        link_fs_item
        for link_fs_item, upload_result in zip(link_fs_items, upload_link_fs_items_results)
        if not isinstance(upload_result, Exception)
    ]
    await ingest_fs_items(uploaded_link_fs_items, current_knowledge, semaphore)


async def ingest_file(
    vfs_path_start: str, current_knowledge: KnowledgeBase, file_i: int, file: UploadFile, semaphore: asyncio.Semaphore
):
    async with semaphore:
        filename = file.filename or "file"
        blob = await file.read()
        file_fs_file = FSItem(
            blob=blob,
            encoding="utf-8",
            display_name=filename,
            vfs_abs_path=f"{vfs_path_start}/file_{file_i}_{sanitize_filename(filename, allow_additional_chars='.')}",
            size=len(blob),
        )
        await file_fs_file.upload()
    await ingest_fs_items([file_fs_file], current_knowledge, semaphore)


async def ingest_resource(current_knowledge: KnowledgeBase, resource: TypeId, target_entity: Entity):
    # TODO Roy, just make current_knowledge dependent on resource instead.
    await asyncio.gather(current_knowledge.attach_child(resource), target_entity.add_dependency(resource))
