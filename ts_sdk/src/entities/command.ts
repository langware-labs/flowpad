import { APIEntity, registerEntity } from '../APIEntity';
import { IEntity } from '../IEntity';

export interface ICommand extends IEntity {
  name?: string;
  description?: string;
  source_path?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;
}

/** Slash-command markdown file under `.claude/commands/*.md`. */
@registerEntity
export class Command extends APIEntity<Command> implements ICommand {
  static type: string = 'command';

  name?: string;
  description?: string;
  source_path?: string;
  asset_type?: string;
  parent_path?: string;
  vault_root?: string;

  constructor(entity: Partial<ICommand> = {}) {
    super(entity);
    this.name = entity.name;
    this.description = entity.description;
    this.source_path = entity.source_path;
    this.asset_type = entity.asset_type;
    this.parent_path = entity.parent_path;
    this.vault_root = entity.vault_root;
  }
}
