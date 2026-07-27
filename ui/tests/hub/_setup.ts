import { installCleanup } from '../_cleanup';
import {
  HUB_INST_1,
  HUB_INST_2,
  resolveLaunchedInstance,
} from './_instances';

// The selected generated instance env is resolved in vitest.config.ts and baked
// in via `define`. Validate it HERE so unrelated projects may evaluate the hub
// config, while an actual hub run fails closed before touching any backend.
declare const __HUB_INSTANCE_NAME__: string;
declare const __HUB_BACKEND_PORT__: string;
const selectedInstance = process.env.FLOW_INSTANCE?.trim() || '';
if (
  !selectedInstance ||
  !HUB_INST_1 ||
  !HUB_INST_2 ||
  HUB_INST_1 === HUB_INST_2 ||
  ![HUB_INST_1, HUB_INST_2].includes(selectedInstance)
) {
  throw new Error(
    'hub vitest requires distinct SHARE_INST_1/SHARE_INST_2 and FLOW_INSTANCE equal to one pair member',
  );
}
if (!process.env.ALICE_EMAIL || !process.env.ALICE_PW || !process.env.BOB_EMAIL || !process.env.BOB_PW) {
  throw new Error('hub vitest requires ALICE_EMAIL/ALICE_PW and BOB_EMAIL/BOB_PW');
}

const launched1 = resolveLaunchedInstance(HUB_INST_1);
const launched2 = resolveLaunchedInstance(HUB_INST_2);
const selected = selectedInstance === HUB_INST_1 ? launched1 : launched2;
const selectedPort = selected ? new URL(selected.apiUrl).port : '';
if (
  !launched1 ||
  !launched2 ||
  __HUB_INSTANCE_NAME__ !== selectedInstance ||
  __HUB_BACKEND_PORT__ !== selectedPort
) {
  throw new Error(
    `hub vitest pair '${HUB_INST_1}'/'${HUB_INST_2}' is not matching live launcher-owned infrastructure ` +
      '(generated env, launcher identity/ports/hub/credentials, and both PIDs must agree)',
  );
}

// Track + sweep every live local entity these hub tests mint before sharing to
// the hub. Scope is LOCAL-backend entities (the realm that created them); the
// remote hub copy is out of scope.
installCleanup({ sweepTypes: ['skill', 'conversation', 'workflow', 'whiteboard'] });
