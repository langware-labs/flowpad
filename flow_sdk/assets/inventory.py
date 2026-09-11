"""Join native worker observations to filesystem identities and usage."""
from flow_sdk.assets.asset import Asset
from flow_sdk.assets.catalog import descriptor_from_asset


def reconcile_assets(candidates, observations, *, sources=()):
    # A catalog row is retained only with worker evidence, attachment or usage.
    result = {d.posix_path: d for d in candidates if d.usage or d.attached}
    candidates_by_path = {d.posix_path: d for d in candidates}
    for observation in observations:
        asset = Asset.from_path(observation.path)
        path = str(asset.path)
        descriptor = result.get(path) or candidates_by_path.get(path) or descriptor_from_asset(asset, sources)
        result[path] = descriptor.model_copy(update={'available': True, 'invocation_name': observation.name})
    return list(result.values())


def inventory_payload(descriptors, usages, *, assistant_enabled, error=None):
    from flow_sdk.assets.usage import UsageResolution
    used_assets = [usage.model_dump(mode='json') for usage in usages]
    return {
        'assets': [descriptor.to_row() for descriptor in descriptors],
        'used_assets': used_assets,
        'unresolved_usage': [row for row in used_assets if row['resolution'] != UsageResolution.RESOLVED],
        'assistant_enabled': assistant_enabled,
        **({'availability_error': error} if error else {}),
    }
