import json, tempfile
from pathlib import Path
from flow_sdk.fs_store.operations.markdown_index_render import IndexMdJson, FileEntry, write_pair, load_index_md_json
from flow_sdk.llm_index.index_document import IndexDocument, IndexData, FileRef

with tempfile.TemporaryDirectory(prefix='review-sidecar-') as temp:
    folder=Path(temp)
    common=dict(typeid='markdown_index-00000000-0000-4000-8000-000000000000',vault_root=str(folder),folder_rel_path='',folder_name='docs',inputs_hash='hash',self_summary='Human readable summary',generated_at='2026-09-06')
    agent=IndexMdJson(**common,files=[FileEntry(name='a.md',rel_path='a.md',title='A',summary='One line',content_hash='abc')])
    write_pair(folder,agent)
    print('agent_writer_then_library_reader', IndexDocument.load(folder))
    library=IndexData(**common,files=[FileRef(name='a.md',title='A',summary='One line',content_hash='abc')])
    IndexDocument(library).write(folder)
    print('library_writer_then_agent_route_reader', load_index_md_json(folder/'index.md.json'))
