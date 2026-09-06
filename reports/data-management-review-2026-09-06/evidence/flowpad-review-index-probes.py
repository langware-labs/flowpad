import json, sqlite3, statistics, time

def ms(fn, rounds=7):
    samples=[]
    for _ in range(rounds):
        t=time.perf_counter(); fn(); samples.append((time.perf_counter()-t)*1000)
    return round(statistics.median(samples), 3)

for n in (2000, 10000, 50000):
    db=sqlite3.connect(':memory:')
    db.execute('CREATE TABLE entities(id TEXT PRIMARY KEY, type TEXT, updated_date TEXT, data TEXT)')
    db.execute('CREATE INDEX bytype ON entities(type, updated_date)')
    db.execute("CREATE VIRTUAL TABLE entities_fts USING fts5(entity_id, type, name, title, description, content, tokenize='porter unicode61')")
    db.executemany("INSERT INTO entities VALUES(?, 'skill', '2026-01-01', '{}')", [(f'id-{i}',) for i in range(n)])
    db.executemany("INSERT INTO entities_fts VALUES(?, 'skill', 'test', 'title', 'description', 'some realistic body text goes here')", [(f'id-{i}',) for i in range(n)])
    query="SELECT e.*, fts.title, fts.description FROM (SELECT * FROM entities WHERE type='skill' ORDER BY updated_date DESC, type ASC, id ASC LIMIT 20) e LEFT JOIN entities_fts fts ON e.id=fts.entity_id ORDER BY e.updated_date DESC,e.type ASC,e.id ASC"
    keyed="SELECT e.*, fts.title, fts.description FROM (SELECT rowid AS rid,* FROM entities WHERE type='skill' ORDER BY updated_date DESC, type ASC, id ASC LIMIT 20) e LEFT JOIN entities_fts fts ON e.rid=fts.rowid ORDER BY e.updated_date DESC,e.type ASC,e.id ASC"
    # The keyed comparison uses the rowid correspondence from insertion order only as an isolated benchmark.
    # A production fix must persist/enforce the mapping; it cannot assume it accidentally.
    missing_delete="DELETE FROM entities_fts WHERE entity_id='does-not-exist'"
    print(json.dumps({'rows':n, 'browse20_ms':ms(lambda: db.execute(query).fetchall()), 'mapped_rowid_browse20_ms':ms(lambda: db.execute(keyed).fetchall()),'missing_delete_ms':ms(lambda: db.execute(missing_delete)), 'plans':db.execute('EXPLAIN QUERY PLAN '+query).fetchall()}))
    db.close()
