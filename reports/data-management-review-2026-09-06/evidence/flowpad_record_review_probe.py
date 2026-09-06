import asyncio, json, os, runpy, tempfile
from pathlib import Path
runpy.run_path('tests/conftest.py')
import flow_sdk.db.drivers.db_driver as dbmod
import flow_sdk.fs_store.indexer.registrations
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_paths import set_default_records_root
from sqlalchemy import text

async def main():
    with tempfile.TemporaryDirectory(prefix='flowpad-review-record-') as d:
        root=Path(d); set_default_records_root(root/'records')
        cfg=DBConfig(database=str(root/'review.db'), pooled=False)
        driver=SQLiteDBDriver(cfg); await driver.open()
        dbmod._driver_instances['sqlite']=driver; Entity._db=driver
        try:
            info=SchemaRegistry.get('markdown')
            src=root/'doc.md'; src.write_text('---\ntitle: Before\n---\n\noldworduniquetoken\n')
            rec=info.record_for(FSRef(src)); rec.save(); await rec.sync_to_db(notify=False); rec.write_hash()
            entity=await SchemaRegistry.get_entity_cls('markdown').get_one({'id':rec.id})
            src.write_text(src.read_text().replace('Before','Afterward').replace('oldworduniquetoken','newworduniquetoken'))
            st=src.stat(); os.utime(src, ns=(st.st_atime_ns,st.st_mtime_ns+1_000_000_000))
            print('before_refresh', json.dumps({'stale':FSRecord.load('markdown',rec.id).index_required,'db_title':entity.title,'updated_date':str(entity.updated_date)}))
            refreshed=await entity.check_and_refresh_record()
            row=await SchemaRegistry.get_entity_cls('markdown').get_one({'id':rec.id})
            async with driver._session_ctx(write=False) as s:
                fts=(await s.execute(text('SELECT title, content FROM entities_fts WHERE entity_id=:id'), {'id':rec.id})).first()
            print('after_refresh', json.dumps({'refreshed':refreshed,'stale':FSRecord.load('markdown',rec.id).index_required,'db_title':row.title,'updated_date':str(row.updated_date),'fts':list(fts),'fresh_parse_title':info.record_for(FSRef(src)).__dict__.get('title')}))
            async with driver._session_ctx(write=False) as parent:
                async def child():
                    async with driver._session_ctx(write=False) as child_session:
                        return child_session is parent
                print('child_inherits_exact_parent_session', await asyncio.create_task(child()))
            from flow_sdk.tags import on_tag
            emitted=[]
            unsub=on_tag('entity.created', lambda evt: emitted.append(evt.data['id']))
            failure_src=root/'rollback.md';failure_src.write_text('---\ntitle: rollback\n---\nrollbacktoken')
            failure_rec=info.record_for(FSRef(failure_src));failure_rec.save()
            original_fts=driver.fts_upsert
            async def fail_fts(*args, **kwargs):
                raise RuntimeError('review injected FTS failure')
            driver.fts_upsert=fail_fts
            try:
                await failure_rec.sync_to_db()
            except RuntimeError:
                pass
            finally:
                driver.fts_upsert=original_fts;unsub()
            failure_row=await SchemaRegistry.get_entity_cls('markdown').get_one({'id':failure_rec.id})
            print('rollback_order',json.dumps({'create_event_emitted':failure_rec.id in emitted,'row_exists_after_rollback':failure_row is not None,'shadow_exists':failure_rec.metadata_ref._path.exists()}))
            big_src=root/'large.md';big_src.write_text('x'*1_000_000)
            big=info.record_for(FSRef(big_src));big.save()
            print('projection_size',json.dumps({'asset_bytes':big_src.stat().st_size,'shadow_bytes':big.metadata_ref._path.stat().st_size,'body_chars':len(big.__dict__.get('body','')),'content_chars':len(big.__dict__.get('content',''))}))
            from flow_sdk.builtin.group import Group
            group=Group(name='parent');await group.save(notify=False)
            member=Group(name='member',group_id=group.id);await member.save(notify=False)
            member.group_id=None;await member.save(notify=False)
            shadow=FSRecord.load('group',member.id)
            persisted=await Group.get_one({'id':member.id})
            await shadow.sync_to_db(notify=False)
            reloaded=await Group.get_one({'id':member.id})
            print('null_round_trip',json.dumps({'after_clear_db':persisted.group_id,'after_clear_shadow':shadow.__dict__.get('group_id'),'after_reindex_db':reloaded.group_id,'old_parent':group.id}))
            import flow_sdk.builtin.faas.fs_records_actions as famod
            from types import SimpleNamespace
            fresh=info.record_for(FSRef(src));fresh.save();await fresh.sync_to_db(notify=False)
            before_put=src.read_text()
            async def post_body():
                return {'title':'APIUpdated','body':'apiupdateduniquetoken'}
            request=SimpleNamespace(request=SimpleNamespace(query_params={}),sub_path='markdown/'+rec.id,method='put',get_post_data=post_body)
            old_request=famod.get_current_request_info;famod.get_current_request_info=lambda:request
            try:
                response=await famod.FsRecordsActionsMixin()._fs_records_action()
            finally:
                famod.get_current_request_info=old_request
            post_put=await SchemaRegistry.get_entity_cls('markdown').get_one({'id':rec.id})
            reparse=info.record_for(FSRef(src));await reparse.sync_to_db(notify=False)
            post_reparse=await SchemaRegistry.get_entity_cls('markdown').get_one({'id':rec.id})
            print('fs_records_put',json.dumps({'status':response.status,'db_title_after_put':post_put.title,'asset_bytes_changed':src.read_text()!=before_put,'db_title_after_fresh_reindex':post_reparse.title}))
        finally:
            await driver.close()
asyncio.run(main())
