import config from '../config';
import { ParameterValue } from './ActionInfo';
import { TypeId } from './TypeId';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * Request parameters with improved type safety
 * Uses same flexible type as ActionParameters for consistency
 */
type RequestParameters = Record<string, ParameterValue> | Record<string, unknown> | FormData;

export class ApiUrl {
  private _targetEntityTypeId: TypeId | null = null;
  private _directResourceType: string | null = null;
  private _scope: TypeId[] = [];
  private _action: string | null = null;
  private _subPath: string | null = null;
  private _queryParameters: RequestParameters = {};
  private _bodyParameters: RequestParameters = {};
  private _method: HttpMethod;
  private _prefix: string | null = null;

  constructor(method: HttpMethod = 'GET', useGraphPrefix: boolean = true) {
    this._method = method;
    if (useGraphPrefix) {
      this._prefix = `${config.API_PREFIXES.graph}`;
    } else {
      this._prefix = '';
    }
    // ;
    // if (useGraphPrefix) {
    //     this._prefix = `${ApiUrl.API_PREFIX}${ApiUrl.GRAPH_PREFIX}`;
    // } else {
    //     this._prefix = ApiUrl.API_PREFIX;
    // }
  }

  public get method(): HttpMethod {
    return this._method;
  }

  public set method(method: HttpMethod) {
    this._method = method;
  }

  public get prefix(): string | null {
    return this._prefix;
  }

  public set prefix(prefix: string) {
    this._prefix = prefix;
  }

  public get targetEntityTypeId(): TypeId | null {
    return this._targetEntityTypeId;
  }

  public set targetEntityTypeId(value: TypeId | null) {
    this._targetEntityTypeId = value;
  }

  public get directResourceType(): string | null {
    return this._directResourceType;
  }

  public set directResourceType(value: string | null) {
    this._directResourceType = value;
  }

  public get scope(): TypeId[] {
    return this._scope;
  }

  public set scope(value: TypeId[]) {
    this._scope = value;
  }

  public get action(): string | null {
    return this._action;
  }

  public set action(value: string | null) {
    this._action = value;
  }

  public get subPath(): string | null {
    return this._subPath;
  }

  public set subPath(value: string | null) {
    this._subPath = value;
  }

  public get queryParameters(): RequestParameters {
    return this._queryParameters;
  }

  public set queryParameters(value: RequestParameters) {
    this._queryParameters = value;
  }

  public get bodyParameters(): RequestParameters {
    return this._bodyParameters;
  }

  public set bodyParameters(value: RequestParameters) {
    this._bodyParameters = value;
  }

  // Generate the full URL
  public toString(): string {
    const parts: string[] = [];
    if (this._prefix) {
      parts.push(this._prefix);
    }

    // Add scope
    if (this._scope) {
      parts.push(...this._scope.map((entityTypeId) => `${entityTypeId.type}/${entityTypeId.id}`));
    }

    // Add target entity path
    if (this._targetEntityTypeId) {
      parts.push(`${this._targetEntityTypeId.type}/${this._targetEntityTypeId.id}`);
    } else if (this._directResourceType) {
      parts.push(this._directResourceType);
    }

    // Add action
    if (this._action) {
      parts.push(this._action);
    }

    // Add subpath
    if (this._subPath) {
      parts.push(this._subPath);
    }

    // Join all parts and handle query parameters
    let url = parts.filter(Boolean).join('/');

    // Add query parameters if any
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(this.queryParameters)) {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    }
    const queryString = queryParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }

    return url;
  }
}
