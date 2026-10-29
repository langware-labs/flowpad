import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ProjectSetupRequirement } from '@sdk';

/** A row's identity among a project's setup rows (a React key, a selection). */
export const rowKey = (req: ProjectSetupRequirement) => `${req.kind}-${req.typeid}-${req.name}`;

/** A row's test-id suffix: a credential by its name, anything else by kind and name (a credential and the
 *  data source using it can share a name). */
export const rowId = (req: ProjectSetupRequirement) => (req.kind === 'pack' ? req.name : `${req.kind}-${req.name}`);

/** A root's kind, as "Removes: Gmail (data source)" names it. */
export const ROOT_KIND: Record<string, MessageDescriptor> = {
  data_source: msg`data source`,
  agent: msg`agent`,
  webapp: msg`web app`,
  dependency: msg`dependency`,
  credential: msg`credential`,
};

/** What a setup step is, as its row's chip names it. A credential pack is a Connection when it is a sign-in. */
export function stepKind(req: ProjectSetupRequirement): MessageDescriptor {
  if (req.kind === 'pack') return req.credential_kind === 'oauth' ? msg`Connection` : msg`Credential`;
  return STEP_KIND[req.kind] ?? msg`Dependency`;
}

const STEP_KIND: Record<string, MessageDescriptor> = {
  source: msg`Data source`,
  webapp: msg`Web app`,
  dependency: msg`Dependency`,
};
