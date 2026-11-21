/**
 * The two drivers a session has ONE of, selected per project and machine: a browser driver
 * (`flow_sdk/builtin/browser_driver.py`) and a secret manager
 * (`flow_sdk/builtin/secret_manager.py`). Each is a shipped folder asset; the row carries its
 * manifest. Their editors are `apps/driver-editor.ts`.
 */
import { APIEntity, dataManager, registerEntity } from '../APIEntity';

/** One field a configured instance of a driver takes (`ConfigFieldSpec`). */
export interface DriverConfigField {
  name: string;
  label: string;
  required: boolean;
}

@registerEntity
export class BrowserDriver extends APIEntity<BrowserDriver> {
  static type: string = 'browser_driver';

  title: string = '';
  description: string = '';
  /** How each supported worker reaches it, by vendor key; `*` is every other worker. */
  workers: Record<string, { attach: 'mcp_server' | 'harness_extension'; setup: string }> = {};
  /** Flowpad starts and owns the window, on a profile of its own. */
  managed: boolean = false;
  apps: string[] = [];
  probe: 'cdp' | 'extension' = 'cdp';
  config_fields: DriverConfigField[] = [];
  defaults: Record<string, string> = {};
  tool_prefixes: string[] = [];
  install_url: string = '';

  /** Field defaults run AFTER the base constructor's assign and would blank the row (see
   *  `DataDriver`'s constructor for the full note); assign again once they have run. */
  constructor(json: Record<string, unknown> | undefined = undefined) {
    super(json as never);
    if (json) dataManager.deepAssign(this, json);
  }
}

@registerEntity
export class SecretManager extends APIEntity<SecretManager> {
  static type: string = 'secret_manager';

  title: string = '';
  description: string = '';
  /** What a vault of this manager is configured with. */
  config_fields: DriverConfigField[] = [];

  /** As `BrowserDriver`: assign again after the field defaults have run. */
  constructor(json: Record<string, unknown> | undefined = undefined) {
    super(json as never);
    if (json) dataManager.deepAssign(this, json);
  }
}
