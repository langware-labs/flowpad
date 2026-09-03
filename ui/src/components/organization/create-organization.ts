import { dataManager, Organization, TypeId } from '@sdk';

/** Create a top-level organization locally, then publish it to the hub. */
export async function createOrganization(name: string): Promise<TypeId> {
  const organization = new Organization({ name });
  await dataManager.save(organization.typeId, [], organization.toJSON() as never);
  await organization.share();
  return organization.typeId;
}
