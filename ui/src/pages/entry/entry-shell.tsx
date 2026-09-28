import { useLingui } from '@lingui/react/macro';
import {
  type AnyEntity,
  cloudManager,
  type GitOrigin,
  gitCloneCommand,
  navigator as sdkNavigator,
  type TypeId,
} from '@sdk';
import { useAuth, useEntity } from '@sdk/react/hooks';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { useCopied } from '@src/components/ui/copy-button';
import { HUB_HOME_PATH } from '@src/lib/hub-page-url';
import { isHubOnly } from '@src/navigation/hub-runtime';
import NotFound from '@src/pages/NotFound';
import { humanizeType } from '@src/utils/humanize';
import { Globe, SearchX } from 'lucide-react';
import React, { useEffect, useState, type ReactNode } from 'react';
import { type EntityLandingModel, entityLandingProblem } from './entity-landing-model';
import { bounceToLoginOnce } from './login-bounce';
// Order matters: the el-* rules refine the nl-* entry-page look.
import './message-landing.css';
import './entity-landing.css';
import WrongAccountPanel from './WrongAccountPanel';

/**
 * The pieces every entity entry page is built from: the generic landing
 * (`EntityLanding`) and the per-share ones (`ProjectShareLanding`).
 */

/** The entry landings are hub pages; anywhere else their URLs are what they always were — not a route. */
export const HubOnly: React.FC<{ children: ReactNode }> = ({ children }) =>
  isHubOnly() ? <>{children}</> : <NotFound />;

/** The type as a noun inside a sentence ("this agent"). The chip uses the registry's own label. */
function typeNoun(type: string): string {
  return humanizeType(type).toLowerCase();
}

/**
 * Everything before there is an entity to show: read it, spin meanwhile, take a
 * 401 through one sign-in round trip, and send a dead link to the not-found page.
 * `children` renders the entity once it is there.
 */
export const EntityLandingGate: React.FC<{ typeId: TypeId; children: (entity: AnyEntity) => ReactNode }> = ({
  typeId,
  children,
}) => {
  const { t } = useLingui();
  const loginKey = `login-attempt-entity-${typeId.toString()}`;
  const { data: entity, notFound, error } = useEntity(typeId);
  const problem = entityLandingProblem({ notFound, error });
  const [bounce, setBounce] = useState<'redirecting' | 'exhausted' | null>(null);

  useEffect(() => {
    if (problem === 'signed-out') setBounce(bounceToLoginOnce(loginKey));
  }, [problem, loginKey]);

  if (bounce === 'exhausted') {
    return <WrongAccountPanel reason="no-access" onBeforeSignIn={() => sessionStorage.removeItem(loginKey)} />;
  }
  if (problem === 'not-found') return <EntityNotFound type={typeId.type} id={typeId.id} />;
  if (problem === 'failed') {
    return (
      <div className="nl-center">
        <p className="nl-error">{t`Something went wrong opening this link. Try again in a moment.`}</p>
      </div>
    );
  }
  if (!entity) {
    return (
      <div className="nl-center">
        <div className="nl-spinner" aria-label={t`Loading`} />
      </div>
    );
  }
  return <>{children(entity)}</>;
};

/** One option card: a title row, a line of text, then its buttons. */
export const LandingCard: React.FC<{ title: ReactNode; text: ReactNode; children: ReactNode }> = ({
  title,
  text,
  children,
}) => (
  <div className="nl-option el-option">
    <h3 className="el-option-title">{title}</h3>
    <p className="el-grow">{text}</p>
    {children}
  </div>
);

/**
 * The landing itself: header, the browser card, and — when the page has
 * something to take to a machine — the `desktopCard` it passes in.
 */
export const EntityLandingView: React.FC<{ typeId: TypeId; model: EntityLandingModel; desktopCard?: ReactNode }> = ({
  typeId,
  model,
  desktopCard,
}) => {
  const { t } = useLingui();
  const TypeIcon = iconForType(typeId.type);
  const label = typeNoun(typeId.type);
  const name = model.displayName;

  return (
    <div className="nl-page">
      <div className="nl-header">
        <h1 className="el-title">
          <TypeIcon className="el-title-icon" aria-hidden />
          <span>{name}</span>
          <span className="el-type-chip">{labelForType(typeId.type)}</span>
        </h1>
      </div>
      <div className="nl-container">
        <div className="nl-intro">
          {/* Not "shared with you": mention emails and an owner's own old links land here too. */}
          <p className="nl-task-from">{t`You have access to this ${label}.`}</p>
        </div>
        {model.description && (
          <p className="nl-msg">
            <em>&quot;{model.description}&quot;</em>
          </p>
        )}

        <p className="nl-section-label">
          {desktopCard ? t`Open the ${label} using one of these options:` : t`Open the ${label}:`}
        </p>

        <div className={desktopCard ? 'nl-options' : 'nl-options el-options-single'}>
          <LandingCard
            title={
              <>
                <Globe className="nl-agent-icon" size={20} aria-hidden />
                <span>{t`Open in your browser`}</span>
              </>
            }
            text={t`View ${name} on FlowPad. Nothing to install.`}
          >
            <div className="el-buttons">
              <a className="nl-btn" href={model.hubUrl}>
                {t`Open ${name}`}
              </a>
            </div>
          </LandingCard>
          {desktopCard}
        </div>

        <div className="nl-footer">
          FlowPad &middot; <a href="https://flowpad.ai">flowpad.ai</a>
        </div>
      </div>
    </div>
  );
};

export const GetFlowpadLink: React.FC = () => {
  const { t } = useLingui();
  return (
    <a className="nl-btn" href="https://flowpad.ai/">
      {t`Get FlowPad at flowpad.ai →`}
    </a>
  );
};

/** The copyable `git clone` for a repository. */
export const CloneLine: React.FC<{ origin: GitOrigin }> = ({ origin }) => {
  const { t } = useLingui();
  const { copied, copy } = useCopied(2000);
  const command = gitCloneCommand(origin);
  return (
    <div className="el-code">
      <code>{command}</code>
      <button type="button" className="el-code-copy" onClick={() => void copy(command)}>
        {copied ? t`Copied!` : t`Copy`}
      </button>
    </div>
  );
};

/** Invalid TypeId, unknown type, or an entity the hub would not return. */
export const EntityNotFound: React.FC<{ type: string; id: string }> = ({ type, id }) => {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const label = typeNoun(type);
  const signInAgain = () => void cloudManager.logout(sdkNavigator.getLoginWithCallbackUrl(window.location.href));

  return (
    <div className="nl-page">
      <div className="nl-header el-header-muted">
        <h1 className="el-title">
          <SearchX className="el-title-icon" aria-hidden />
          <span>{t`Not found`}</span>
        </h1>
      </div>
      <div className="nl-container">
        <div className="nl-option el-card">
          <h2>{t`No ${label} with this id was found`}</h2>
          <p>{t`It may have been deleted, or it wasn't shared with this account.`}</p>
          <table className="el-ids">
            <tbody>
              <tr>
                <td>{t`Type`}</td>
                <td>
                  <code>{type}</code>
                </td>
              </tr>
              <tr>
                <td>{t`ID`}</td>
                <td>
                  <code>{id}</code>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="el-buttons">
            <a className="nl-btn" href={HUB_HOME_PATH}>
              {t`Go to Home`}
            </a>
          </div>
          {currentUser?.email && (
            <p className="el-who">
              {t`Signed in as ${currentUser.email}.`}{' '}
              <button type="button" className="el-link" onClick={signInAgain}>
                {t`Sign in with another account`}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};
