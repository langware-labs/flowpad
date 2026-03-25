import { ViewType } from '../utils/ui/view-types';

export interface IDockPointer {
  viewType?: ViewType;
  pointer?: string;
  options?: Record<string, string>;
}

export class DockPointerData implements IDockPointer {
  constructor(
    public readonly viewType: ViewType,
    public readonly pointer?: string,
    public readonly options?: Record<string, string>,
  ) {}
}
