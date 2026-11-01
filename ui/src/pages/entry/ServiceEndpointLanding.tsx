import { ActionInfo, ServiceEndpoint } from '@sdk';
import React from 'react';
import { useParams } from 'react-router';
import { parseEntityLandingParams } from './entity-landing-model';
import { EntityNotFound } from './entry-shell';

/** Opening an app requires Runner only; inspecting its entity requires Reader. */
const ServiceEndpointLanding: React.FC = () => {
  const { endpointId } = useParams<{ endpointId: string }>();
  const typeId = parseEntityLandingParams(ServiceEndpoint.type, endpointId);
  if (!typeId) return <EntityNotFound type={ServiceEndpoint.type} id={endpointId ?? ''} />;
  const door = new ActionInfo('open', ServiceEndpoint.type, typeId.id, 'GET').fullActionUrl;
  return <main className="flex min-h-screen items-center justify-center"><a href={door}>Open app</a></main>;
};
export default ServiceEndpointLanding;
