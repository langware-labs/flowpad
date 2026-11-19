import { ActionInfo } from '../models/ActionInfo';
import type { HttpMethod } from '../models/ApiUrl';

/** A hub-owned action -- the local server forwards it to the hub verbatim, with or without an id
 * (`catalog`, `token_plan/me` included). */
export function hubAction(name: string, type: string, id: string | null, method: HttpMethod, subpath?: string) {
  const info = new ActionInfo(name, type, id, method);
  if (subpath) info.subpath = subpath;
  info.hubReflect = true;
  return info;
}
