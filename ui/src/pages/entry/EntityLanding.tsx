import { useLingui } from '@lingui/react/macro';
import { type AnyEntity, cloudManager, dataManager, navigator as sdkNavigator, type TypeId } from '@sdk';
import { useAuth, useEntity } from '@sdk/react/hooks';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { isHubOnly } from '@src/navigation/hub-runtime';
import NotFound from '@src/pages/NotFound';
import { humanizeType } from '@src/utils/humanize';
import { Globe, Laptop, SearchX } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import {
  entityLandingInputFrom,
  entityLandingModel,
  entityLandingProblem,
  parseEntityLandingParams,
} from './entity-landing-model';
import './entity-landing.css';
import './message-landing.css';
import WrongAccountPanel from './WrongAccountPanel';

const HUB_HOME = '/dock/hub/home';

/**
 * `/<type>/<id>` — the generic landing a shared entity's invitation lands on.
 *
 * The hub's `members/accept` redirects here (`build_entity_url`) whenever the
 * invitation carries no `callback_override`; a client that wants a type-specific
 * destination sets one. So this page knows nothing about any type: it reads the
 * route params, the hub's TypeInfo, and the entity row (see
 * `entity-landing-model.ts`), and offers the hub's generic entity view — plus a
 * "work on it on your machine" card when there is something to take there.
 *
 * Hub only. Anywhere else the URL is what it always was: not a route.
 */
const EntityLanding: React.FC = () => {
  if (!isHubOnly()) return <NotFound />;
  return <HubEntityLanding />;
};

const HubEntityLanding: React.FC = () => {
  const { entityType, entityId } = useParams<{ entityType: string; entityId: string }>();
  const typeId = parseEntityLandingParams(entityType, entityId);
  // An unregistered type cannot be read, only 422'd — skip the round trip.
  const known = !!typeId && !!dataManager.getTypeInfo(typeId.type);
  if (!typeId || !known) return <EntityNotFound type={entityType ?? ''} id={entityId ?? ''} />;
  return (
    <EntityLandingGate key={typeId.toString()} typeId={typeId}>
      {(entity) => (
        <EntityLandingView
          typeId={typeId}
          model={entityLandingModel(
            entityLandingInputFrom(typeId, entity, dataManager.getTypeInfo(typeId.type)?.cloud_file_transport),
          )}
        />
      )}
    </EntityLandingGate>
  );
};

/**
 * Everything an entry page does before it has an entity to show, shared by the
 * generic landing and the type-specific ones (`ProjectShareLanding`): read it,
 * spin while that runs, take a 401 through one login round trip (as
 * MessageLanding does), then the wrong-account panel; a dead link gets the
 * not-found page. `children` renders the entity once it is there.
 */
export const EntityLandingGate: React.FC<{ typeId: TypeId; children: (entity: AnyEntity) => React.ReactNode }> = ({
  typeId,
  children,
}) => {
  const { t } = useLingui();
  const [redirecting, setRedirecting] = useState(false);
  const [wrongAccount, setWrongAccount] = useState(false);

  // Same one-shot login round trip as MessageLanding: a 401 goes to sign-in once;
  // a 401 on the way back means this account has no access.
  const loginAttemptKey = `login-attempt-entity-${typeId.toString()}`;
  const hasAttemptedLogin = !!sessionStorage.getItem(loginAttemptKey);

  const { data: entity, isLoading, notFound, error } = useEntity(wrongAccount ? null : typeId);
  const problem = entityLandingProblem({ notFound, error });

  useEffect(() => {
    if (problem !== 'signed-out') return;
    if (hasAttemptedLogin) {
      setWrongAccount(true);
      return;
    }
    sessionStorage.setItem(loginAttemptKey, '1');
    setRedirecting(true);
    window.location.assign(sdkNavigator.getLoginWithCallbackUrl(window.location.href));
  }, [problem, hasAttemptedLogin, loginAttemptKey]);

  if (wrongAccount) {
    return <WrongAccountPanel reason="no-access" onBeforeSignIn={() => sessionStorage.removeItem(loginAttemptKey)} />;
  }
  if (problem === 'not-found') return <EntityNotFound type={typeId.type} id={typeId.id} />;
  if (problem === 'failed') {
    return (
      <div className="nl-center">
        <p className="nl-error">{t`Something went wrong opening this link. Try again in a moment.`}</p>
      </div>
    );
  }
  if (isLoading || redirecting || problem === 'signed-out' || !entity) {
    return (
      <div className="nl-center">
        <div className="nl-spinner" aria-label={t`Loading`} />
      </div>
    );
  }

  return <>{children(entity)}</>;
};

