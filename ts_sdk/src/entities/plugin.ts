import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

type ExecutionEnvironment = 'server' | 'client';

type FunctionCapability =
  | 'unknown'
  | 'entity-view'
  | 'entity-edit'
  | 'entity-list'
  | 'web-component'
  | 'auth-component'
  | 'python-script'
  | 'action'
  | 'react-component';

export interface IFunc extends IEntity {
  title: string;
  description: string;
  executor: ExecutionEnvironment;
  capability: FunctionCapability;
  capability_config: any;
  input_schema: string | { [key: string]: any };
  output_schema: string | { [key: string]: any };
  dependencies?: IFunc[];
}

@registerEntity
export class Func extends APIEntity<Func> implements IFunc {
  static type: string = 'func';
  title: string;
  description: string;
  executor: ExecutionEnvironment;
  capability: FunctionCapability;
  capability_config: any;
  input_schema: { [key: string]: any };
  output_schema: string | { [key: string]: any };
  dependencies?: Func[];

  constructor(entity: Partial<IFunc> = {}) {
    super(entity);
    this.title ||= '';
    this.description ||= '';
    this.executor ||= 'client';
    this.capability ||= 'unknown';
    this.capability_config ||= {};
    this.input_schema ||= {};
    this.output_schema ||= {};
  }
}

interface IPluginVersion {
  name: string;
  version: string;
}

interface IPluginManifest extends IEntity {
  name: string;
  title: string;
  description: string;
  category?: string;
  funcs: IFunc[];
  url?: string;
  latest: boolean;
  version: string;
  dependencies: IPluginVersion[];
}

@registerEntity
export class PluginManifest extends APIEntity<PluginManifest> implements IPluginManifest {
  static type: string = 'plugin_manifest';
  constructor(entity: Partial<IPluginManifest> = {}) {
    super(entity);
    this.title ||= '';
    this.description ||= '';
    if (entity.funcs) {
      this.funcs = entity.funcs.map((func) => new Func(func));
    } else {
      this.funcs = [];
    }
    this.name ||= this.title;
    this.latest ||= false;
    this.dependencies ||= [];
    this.version ||= '0.0.0-client';
  }
  version: string;
  url?: string | undefined;
  latest: boolean;
  dependencies: IPluginVersion[];
  type?: string | undefined;
  title: string;
  description: string;
  category?: string;
  funcs: Func[];
  name: string;
}

interface IPlugin extends IEntity {
  name: string;
  title: string;
  description: string;
  funcs: IFunc[];
  install_target?: string;
}

@registerEntity
export class Plugin extends APIEntity<Plugin> implements IPlugin {
  static type: string = 'plugin';

  constructor(entity: Partial<IPlugin> = {}) {
    super(entity);
    this.title ||= '';
    this.description ||= '';
    this.funcs ||= [];
    this.name ||= this.title;
  }

  title: string;
  description: string;
  funcs: IFunc[];
  name: string;
  install_target?: string;

  public static async fromUrl(url: string): Promise<Plugin> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch extension data: ${response.statusText}`);
    }
    const data: IPlugin = await response.json();
    return new Plugin(data);
  }
}
