"""Topological sort for template dependencies."""

from collections import deque
from typing import Dict, List

from .errors import CircularDependencyError


def topological_sort(templates: Dict[str, List[str]]) -> List[str]:
    """
    Return template names in generation order (dependencies first).

    Args:
        templates: ``{template_name: [ref_names]}`` — refs not present as
            keys are treated as context variables (leaf nodes with zero
            in-degree).

    Returns:
        List of all names (templates + context vars) in topological order.

    Raises:
        CircularDependencyError: If a cycle is detected among template nodes.
    """
    # Collect every node (template keys + their refs)
    all_nodes: set[str] = set(templates.keys())
    for refs in templates.values():
        all_nodes.update(refs)

    # Build adjacency: dep -> list of dependents (dep must come before dependent)
    dependents: Dict[str, List[str]] = {n: [] for n in all_nodes}
    in_degree: Dict[str, int] = {n: 0 for n in all_nodes}

    for tpl, refs in templates.items():
        for ref in refs:
            dependents[ref].append(tpl)
            in_degree[tpl] += 1

    # Kahn's algorithm
    queue: deque[str] = deque(n for n, d in in_degree.items() if d == 0)
    result: List[str] = []

    while queue:
        node = queue.popleft()
        result.append(node)
        for dep in dependents[node]:
            in_degree[dep] -= 1
            if in_degree[dep] == 0:
                queue.append(dep)

    # If we didn't visit every node, there's a cycle
    template_names = set(templates.keys())
    rendered_templates = [n for n in result if n in template_names]
    if len(rendered_templates) != len(template_names):
        missing = template_names - set(rendered_templates)
        raise CircularDependencyError(f"Circular dependency among templates: {missing}")

    return result
