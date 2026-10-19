import { APIEntity, registerEntity } from '../APIEntity';

/**
 * The indexed projection of a project's `project_manifest.json` (the backend's
 * `ProjectManifest` row): what the project declares about itself and must travel
 * with a clone — its home page among them.
 *
 * Registered so a query for it keeps its rows: the store DROPS a row whose type
 * has no constructor, so without this class every read of the manifest came back
 * empty (the Home card showed "Default home" for any declared home page).
 */
@registerEntity
export class ProjectManifest extends APIEntity<ProjectManifest> {
  static type: string = 'project_manifest';

  /** The project this manifest belongs to. */
  project_id?: string;
  /** The declared home page — an asset TypeId (an agent, or a web app), or null for the default home. */
  home_page?: string | null;

  constructor(entity: Partial<ProjectManifest> = {}) {
    super(entity);
    this.project_id = entity.project_id;
    this.home_page = entity.home_page ?? null;
  }
}
