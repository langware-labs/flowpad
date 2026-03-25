from typing import Callable, List

from langchain_text_splitters import Language, RecursiveCharacterTextSplitter

from flow_sdk.utils import sync_count_tokens

_file_extensions_mapping = {
    "cpp": Language.CPP,
    "go": Language.GO,
    "java": Language.JAVA,
    "kt": Language.KOTLIN,
    "js": Language.JS,
    "ts": Language.TS,
    "php": Language.PHP,
    "proto": Language.PROTO,
    "py": Language.PYTHON,
    "rst": Language.RST,
    "rb": Language.RUBY,
    "rs": Language.RUST,
    "scala": Language.SCALA,
    "swift": Language.SWIFT,
    "md": Language.MARKDOWN,
    "tex": Language.LATEX,
    "html": Language.HTML,
    "sol": Language.SOL,
    "cs": Language.CSHARP,
    "cob": Language.COBOL,
    "c": Language.C,
    "lua": Language.LUA,
    "pl": Language.PERL,
    "hs": Language.HASKELL,
    "ex": Language.ELIXIR,
    "exs": Language.ELIXIR,
}


def separators_for_extension(extension: str):
    match extension:
        case "txt":
            # Default separators for text files
            return ["\n\n", "\n", " ", ""]
        case "py":
            # The default for python are not enough, we need to add more to support "async"
            return [
                # First, try to split along class definitions
                "\nclass ",
                "\n@",
                "\ndef ",
                "\nasync def ",
                "\n\t@",
                "\n\tdef ",
                "\n\tasync def ",
                "\n    @",
                "\n    def ",
                "\n    async def ",
                # Now split by the normal type of lines
                "\n\n",
                "\n",
                " ",
                "",
            ]
        case _:
            try:
                return RecursiveCharacterTextSplitter.get_separators_for_language(_file_extensions_mapping[extension])
            except KeyError:
                # Default to the most common separators
                return separators_for_extension("txt")


class UnitingRecursiveCharacterTextSplitter(RecursiveCharacterTextSplitter):
    def split_text(self, text: str) -> List[str]:
        chunks = super().split_text(text)
        # Unite small chunks
        i = len(chunks) - 1
        while i > 0:
            if len(chunks[i]) + len(chunks[i - 1]) <= self._chunk_size:
                chunks[i - 1] += chunks[i]
                chunks.pop(i)
            i -= 1
        return chunks


def get_text_splitter_for_extension(
    extension: str = "txt", length_function: Callable[[str], int] = sync_count_tokens, **kwargs
):
    separators = separators_for_extension(extension)
    return UnitingRecursiveCharacterTextSplitter(
        separators=separators,
        is_separator_regex=True,
        strip_whitespace=False,
        chunk_overlap=0,
        length_function=length_function,
        **kwargs,
    )
