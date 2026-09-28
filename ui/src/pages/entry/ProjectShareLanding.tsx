import { useLingui } from '@lingui/react/macro';
import { type GitOrigin, Project } from '@sdk';
import { hubProjectPath } from '@src/lib/hub-page-url';
import { Bot, Code, Sparkles, Terminal } from 'lucide-react';
import React from 'react';
import { useParams } from 'react-router';
import { entityLandingModel, parseEntityLandingParams } from './entity-landing-model';
import {
  CloneLine,
  EntityLandingGate,
  EntityLandingView,
  EntityNotFound,
  GetFlowpadLink,
  LandingCard,
} from './entry-shell';
import { projectOpenTargetPath } from './project-share-landing';
import { useOpenInFlowpad } from './useOpenFlowpad';

/**
 * `/project/<id>` — where a project share's invitation lands (`Project.share`
 * sets it as the `callback_override`). The generic landing, with the hub's
 * project page for the browser and "Open in FlowPad", which hands the desktop
 * the link that sets this shared project up on the recipient's machine.
 */
const ProjectShareLanding: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const typeId = parseEntityLandingParams(Project.type, projectId);
  if (!typeId) return <EntityNotFound type={Project.type} id={projectId ?? ''} />;

  return (
    <EntityLandingGate key={typeId.toString()} typeId={typeId}>
      {(project) => {
        const model = { ...entityLandingModel(typeId, project), hubUrl: hubProjectPath(typeId.id) };
        return (
          <EntityLandingView
            typeId={typeId}
            model={model}
            desktopCard={
              model.gitOrigin ? (
                <OpenInFlowpadCard projectId={typeId.id} name={model.displayName} gitOrigin={model.gitOrigin} />
              ) : undefined
            }
          />
        );
      }}
    </EntityLandingGate>
  );
};

const OpenInFlowpadCard: React.FC<{ projectId: string; name: string; gitOrigin: GitOrigin }> = ({
  projectId,
  name,
  gitOrigin,
}) => {
  const { t } = useLingui();
  const openInFlowpad = useOpenInFlowpad(projectOpenTargetPath({ id: projectId, name, gitOrigin }));
  return (
    <LandingCard
      title={
        <>
          <span>{t`Open with your favorite coding agent`}</span>
          <Bot className="nl-agent-icon" size={20} aria-label={t`Claude Code`} />
          <Terminal className="nl-agent-icon" size={20} aria-label={t`Codex`} />
          <Sparkles className="nl-agent-icon" size={20} aria-label={t`Cursor`} />
          <Code className="nl-agent-icon" size={20} aria-label={t`Copilot`} />
        </>
      }
      text={t`FlowPad is a free, open-source desktop app for working on projects with your coding agents. Open this one and FlowPad sets it up on your machine.`}
    >
      <div className="el-buttons">
        <button type="button" className="nl-btn" onClick={() => void openInFlowpad()}>
          {t`Open in FlowPad`}
        </button>
        <GetFlowpadLink />
      </div>
      <CloneLine origin={gitOrigin} />
    </LandingCard>
  );
};

export default ProjectShareLanding;
