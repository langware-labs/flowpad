import { ResponseType } from 'axios';
import config from '../config';
import { ApiUrl, HttpMethod } from './ApiUrl';
import { TypeId } from './TypeId';

/**
 * Type-safe parameter value for API requests
 * Supports primitives, arrays, nested objects, and custom types
 * More flexible than strict recursion to accommodate FormData, custom classes, etc.
 */
export type ParameterValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ParameterValue[]
  | Record<string, unknown>
  | { [key: string]: any };

/**
 * Action parameters with improved type safety
 * Previously used 'any' which prevented type checking
 * Now allows structured types while maintaining flexibility for special cases like FormData
 * Uses union type to accept any valid parameter structure
 */
export type ActionParameters = Record<string, ParameterValue> | Record<string, unknown> | FormData;

export class ActionInfo {
  private _name: string;
  private _targetEntity: TypeId | null;
  private _resourceType: string | null;
  private _queryParameters: ActionParameters;
  private _bodyParameters: ActionParameters;
  private _method: HttpMethod;
  private _scope: TypeId[] = [];
  private _subpath: string | null = null;
  private _isRawResponse: boolean = false;
  private _isStreaming: boolean = false;
  private _abortSignal: AbortSignal | null = null;
  private _responseType: ResponseType | null = null;
  private _castResponse: boolean = false;
  // Per-call hub-reflection opt-in. When true the call is forwarded to the hub
  // (HTTP: `Hub-Reflect: true` header; WS: `hub_reflect` field on the rest_api_msg).
  // Default false — reflection is opt-in; the server default is "do not reflect".
  private _hubReflect: boolean = false;

  constructor(
    name: string,
    resourceType: string | null = null,
    resourceId: string | null = null,
    method: HttpMethod = 'GET',
    isRawResponse: boolean = false,
    isStreaming: boolean = false,
    abortSignal: AbortSignal | null = null,
    responseType: ResponseType | null = null,
    castResponse: boolean = false,
  ) {
    this._name = name;
    this._resourceType = resourceType;
    if (resourceType && resourceId) {
      this._targetEntity = new TypeId(resourceType, resourceId);
    } else {
      this._targetEntity = null;
    }
    this._queryParameters = {};
    this._bodyParameters = {};
    this._method = method;
    this._isRawResponse = isRawResponse;
    this._isStreaming = isStreaming;
    this._abortSignal = abortSignal;
    this._responseType = responseType;
    this._castResponse = castResponse;
  }
  public get scope(): TypeId[] {
    return this._scope;
  }

  public set scope(value: TypeId[]) {
    this._scope = value;
  }

  public get name(): string {
    return this._name;
  }

  public set name(value: string) {
    this._name = value;
  }

  public get subpath(): string | null {
    return this._subpath;
  }

  public set subpath(value: string | null | string[]) {
    if (Array.isArray(value)) {
      this._subpath = value.join('/');
    } else {
      this._subpath = value;
    }
  }

  public get targetEntity(): TypeId | null {
    return this._targetEntity;
  }

  public set targetEntity(value: TypeId) {
    this._targetEntity = value;
  }

  public get queryParameters(): ActionParameters {
    return this._queryParameters;
  }

  public set queryParameters(value: ActionParameters) {
    this._queryParameters = value;
  }

  public get bodyParameters(): ActionParameters {
    return this._bodyParameters;
  }

  public set bodyParameters(value: ActionParameters) {
    this._bodyParameters = value;
  }

  public get method(): HttpMethod {
    return this._method;
  }

  public set method(value: HttpMethod) {
    this._method = value;
  }

  public get isRawResponse(): boolean {
    return this._isRawResponse;
  }

  public set isRawResponse(value: boolean) {
    this._isRawResponse = value;
  }

  public get isStreaming(): boolean {
    return this._isStreaming;
  }

  public set isStreaming(value: boolean) {
    this._isStreaming = value;
  }

  public get abortSignal(): AbortSignal | null {
    return this._abortSignal;
  }

  public set abortSignal(value: AbortSignal | null) {
    this._abortSignal = value;
  }

  public get responseType(): ResponseType | null {
    return this._responseType;
  }

  public set responseType(value: ResponseType | null) {
    this._responseType = value;
  }

  public get castResponse(): boolean {
    return this._castResponse;
  }

  public set castResponse(value: boolean) {
    this._castResponse = value;
  }

  public get hubReflect(): boolean {
    return this._hubReflect;
  }

  public set hubReflect(value: boolean) {
    this._hubReflect = value;
  }

  public get actionUrl(): string {
    const apiUrl = new ApiUrl(this._method);
    if (this._targetEntity) {
      apiUrl.targetEntityTypeId = this._targetEntity;
    }
    apiUrl.scope = this.scope;
    apiUrl.directResourceType = this._resourceType;
    apiUrl.action = this._name;
    apiUrl.queryParameters = this.queryParameters;
    apiUrl.bodyParameters = this.bodyParameters;
    apiUrl.subPath = this.subpath;
    return apiUrl.toString();
  }

  public get fullActionUrl(): string {
    return `${config.SERVER_URL}${this.actionUrl}`;
  }
}
