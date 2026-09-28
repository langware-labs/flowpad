Install the Microsoft Visual C++ 2015+ x64 Runtime so that `MSVCP140.dll` and `VCRUNTIME140_1.dll` are in `%SystemRoot%\System32`. usearch (the RAG vector index) links both; Python bundles only `vcruntime140*.dll`, and a clean Windows install has neither.

The installer needs administrator rights, so Windows shows its own permission prompt. Declining it fails the install — that is the person's answer, not something to work around.
