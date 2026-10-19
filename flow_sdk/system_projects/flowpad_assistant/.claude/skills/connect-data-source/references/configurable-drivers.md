# One driver, several configured resources

Use this when resources share authentication, requests and pagination. A **driver** supplies
provider behavior; a **source** configures one stream. New endpoints and record fields usually
need source configuration and resource-specific conversion, not another copy of the driver.
Separate drivers are appropriate for different SDK families (records versus messages, for
example) or fundamentally different transports. Record the reason when choosing that split.

## Example: Twenty CRM

Keep one registered `twenty` driver and five separate sources. Each `data_source.json` has
`data_driver_name: "twenty"`; its `data_driver_config` selects one resource. The SDK exposes
that declaration field as runtime `config` (`binding.config` / `self.config`).

| Source | `data_driver_config.resource` | Behavior |
| --- | --- | --- |
| People | `people` | Read-only people records |
| Companies | `companies` | Read-only company records |
| Members | `members` | Read-only workspace members |
| Tasks | `tasks` | Typed task reads and writes, including relationships |
| Opportunities | `opportunities` | Typed opportunity reads and writes |

For example, the fields selecting a task source in `data_source.json` are:

```json
{
  "data_driver_name": "twenty",
  "data_driver_config": {"base_url": "https://crm.example.com", "resource": "tasks"}
}
```

This is a configuration fragment, not a complete source declaration. Keep the credential in
the driver's `auth`, outside config. All five sources use the same credential mechanism.

## Implementation contract

- One asset folder holds `data_driver.json`, `source.py`, shared transport, resource helper
  modules, and tests. Put authentication, HTTP requests and pagination in one shared module;
  keep resource conversion, relationships and write behavior in the resource helpers.
- `TwentyConfig` declares a required `resource: Resource`, a string enum with the five choices
  above, and `base_url` with the existing workspace default (both defined in `_twenty.py`).
  Manifest form hints name the same fields and present the resource choices. Reject absent
  or unknown resources instead of silently choosing a stream.
- `source.py` defines exactly one concrete registered source class with `provider = "twenty"`.
  It must implement listing, not just be a factory: the SDK discovers capabilities from the
  registered class. Keep additional concrete source classes in helper modules.
- Override `Source.build(binding)` to validate config and construct the selected resource
  class. Keep task and opportunity `create(data: ConcreteRecordData)` annotations on their
  concrete implementations: `create_item` validates against the built source's annotation.
  A generic `RecordData` or union annotation loses that resource-specific validation.
  Read-only resource classes do not implement write protocols.
- `account_part(config)` returns the selected resource so sources sharing one account do not
  collapse into one. This is an account lookup discriminator, not a new entity ID.
- `origin_kind_for(config)` selects the resource's existing origin kind. Preserve payload
  model kinds and origin scope/key construction; changing the driver name must not change
  the identity of a remote record.

## Consolidation and proof

Record source IDs, config, ownership, credentials, schedules, sync state, mirror mappings,
source-item identities and dataset row IDs/keys before migration. Keep a rollback copy outside
the indexed asset tree until validation passes. Coordinate the switch with active syncs.
Index the new driver, then update existing source declarations in place with its name and
resource selector. Do not delete/recreate sources or mirrored rows. After switching the sources,
remove both obsolete driver registrations and their authored folders: deleting a driver row
does not remove its folder. Restart the affected backend before validation to clear cached old
driver classes. Preserved payload kinds can otherwise collide with those still registered by
the old classes; do not rename kinds to evade that collision. After validation, restore any
automation you suspended and remove the temporary rollback copy.

Prove all configured resources through SDK entry points: listing and pagination, authentication
failure, malformed listings, typed creates and write-back, read-only refusal, partial-write
warnings, invalid config, and repeated syncs preserving identities without duplicates. A direct
helper call alone does not prove `build`, capability discovery or creation validation.

When an app consumes these sources, verify its reads and authorized write-back in the browser,
including updates without a refresh. Use isolated doubles first; live writes use uniquely
named temporary records, never existing user records. Delete test records and remove temporary
instances and credentials afterward, also on failure; verify cleanup rather than assuming it.