const EntityLandingView: React.FC<{ typeId: TypeId; model: ReturnType<typeof entityLandingModel> }> = ({
  typeId,
  model,
}) => {
  const { t } = useLingui();
  const TypeIcon = iconForType(typeId.type);
  // The chip is the app's localized type word (the registry's own number, e.g.
  // "Agents"). Sentences use the singular English noun instead; translations are
  // written without that placeholder, so no English word leaks into them.
  const typeLabel = labelForType(typeId.type);
  const label = humanizeType(typeId.type).toLowerCase();
  const name = model.displayName;

  return (
    <div className="nl-page el-page">
      <div className="nl-header">
        <h1 className="el-title">
          <TypeIcon className="el-title-icon" aria-hidden />
          <span>{name}</span>
          <span className="el-type-chip">{typeLabel}</span>
        </h1>
      </div>
      <div className="nl-container">
        <div className="nl-intro">
          {/* Not "shared with you": mention emails and an owner's own old links land
              here too. Having loaded it at all is what is always true. */}
          <p className="nl-task-from">{t`You have access to this ${label}.`}</p>
        </div>
        {model.description && (
          <p className="nl-msg">
            <em>&quot;{model.description}&quot;</em>
          </p>
        )}

        <p className="nl-section-label">
          {model.showDesktop ? t`Open the ${label} using one of these options:` : t`Open the ${label}:`}
        </p>

        <div className={model.showDesktop ? 'nl-options' : 'nl-options el-options-single'}>
          <div className="nl-option el-option">
            <h3 className="el-option-title">
              <Globe className="nl-agent-icon" size={20} aria-hidden />
              <span>{t`Open in your browser`}</span>
            </h3>
            <p className="el-grow">{t`View ${name} on FlowPad. Nothing to install.`}</p>
            <div className="el-buttons">
              <a className="nl-btn" href={model.hubUrl} data-testid="entity-landing-open">
                {t`Open ${name}`}
              </a>
            </div>
          </div>

          {model.showDesktop && (
            <div className="nl-option el-option" data-testid="entity-landing-desktop">
              <h3 className="el-option-title">
                <Laptop className="nl-agent-icon" size={20} aria-hidden />
                <span>{t`Work on it on your machine`}</span>
              </h3>
              <p className="el-grow">
                {model.cloneCommand
                  ? model.repoPath
                    ? t`It lives in git under ${model.repoPath}. Clone it, and open it in the FlowPad desktop app.`
                    : t`It lives in git. Clone it, and open it in the FlowPad desktop app.`
                  : t`Work on it in the FlowPad desktop app with your coding agents.`}
              </p>
              <div className="el-buttons">
                <a className="nl-btn" href="https://flowpad.ai/">
                  {t`Get FlowPad at flowpad.ai →`}
                </a>
              </div>
              {model.cloneCommand && <CopyLine text={model.cloneCommand} />}
            </div>
          )}
        </div>

        <div className="nl-footer">
          FlowPad &middot; <a href="https://flowpad.ai">flowpad.ai</a>
        </div>
      </div>
    </div>
  );
};

export const CopyLine: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await window.navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard refused — the command stays selectable */
    }
  };
  return (
    <div className="el-code">
      <code>{text}</code>
      <button type="button" className="el-code-copy" onClick={() => void copy()}>
        {copied ? t`Copied!` : t`Copy`}
      </button>
    </div>
  );
};

/** Invalid TypeId, unknown type, or an entity the hub would not return. */
export const EntityNotFound: React.FC<{ type: string; id: string }> = ({ type, id }) => {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const label = type ? humanizeType(type).toLowerCase() : t`item`;
  // Same seam as WrongAccountPanel: log out, then sign in and come back here.
  const signIn = () => void cloudManager.logout(sdkNavigator.getLoginWithCallbackUrl(window.location.href));

  return (
    <div className="nl-page el-page" data-testid="entity-landing-not-found">
      <div className="nl-header el-header-muted">
        <h1 className="el-title">
          <SearchX className="el-title-icon" aria-hidden />
          <span>{t`Not found`}</span>
        </h1>
      </div>
      <div className="nl-container">
        <div className="el-card">
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
            <a className="nl-btn" href={HUB_HOME}>
              {t`Go to Home`}
            </a>
          </div>
          {currentUser?.email && (
            <p className="el-who">
              {t`Signed in as ${currentUser.email}.`}{' '}
              <button type="button" className="el-link" onClick={signIn}>
                {t`Sign in with another account`}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default EntityLanding;
