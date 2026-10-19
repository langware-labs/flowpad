import { dataManager, isHubOnly, Organization, TypeId } from '@sdk';

/**
 * Create a top-level organization. It is born on the HUB either way — an
 * organization is hub-authoritative and a desk row is only its mirror (see
 * `flow_sdk/app/actions/membership_sync.py`). What differs is how the create
 * REACHES the hub:
 *
 *  - hub runtime: `save` IS the hub create. The hub stamps the caller's owner
 *    edge on the created node (`neo4j_driver.create_owner_relationship`), so the
 *    creator holds `owner` the moment it returns and there is nothing left to do.
 *  - desk runtime: `save` writes the local mirror, and `share` is the desk's
 *    transport for "now put this on the hub".
 *
 * So `share` is a DESK verb, and calling it on the hub is not merely redundant:
 * the hub registers no `share` handler at all (it loads actions only from its own
 * `app/actions` folder), so the call 400s with `Unknown action: share` and buries
 * an org that was already successfully created behind a failure toast.
 *
 * Gated on the runtime, not the page: a desktop showing the hub page still has its
 * desk backend and still needs the publish.
 */
export async function createOrganization(name: string): Promise<TypeId> {
  const organization = new Organization({ name });
  await dataManager.save(organization.typeId, [], organization.toJSON() as never);
  if (!isHubOnly()) await organization.share();
  return organization.typeId;
}
