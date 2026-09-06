import asyncio, inspect, json, tempfile
from pathlib import Path
from types import SimpleNamespace
from fastapi.params import Param
from sqlalchemy import text
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.faas.fs_records_actions import FsRecordsActionsMixin
from flow_sdk.core.entity.entity_model import Entity
import flow_sdk.db.drivers.db_driver as dbmod
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver,FtsEntry
from flow_sdk.schema.entity_factory import type_registry
from flow_sdk.server.routes.search import search_records

async def main():
    with tempfile.TemporaryDirectory(prefix='review-search-') as tmp:
        driver=SQLiteDBDriver(DBConfig(database=str(Path(tmp)/'db.sqlite')))
        await driver.open()
        old=dbmod._driver_instances.copy(); dbmod._driver_instances['sqlite']=driver
        type_registry.register('review_note', Entity)
        try:
            ids=[]
            for i in range(6):
                eid=mint_uuid(); ids.append(eid)
                e=Entity(type='review_note',id=eid,name='needle',asset_ref=f'/tmp/review-{eid}.md')
                schema=driver._entity_to_schema(e)
                data=json.loads(schema.data or '{}'); data.update(status='closed' if i<4 else 'active',scope='project' if i<4 else 'user'); schema.data=json.dumps(data)
                async with driver.session_factory() as s:
                    s.add(schema); await s.commit()
                await driver.fts_upsert(FtsEntry(entity_id=eid,entity_type='review_note',name='needle',content='common needle body'))
            async def faas(**kw):
                qp={'record_type':'review_note','q':'needle','limit':'2',**kw}
                result=await FsRecordsActionsMixin()._handle_fs_records_search(SimpleNamespace(request=SimpleNamespace(query_params=qp)))
                return result.data
            async def rest(**kw):
                args={k:(v.default.default if isinstance(v.default,Param) else v.default) for k,v in inspect.signature(search_records).parameters.items()}
                args.update(record_type='review_note',q='needle',limit=2,**kw)
                return json.loads((await search_records(**args)).body)['data']
            for name,runner,params in [('faas_page1',faas,{'offset':'0'}),('faas_page2',faas,{'offset':'2'}),('faas_active',faas,{'status':'active'}),('faas_browse',faas,{'q':''}),('rest_user_scope',rest,{'user':'true'}),('rest_total',rest,{})]:
                data=await runner(**params)
                print(name,json.dumps({'result_count':len(data['results']),'total':data['total'],'ids':[ids.index(r['record_id']) for r in data['results']]}))
        finally:
            dbmod._driver_instances=old
            await driver.close()
asyncio.run(main())
