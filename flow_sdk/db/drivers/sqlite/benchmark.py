"""SQLite database driver benchmarks.

Benchmarks for measuring app performance on core operations:
- Create 1000 entities
- Query 1000 entities
- Update 1000 entities
- Delete 1000 entities

Run with: python -m flowpad.hub.core.db.drivers.sqlite.benchmark
"""

# ruff: noqa: T201  # print statements are intentional for CLI benchmark output

import asyncio
import statistics
import time
from dataclasses import dataclass
from typing import List

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity
# TODO: execution_context not available locally
class ExecutionContext:
    pass
def set_execution_context(context):
    pass


@dataclass
class BenchmarkResult:
    """Result of a single benchmark run."""

    operation: str
    count: int
    total_time_ms: float
    avg_time_ms: float
    ops_per_second: float


class BenchmarkEntity(Entity):
    """Simple entity for benchmarking."""

    type: str = APIField(default="benchmark_entity")
    name: str = ""
    value: int = 0
    description: str = ""


async def setup_context():
    """Set up execution context like the app does."""
    # TODO: User not available locally
    class User:
        def __init__(self, name, email):
            self.name = name
            self.email = email
    from flow_sdk.db.drivers.db_driver import get_db_driver

    # Get driver and set up test database
    driver = get_db_driver()
    driver.set_db_name("benchmark_test")
    await driver.clean_all_db()

    # Create execution context
    execution_context = ExecutionContext()
    set_execution_context(execution_context)

    # Create a test user for the context
    test_user = User(name="benchmark_user", email="benchmark@test.com")
    await execution_context.setup(user=test_user)

    return execution_context, driver


async def cleanup_context(execution_context: ExecutionContext):
    """Clean up execution context."""
    await execution_context.cleanup()


async def benchmark_create(count: int) -> BenchmarkResult:
    """Benchmark creating entities."""
    entities = [
        BenchmarkEntity(
            name=f"entity_{i}",
            value=i,
            description=f"Test entity number {i} for benchmarking purposes",
        )
        for i in range(count)
    ]

    start = time.perf_counter()
    for entity in entities:
        await entity.save()
    elapsed = time.perf_counter() - start

    total_ms = elapsed * 1000
    return BenchmarkResult(
        operation="create",
        count=count,
        total_time_ms=total_ms,
        avg_time_ms=total_ms / count,
        ops_per_second=count / elapsed,
    )


async def benchmark_query(count: int) -> BenchmarkResult:
    """Benchmark querying entities by ID."""
    # Get all entity IDs first
    entities = await BenchmarkEntity.get_all()
    entity_ids = [e.id for e in entities[:count]]

    start = time.perf_counter()
    for eid in entity_ids:
        await BenchmarkEntity.get_by_id(eid)
    elapsed = time.perf_counter() - start

    total_ms = elapsed * 1000
    actual_count = len(entity_ids)
    return BenchmarkResult(
        operation="query",
        count=actual_count,
        total_time_ms=total_ms,
        avg_time_ms=total_ms / actual_count if actual_count else 0,
        ops_per_second=actual_count / elapsed if elapsed > 0 else 0,
    )


async def benchmark_update(count: int) -> BenchmarkResult:
    """Benchmark updating entities."""
    entities = await BenchmarkEntity.get_all()
    entities = entities[:count]

    start = time.perf_counter()
    for i, entity in enumerate(entities):
        entity.value = entity.value + 1000
        entity.description = f"Updated description {i}"
        await entity.save()
    elapsed = time.perf_counter() - start

    total_ms = elapsed * 1000
    actual_count = len(entities)
    return BenchmarkResult(
        operation="update",
        count=actual_count,
        total_time_ms=total_ms,
        avg_time_ms=total_ms / actual_count if actual_count else 0,
        ops_per_second=actual_count / elapsed if elapsed > 0 else 0,
    )


async def benchmark_delete(count: int) -> BenchmarkResult:
    """Benchmark deleting entities."""
    entities = await BenchmarkEntity.get_all()
    entities = entities[:count]

    start = time.perf_counter()
    for entity in entities:
        await entity.delete()
    elapsed = time.perf_counter() - start

    total_ms = elapsed * 1000
    actual_count = len(entities)
    return BenchmarkResult(
        operation="delete",
        count=actual_count,
        total_time_ms=total_ms,
        avg_time_ms=total_ms / actual_count if actual_count else 0,
        ops_per_second=actual_count / elapsed if elapsed > 0 else 0,
    )


