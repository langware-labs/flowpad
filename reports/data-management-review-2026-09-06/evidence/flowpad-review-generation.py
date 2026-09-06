import asyncio,tempfile
from pathlib import Path
from sqlalchemy import text
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
import flow_sdk.fs_store.fs_record as record_mod
from flow_sdk.fs_store.fs_record import FSRecord

async def main():
    with tempfile.TemporaryDirectory(prefix='review-generation-') as tmp:
        root=Path(tmp); asset=root/'a.md'; asset.write_text('unchanged searchable body')
        original=record_mod.shadow_dir_for
        record_mod.shadow_dir_for=lambda t,i: root/'shadow'/t/i
        try:
            record=FSRecord(type='review_note',id=mint_uuid(),asset_ref=str(asset));record.write_hash()
            driver=SQLiteDBDriver(DBConfig(database=str(root/'test.sqlite')));await driver.open()
            async with driver._session_ctx() as s:
                await s.execute(text("INSERT INTO entities(id,type,data) VALUES(:id,'review_note','{}')"), {'id':record.id})
                await s.execute(text('DROP TABLE entities_fts'))
                await s.execute(text('CREATE VIRTUAL TABLE entities_fts USING fts5(entity_id,type,name,indexed_content)'))
                await s.execute(text("INSERT INTO entities_fts VALUES(:id,'review_note','A','unchanged searchable body')"), {'id':record.id})
            await driver.close();await driver.open()
            async with driver._session_ctx(write=False) as s:
                rows=(await s.execute(text('SELECT COUNT(*) FROM entities'))).scalar()
                fts=(await s.execute(text('SELECT COUNT(*) FROM entities_fts'))).scalar()
            print({'rows_after_migration':rows,'fts_after_migration':fts,'index_required':record.index_required,'normal_index_fresh_expression':bool(record.id) and not record.index_required and bool(rows)})
            await driver.close()
        finally:
            record_mod.shadow_dir_for=original
asyncio.run(main())
