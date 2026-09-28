import { useLingui } from '@lingui/react/macro';
import { type AnyEntity, Project } from '@sdk';
import { gitOriginCloneUrl, gitOriginOf, isCompleteGitOrigin } from '@sdk/models/GitOrigin';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { isHubOnly } from '@src/navigation/hub-runtime';
import NotFound from '@src/pages/NotFound';
import { humanizeType } from '@src/utils/humanize';
import { Bot, Code, Globe, Sparkles, Terminal } from 'lucide-react';
import React from 'react';
import { useParams } from 'react-router';
import { parseEntityLandingParams } from './entity-landing-model';
import { CopyLine, EntityLandingGate, EntityNotFound } from './EntityLanding';
import './entity-landing.css';
import './message-landing.css';
import { hubProjectPath, projectOpenTargetPath } from './project-share-landing';
import { useOpenInFlowpad } from './useOpenFlowpad';

/**
 * `/project/<id>` — where a project share's invitation lands.
 *
 * The project counterpart of `/flow_message/<id>`: the sharer sets this path as
 * the invitation's `callback_override`, and the page offers "Open in FlowPad",
 * which hands the desktop the `?action=open&setup_git=1&project_id=…` link so
 * the shared project is set up on the recipient's machine, and the hub's
 * project page in the browser. Loading, sign-in and dead links behave exactly as
 * the generic landing (`EntityLandingGate`).
 *
 * Hub only, like the generic landing.
 */
const ProjectShareLanding: React.FC = () => {
  if (!isHubOnly()) return <NotFound />;
  return <HubProjectShareLanding />;
};

const HubProjectShareLanding: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const typeId = parseEntityLandingParams(Project.type, projectId);
  if (!typeId) return <EntityNotFound type={Project.type} id={projectId ?? ''} />;
  return (
    <EntityLandingGate key={typeId.toString()} typeId={typeId}>
      {(entity) => <ProjectShareView project={entity} />}
    </EntityLandingGate>
  );
};

const ProjectShareView: React.FC<{ project: AnyEntity }> = ({ project }) => {
  const { t } = useLingui();
  const origin = gitOriginOf(project as { git_origin?: never });
  const gitOrigin = isCompleteGitOrigin(origin) ? origin : null;
  const name = project.displayName || project.id;
  const openTarget = gitOrigin ? projectOpenTargetPath({ id: project.id, name, gitOrigin }) : '';
  const openInFlowpad = useOpenInFlowpad(openTarget);
  const TypeIcon = iconForType(Project.type);
  const label = humanizeType(Project.type).toLowerCase();
  const cloneCommand = gitOrigin
    ? `git clone ${gitOrigin.branch ? `-b ${gitOrigin.branch} ` : ''}${gitOriginCloneUrl(gitOrigin)}`
    : null;

  return (
    <div className="nl-page el-page">
      <div className="nl-header">
        <h1 className="el-title">
          <TypeIcon className="el-title-icon" aria-hidden />
          <span>{name}</span>
          <span className="el-type-chip">{labelForType(Project.type)}</span>
        </h1>
      </div>
      <div className="nl-container">
        <div className="nl-intro">
          <p className="nl-task-from">{t`You have access to this ${label}.`}</p>
        </div>

        <p className="nl-section-label">
          {gitOrigin ? t`Open the ${label} using one of these options:` : t`Open the ${label}:`}
        </p>

        <div className={gitOrigin ? 'nl-options' : 'nl-options el-options-single'}>
          {gitOrigin && (
            <div className="nl-option el-option" data-testid="project-share-desktop">
              <h3 className="el-option-title">
                <span>{t`Open with your favorite coding agent`}</span>
                <Bot className="nl-agent-icon" size={20} aria-label={t`Claude Code`} />
                <Terminal className="nl-agent-icon" size={20} aria-label={t`Codex`} />
                <Sparkles className="nl-agent-icon" size={20} aria-label={t`Cursor`} />
                <Code className="nl-agent-icon" size={20} aria-label={t`Copilot`} />
              </h3>
              <p className="el-grow">
                {t`FlowPad is a free, open-source desktop app for working on projects with your coding agents. Open this one and FlowPad sets it up on your machine.`}
              </p>
              <div className="el-buttons">
                <button
                  type="button"
                  className="nl-btn"
                  data-testid="project-share-open-in-flowpad"
                  data-open-target={openTarget}
                  onClick={() => void openInFlowpad()}
                >
                  {t`Open in FlowPad`}
                </button>
                <a className="nl-btn" href="https://flowpad.ai/">
                  {t`Get FlowPad at flowpad.ai →`}
                </a>
              </div>
              {cloneCommand && <CopyLine text={cloneCommand} />}
            </div>
          )}

          <div className="nl-option el-option">
            <h3 className="el-option-title">
              <Globe className="nl-agent-icon" size={20} aria-hidden />
              <span>{t`Open in your browser`}</span>
            </h3>
            <p className="el-grow">{t`View ${name} on FlowPad. Nothing to install.`}</p>
            <div className="el-buttons">
              <a className="nl-btn" href={hubProjectPath(project.id)} data-testid="entity-landing-open">
                {t`Open ${name}`}
              </a>
            </div>
          </div>
        </div>

        <div className="nl-footer">
          FlowPad &middot; <a href="https://flowpad.ai">flowpad.ai</a>
        </div>
      </div>
    </div>
  );
};

export default ProjectShareLanding;