async def benchmark_add_children(count: int) -> tuple[BenchmarkResult, BenchmarkEntity]:
    """Benchmark adding children to a parent entity."""
    # Create parent
    parent = BenchmarkEntity(name="parent_entity", value=0, description="Parent for children benchmark")
    await parent.save()

    # Create children
    children = [
        BenchmarkEntity(
            name=f"child_{i}",
            value=i,
            description=f"Child entity {i}",
        )
        for i in range(count)
    ]

    start = time.perf_counter()
    for child in children:
        await parent.add_child(child)
    elapsed = time.perf_counter() - start

    total_ms = elapsed * 1000
    return BenchmarkResult(
        operation="add_children",
        count=count,
        total_time_ms=total_ms,
        avg_time_ms=total_ms / count,
        ops_per_second=count / elapsed,
    ), parent


async def benchmark_query_children(parent: BenchmarkEntity, count: int) -> BenchmarkResult:
    """Benchmark querying children of a parent entity."""
    start = time.perf_counter()
    children = await parent.get_children()
    elapsed = time.perf_counter() - start

    total_ms = elapsed * 1000
    actual_count = len(children)
    return BenchmarkResult(
        operation="query_children",
        count=actual_count,
        total_time_ms=total_ms,
        avg_time_ms=total_ms / actual_count if actual_count else total_ms,
        ops_per_second=actual_count / elapsed if elapsed > 0 else 0,
    )


def print_result(result: BenchmarkResult):
    """Print a benchmark result."""
    print(f"\n{result.operation.upper()} ({result.count} entities)")
    print(f"  Total time:     {result.total_time_ms:,.2f} ms")
    print(f"  Avg per entity: {result.avg_time_ms:.4f} ms")
    print(f"  Throughput:     {result.ops_per_second:,.2f} ops/sec")


async def run_benchmarks(count: int = 1000, runs: int = 3):
    """Run all benchmarks multiple times and report averages."""
    print("\nSQLite Driver Benchmark (Full Entity Stack)")
    print("=" * 50)
    print(f"Entity count: {count}")
    print(f"Runs per benchmark: {runs}")

    all_results: dict[str, List[BenchmarkResult]] = {
        "create": [],
        "query": [],
        "update": [],
        "delete": [],
        "add_children": [],
        "query_children": [],
    }

    for run in range(runs):
        print(f"\n--- Run {run + 1}/{runs} ---")

        # Set up fresh context for each run
        execution_context, driver = await setup_context()

        try:
            # Create
            result = await benchmark_create(count)
            all_results["create"].append(result)
            print_result(result)

            # Query
            result = await benchmark_query(count)
            all_results["query"].append(result)
            print_result(result)

            # Update
            result = await benchmark_update(count)
            all_results["update"].append(result)
            print_result(result)

            # Delete
            result = await benchmark_delete(count)
            all_results["delete"].append(result)
            print_result(result)

            # Add children (creates parent + children with relationships)
            result, parent = await benchmark_add_children(count)
            all_results["add_children"].append(result)
            print_result(result)

            # Query children
            result = await benchmark_query_children(parent, count)
            all_results["query_children"].append(result)
            print_result(result)

        finally:
            await cleanup_context(execution_context)
            await driver.clean_all_db()

    # Print summary
    print(f"\n{'=' * 50}")
    print("SUMMARY (averages across all runs)")
    print("=" * 50)

    for op, results in all_results.items():
        if results:
            avg_total = statistics.mean(r.total_time_ms for r in results)
            avg_per_op = statistics.mean(r.avg_time_ms for r in results)
            avg_throughput = statistics.mean(r.ops_per_second for r in results)

            print(f"\n{op.upper()} ({count} entities)")
            print(f"  Avg total time:     {avg_total:,.2f} ms")
            print(f"  Avg per entity:     {avg_per_op:.4f} ms")
            print(f"  Avg throughput:     {avg_throughput:,.2f} ops/sec")

            if runs > 1:
                std_throughput = statistics.stdev(r.ops_per_second for r in results)
                print(f"  Throughput stddev:  {std_throughput:,.2f} ops/sec")


async def main():
    """Main entry point."""
    await run_benchmarks(count=1000, runs=3)


if __name__ == "__main__":
    asyncio.run(main())
