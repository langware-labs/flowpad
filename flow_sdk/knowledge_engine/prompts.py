RESOLVE_HINTS_PROMPT = """---
The text would contain hint sections in the following format:
[[[HINT: <prompt> ]]]
where <prompt> would contain the prompted instruction.
Follow the instruction in the hint section by replacing the whole section with content that adhere to the instruction.
If you don't know the answer to a question or information is not available, remove the hint section from the output and leave a blank space.
Don't make up information.
If the hinted prompt contains the word '[GLOBAL]', in square brackets, it means that the prompt is a global hint
and should be applied to the whole page.
Remove the global hint section from the output.
---
"""
