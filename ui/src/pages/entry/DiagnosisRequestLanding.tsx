import { useLingui } from '@lingui/react/macro';
import { DiagnosisRequest, TypeId } from '@sdk';
import React from 'react';
import { useParams } from 'react-router';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { entityLandingModel, parseEntityLandingParams } from './entity-landing-model';
import { EntityLandingGate, EntityLandingView, EntityNotFound, LandingCard } from './entry-shell';
import { OpenInFlowpadActions } from './OpenInFlowpadActions';

/**
 * `/diagnosis_request/<id>` — where the "your diagnosis came back" email lands (the hub's
 * `build_entity_url`). The request is the owner's own, and it lives on their machine, so the page
 * is desktop-only: "Open in FlowPad" hands the desktop the request's screen, and offers to install
 * FlowPad when nothing opens -- the same entry a project share uses.
 */
const DiagnosisRequestLanding: React.FC = () => {
  const { requestId } = useParams<{ requestId: string }>();
  const typeId = parseEntityLandingParams(DiagnosisRequest.type, requestId);
  if (!typeId) return <EntityNotFound type={DiagnosisRequest.type} id={requestId ?? ''} />;

  return (
    <EntityLandingGate key={typeId.toString()} typeId={typeId}>
      {(request) => (
        <EntityLandingView
          typeId={typeId}
          model={entityLandingModel(typeId, request)}
          hideBrowserCard
          desktopCard={<OpenRequestCard typeId={typeId} />}
        />
      )}
    </EntityLandingGate>
  );
};

const OpenRequestCard: React.FC<{ typeId: TypeId }> = ({ typeId }) => {
  const { t } = useLingui();
  const Icon = iconForType(DiagnosisRequest.type);
  return (
    <LandingCard
      title={
        <>
          <Icon className="nl-agent-icon" size={20} aria-hidden />
          <span>{t`Read the result in FlowPad`}</span>
        </>
      }
      text={t`The diagnosis came back. Open it in FlowPad to read every run, or have an agent explain it.`}
    >
      <OpenInFlowpadActions
        openTargetPath={DockPointer.forAssetEditorByTypeId(DiagnosisRequest.type, typeId).toUrl()}
      />
    </LandingCard>
  );
};

export default DiagnosisRequestLanding;
