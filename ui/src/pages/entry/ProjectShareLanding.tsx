import { useLingui } from '@lingui/react/macro';
import { type GitOrigin, Project } from '@sdk';
import { Bot, Code, Sparkles, Terminal } from 'lucide-react';
import React from 'react';
import { useParams } from 'react-router';
import { entityLandingModel, parseEntityLandingParams } from './entity-landing-model';
import { EntityLandingGate, EntityLandingView, EntityNotFound, LandingCard } from './entry-shell';
import { projectHubPath, projectOpenTargetPath } from './project-share-landing';
import { OpenInFlowpadActions } from './OpenInFlowpadActions';

/**
 * `/project/<id>` — where a project share's invitation lands (`Project.share`
 * sets it as the `callback_override`). The generic landing, desktop-only:
 * "Open in FlowPad" hands the desktop the link that sets this shared project up
 * on the recipient's machine. The browser card returns only when the project
 * has no git origin to open.
 */
const ProjectShareLanding: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const typeId = parseEntityLandingParams(Project.type, projectId);
  if (!typeId) return <EntityNotFound type={Project.type} id={projectId ?? ''} />;

  return (
    <EntityLandingGate key={typeId.toString()} typeId={typeId}>
      {(project) => {
        const model = { ...entityLandingModel(typeId, project), hubUrl: projectHubPath(typeId.id) };
        return (
          <EntityLandingView
            typeId={typeId}
            model={model}
            hideBrowserCard
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
      <OpenInFlowpadActions openTargetPath={projectOpenTargetPath({ id: projectId, name, gitOrigin })} />
    </LandingCard>
  );
};

export default ProjectShareLanding;
