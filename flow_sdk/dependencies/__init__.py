"""Dependencies by id — what an asset's ``flow.json`` names, resolved to something on THIS machine.

``resolve`` answers one id, ``roots`` says what each type puts in context;
``flow_sdk/builtin/project_dependencies.py`` walks the graph from a project and keeps its context
equal to what resolved.
"""
