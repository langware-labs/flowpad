import { browserDoorUrl, dataManager, type IServiceEndpoint, ServiceEndpoint } from '@sdk';
import React from 'react';
import { useParams } from 'react-router';
import { entityLandingModel, parseEntityLandingParams } from './entity-landing-model';
import { EntityLandingGate, EntityLandingView, EntityNotFound } from './entry-shell';

/**
 * `/service_endpoint/<id>` — where a shared app's link lands.
 *
 * The generic landing's "Open" leads to the hub's record of the endpoint, which is not what
 * someone handed an app wants. Same landing, but a web endpoint's button goes through its `open`
 * door into the app itself; an endpoint with no browser door keeps the generic destination.
 */
const ServiceEndpointLanding: React.FC = () => {
  const { endpointId } = useParams<{ endpointId: string }>();
  const typeId = parseEntityLandingParams(ServiceEndpoint.type, endpointId);
  if (!typeId) return <EntityNotFound type={ServiceEndpoint.type} id={endpointId ?? ''} />;
  const typeInfo = dataManager.getTypeInfo(ServiceEndpoint.type);

  return (
    <EntityLandingGate key={typeId.toString()} typeId={typeId}>
      {(entity) => {
        const model = entityLandingModel(typeId, entity, typeInfo?.cloud_file_transport);
        const door = browserDoorUrl(entity as unknown as IServiceEndpoint);
        return <EntityLandingView typeId={typeId} model={door ? { ...model, hubUrl: door } : model} />;
      }}
    </EntityLandingGate>
  );
};

export default ServiceEndpointLanding;
