import asyncio

from flow_sdk.builtin.fs_entities import FSItem
from flow_sdk.db.drivers.query import QueryFilter

from flow_sdk.config import default_service_config
from flow_sdk.api.type_id import TypeId


def consolidate_knowledge_items(knowledge_items: list[FSItem]):
    sorted_knowledge_items = sorted(knowledge_items, key=lambda x: (x.vfs_abs_path, x.offset, -x.size))
    consolidated_knowledge_items: list[FSItem] = []
    for chunk in sorted_knowledge_items:
        if not consolidated_knowledge_items or chunk.vfs_abs_path != consolidated_knowledge_items[-1].vfs_abs_path:
            consolidated_knowledge_items.append(chunk)
        else:
            if chunk.offset > consolidated_knowledge_items[-1].offset + consolidated_knowledge_items[-1].size:
                consolidated_knowledge_items.append(chunk)
    return consolidated_knowledge_items


async def query_knowledge(
    query_string: str, root_scope_typeid: TypeId, context_typeids: list[TypeId], num_of_results: int
):
    results = await asyncio.gather(
        query_target_fs_items_recent(context_typeids, default_service_config.knowledge_recent_num_of_results),
        query_all_fs_items_fulltext(query_string, root_scope_typeid, num_of_results),
        query_all_fs_items_vector(query_string, root_scope_typeid, num_of_results),
    )

    recent_fs_items = results[0]
    fulltext_fs_items = results[1]
    vector_fs_items = results[2]
    # Combine results ensuring distinct items
    all_fs_items = list(set(recent_fs_items + fulltext_fs_items + vector_fs_items))
    consolidated_items = consolidate_knowledge_items(all_fs_items)

    return consolidated_items


async def query_all_fs_items_fulltext(query_string: str, root_scope_typeid: TypeId, num_of_results: int):
    return []
    # fulltext_query = " ".join(list(await get_top_words(query_string, 10)[0]))
    # if not fulltext_query:
    #     return [], []
    # knowledge_items_by_description, scores = await FSItem.query_fulltext_index(
    #     fulltext_query,
    #     num_of_results,
    #     "description",
    #     None,
    #     root_scope_typeid,
    # )

    # filtered_knowledge_items_by_description = [
    #     entity
    #     for entity, score in zip(knowledge_items_by_description, scores)
    #     if score > default_service_config.knowledge_fulltext_score_threshold
    # ]
    # fs_chunk_ancestors = await FSItem.get_ancestors(filtered_knowledge_items_by_description)
    # return filtered_knowledge_items_by_description, fs_chunk_ancestors


async def query_target_fs_items_recent(context_typeids: list[TypeId], num_of_results: int):
    knowledge_items_by_recent = await asyncio.gather(
        *[
            FSItem.get_all(
                entities_filter=QueryFilter(limit=num_of_results, order_by={"created_date": "desc"}),
                source_entity=context_typeid,
            )
            for context_typeid in context_typeids
        ]
    )
    return [fs_item for items in knowledge_items_by_recent for fs_item in items]


async def query_all_fs_items_vector(query_string: str, root_scope_typeid: TypeId, num_of_results: int):
    fs_items_by_description, scores = await FSItem.query_vector_index(
        query_string,
        num_of_results,
        "blob_embedding",
        None,
        root_scope_typeid,
    )
    filtered_fs_items_by_description = [
        item
        for item, score in zip(fs_items_by_description, scores)
        if score > default_service_config.knowledge_vector_score_threshold
    ]
    return filtered_fs_items_by_description
