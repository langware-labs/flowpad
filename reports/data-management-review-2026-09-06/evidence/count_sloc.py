import ast, io, json, subprocess, tokenize
from pathlib import Path

ROOT=Path.cwd()

def python_lines(path):
    source=path.read_text(); lines=source.splitlines(); tree=ast.parse(source)
    docstrings=set()
    for node in ast.walk(tree):
        if isinstance(node,(ast.Module,ast.ClassDef,ast.FunctionDef,ast.AsyncFunctionDef)) and node.body:
            first=node.body[0]
            if isinstance(first,ast.Expr) and isinstance(first.value,ast.Constant) and isinstance(first.value.value,str):
                docstrings.add((first.value.lineno,first.value.col_offset))
    code=set()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type in (tokenize.COMMENT,tokenize.NL,tokenize.NEWLINE,tokenize.INDENT,tokenize.DEDENT,tokenize.ENDMARKER,tokenize.ENCODING): continue
        if token.type==tokenize.STRING and token.start in docstrings: continue
        end=token.end[0]-(token.end[1]==0 and token.end[0]>token.start[0])
        code.update(i for i in range(token.start[0],end+1) if lines[i-1].strip())
    return code,tree

TS_JS=r'''
const ts=require(process.cwd()+'/ui/node_modules/typescript/lib/typescript.js');
const fs=require('fs'); const paths=JSON.parse(fs.readFileSync(0,'utf8')); const out={};
for(const path of paths){
 const source=fs.readFileSync(path,'utf8'), lines=source.split(/\r?\n/);
 const sf=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true); const covered=new Set();
 function walk(node){
  if(node.kind===ts.SyntaxKind.EndOfFileToken || (node.kind>=ts.SyntaxKind.FirstJSDocNode && node.kind<=ts.SyntaxKind.LastJSDocNode))return;
  const children=node.getChildren(sf); if(children.length){children.forEach(walk);return;}
  const start=node.getStart(sf),end=node.getEnd(); if(start>=end)return;
  const a=sf.getLineAndCharacterOfPosition(start).line,b=sf.getLineAndCharacterOfPosition(end-1).line;
  for(let i=a;i<=b;i++)if(lines[i].trim())covered.add(i+1);
 }
 walk(sf);out[path]=[...covered].sort((a,b)=>a-b);
} console.log(JSON.stringify(out));
'''

pools={
 'backend_search':[('flow_sdk/server/routes/search.py',None),('flow_sdk/builtin/faas/fs_records_actions.py','_handle_fs_records_search')],
 'scan_projection':[('flow_sdk/builtin/faas/scan_indexer.py',None),('flow_sdk/builtin/faas/fs_records_actions.py','_ref_id'),('flow_sdk/builtin/faas/fs_records_actions.py','_project_fs_records_scan')],
 'record_crud_normalization':[('flow_sdk/fs_store/record_list.py',None),('flow_sdk/fs_store/record_query.py',None),('flow_sdk/core/entity/entity_model.py','from_record'),('flow_sdk/core/entity/entity_model.py','_build_from_fs_record'),('flow_sdk/builtin/faas/fs_records_actions.py','_fs_records_action'),('flow_sdk/builtin/faas/fs_records_actions.py','_parse_record_query')],
 'schema_declarations':[('flow_sdk/schema/type_info/__init__.py','TypeMetadata'),('flow_sdk/fs_store/schema_registry.py','TypeInfo.fields')],
 'llm_sidecar':[('flow_sdk/llm_index/index_document.py',None),('flow_sdk/fs_store/operations/markdown_index_render.py',None)],
 'atomic_writer':[('flow_sdk/capsules/atomic.py',None),('flow_sdk/fs_store/indexer/_frontmatter.py','_atomic_write_text')],
 'frontend_search':[('ui/src/hooks/use-record-search.ts',None),('ui/src/hooks/use-asset-search.ts',None)],
 'sdk_query_lifecycle':[('ts_sdk/src/FlowSync/map.ts',None),('ts_sdk/src/FlowSync/query.ts',None)],
}
ts_files=sorted({p for sels in pools.values() for p,n in sels if p.endswith(('.ts','.tsx'))})
ts=json.loads(subprocess.run(['node','-e',TS_JS],input=json.dumps(ts_files),text=True,capture_output=True,check=True).stdout)
cache={}; union={}; result={}
for label,selections in pools.items():
    entries=[]; total=0
    for relative,name in selections:
        path=ROOT/relative
        if relative.endswith('.py'):
            if relative not in cache: cache[relative]=python_lines(path)
            code,tree=cache[relative]
            selected=set(code)
            if name:
                fields=name.endswith('.fields'); actual=name.removesuffix('.fields')
                nodes=[n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)) and n.name==actual]
                assert len(nodes)==1,(relative,name)
                node=nodes[0]
                if fields:
                    spans=[(n.lineno,n.end_lineno) for n in node.body if isinstance(n,(ast.Assign,ast.AnnAssign))]
                else:
                    start=min([node.lineno]+[d.lineno for d in getattr(node,'decorator_list',[])])
                    spans=[(start,node.end_lineno)]
                selected={i for i in code if any(a<=i<=b for a,b in spans)}
        else:selected=set(ts[relative])
        overlap=union.setdefault(relative,set())&selected
        assert not overlap,(relative,name,overlap)
        union[relative].update(selected)
        entries.append({'file':relative,'selector':name or 'whole file','sloc':len(selected)})
        total+=len(selected)
    result[label]={'sloc':total,'sources':entries}
result['_total']={'sloc':sum(len(s) for s in union.values()),'unique_files':len(union)}
print(json.dumps(result,indent=2))
