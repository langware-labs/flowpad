import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface IClaudeMd extends IEntity {
  name?: string;
  source_path?: string;
  file_path?: string;
  filename?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  scope?: string;
}

/** `CLAUDE.md` instruction file, scoped per project or user. */
@registerEntity
export class ClaudeMd extends APIEntity<ClaudeMd> implements IClaudeMd {
  static type: string = 'claude_md';

  name?: string;
  source_path?: string;
  file_path?: string;
  filename?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
  scope?: string;

  constructor(entity: Partial<IClaudeMd> = {}) {
    super(entity);
    this.name = entity.name;
    this.source_path = entity.source_path;
    this.file_path = entity.file_path;
    this.filename = entity.filename;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
    this.scope = entity.scope;
  }
}
