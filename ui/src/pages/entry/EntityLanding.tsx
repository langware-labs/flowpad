import { useLingui } from '@lingui/react/macro';
import { dataManager } from '@sdk';
import { Laptop } from 'lucide-react';
import React from 'react';
import { useParams } from 'react-router';
import { type EntityLandingModel, entityLandingModel, parseEntityLandingParams } from './entity-landing-model';
import {
  CloneLine,
  EntityLandingGate,
  EntityLandingView,
  EntityNotFound,
  GetFlowpadLink,
  LandingCard,
} from './entry-shell';

/**
 * `/<type>/<id>` — the default landing for an accepted invitation.
 *
 * The hub's `members/accept` redirects here (`build_entity_url`) whenever the
 * invitation carries no `callback_override`; a client that wants a type-specific
 * destination sets one (`ProjectShareLanding` is such a destination). So this
 * page knows nothing about any type: it offers the hub's generic entity view,
 * plus a "work on it on your machine" card when there is something to take there.
 */
const EntityLanding: React.FC = () => {
  const { entityType, entityId } = useParams<{ entityType: string; entityId: string }>();
  const typeId = parseEntityLandingParams(entityType, entityId);
  // An unregistered type can only be 422'd — skip the round trip.
  const typeInfo = typeId ? dataManager.getTypeInfo(typeId.type) : undefined;
  if (!typeId || !typeInfo) return <EntityNotFound type={entityType ?? ''} id={entityId ?? ''} />;

  return (
    <EntityLandingGate key={typeId.toString()} typeId={typeId}>
      {(entity) => {
        const model = entityLandingModel(typeId, entity, typeInfo.cloud_file_transport);
        return (
          <EntityLandingView
            typeId={typeId}
            model={model}
            desktopCard={model.showDesktop ? <DesktopCard model={model} /> : undefined}
          />
        );
      }}
    </EntityLandingGate>
  );
};

const DesktopCard: React.FC<{ model: EntityLandingModel }> = ({ model }) => {
  const { t } = useLingui();
  const repoPath = model.gitOrigin?.rel_path && model.gitOrigin.rel_path !== '.' ? model.gitOrigin.rel_path : null;
  let text: string;
  if (!model.gitOrigin) text = t`Work on it in the FlowPad desktop app with your coding agents.`;
  else if (repoPath) text = t`It lives in git under ${repoPath}. Clone it, and open it in the FlowPad desktop app.`;
  else text = t`It lives in git. Clone it, and open it in the FlowPad desktop app.`;

  return (
    <LandingCard
      title={
        <>
          <Laptop className="nl-agent-icon" size={20} aria-hidden />
          <span>{t`Work on it on your machine`}</span>
        </>
      }
      text={text}
    >
      <div className="el-buttons">
        <GetFlowpadLink />
      </div>
      {model.gitOrigin && <CloneLine origin={model.gitOrigin} />}
    </LandingCard>
  );
};

export default EntityLanding;
