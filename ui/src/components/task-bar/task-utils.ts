import { dataContext, type Task, VFSPath } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { SkillsScope } from '@src/components/assets/editor/skill/skillEditorUtils';


export const TaskEventType = {
  TASK_CREATED: 'task_created',
  TASK_UPDATED: 'task_updated',
} as const;

export const TaskStatus = {
  TO_DO: 'to_do',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
} as const;

export const TaskType = {
  TASK: 'Task',
  ANALYSIS: 'analysis',
  SKILL_CREATION: 'skill_creation',
  CLASSIFICATION: 'classification',
  MEMORY_CREATION: 'memory_creation',
  RULE_CREATION: 'rule_creation',
  HOOK_CREATION: 'hook_creation',
} as const;

export function isSkillCreationTask(task: Task): boolean {
  return task.task_type === TaskType.SKILL_CREATION;
}

export function isAnalysisTask(task: Task): boolean {
  return task.task_type === TaskType.ANALYSIS;
}

export function isClassificationTask(task: Task): boolean {
  return task.task_type === TaskType.CLASSIFICATION;
}

/** Task types produced by "act according to classification" (phase 2). */
const ACTION_TASK_TYPES: ReadonlySet<string> = new Set([
  TaskType.SKILL_CREATION,
  TaskType.MEMORY_CREATION,
  TaskType.RULE_CREATION,
  TaskType.HOOK_CREATION,
]);

export function isActionTask(task: Task): boolean {
  return ACTION_TASK_TYPES.has(task.task_type ?? '');
}

export interface ClassificationInfo {
  category: string;
  title: string;
  command: string;
}

/** Extract classification result from a completed classification task. */
export function getClassificationInfo(task: Task): ClassificationInfo | null {
  if (task.task_type !== TaskType.CLASSIFICATION) return null;
  const { classification_category: category, classification_title: title, classification_command: command } = task;
  if (typeof category !== 'string' || typeof title !== 'string' || typeof command !== 'string') return null;
  return { category, title, command };
}

/** Get the analysis report machine path from a task, or null. */
export function getAnalysisPath(task: Task): string | null {
  if (task.task_type !== TaskType.ANALYSIS) return null;
  return task.analysis_path ?? null;
}

/** Get the analysis JSON machine path from a task, or null. */
export function getAnalysisJsonPath(task: Task): string | null {
  if (task.task_type !== TaskType.ANALYSIS) return null;
  return task.analysis_json_path ?? null;
}

export interface ArtifactInfo {
  path: string;
  label: string;
  /** When set, clicking navigates to the skills tab instead of opening the file. */
  skillDockPath?: string;
}

const SKILL_SCOPE_TO_DOCK: Record<string, SkillsScope> = {
  user: SkillsScope.User,
  project: SkillsScope.Project,
  system: SkillsScope.System,
};

/** Get artifact paths from a task. */
export function getArtifactPaths(task: Task): ArtifactInfo[] {
  const artifacts: ArtifactInfo[] = [];

  const skillPath = task.skill_path;
  const analysisPath = task.analysis_path;
  const analysisJsonPath = task.analysis_json_path;
  const outputDir = task.output_dir;
  const skillName = task.skill_name;
  const folderName = task.folder_name;
  const skillScope = task.skill_scope;

  // folder_name is the kebab-case name used for file paths; skill_name is the display name
  const effectiveFolder = typeof folderName === 'string' && folderName ? folderName : skillName;

  // Build the skills-tab dock path from scope + folder name
  const dockPrefix = SKILL_SCOPE_TO_DOCK[typeof skillScope === 'string' ? skillScope : ''] ?? SkillsScope.User;
  const skillDockPath =
    typeof effectiveFolder === 'string' && effectiveFolder ? `${dockPrefix}/${effectiveFolder}` : undefined;

  // SKILL.md -- explicit path or derived from output_dir + folder_name
  if (typeof skillPath === 'string') {
    artifacts.push({ path: skillPath, label: 'SKILL.md', skillDockPath });
  } else if (typeof outputDir === 'string' && typeof effectiveFolder === 'string' && effectiveFolder) {
    const normalized = outputDir.replace(/\\/g, '/');
    artifacts.push({ path: `${normalized}/${effectiveFolder}/SKILL.md`, label: 'SKILL.md', skillDockPath });
  }

  // analysis.md — in references subfolder
  if (typeof analysisPath === 'string') {
    artifacts.push({ path: analysisPath, label: 'analysis.md' });
  } else if (typeof outputDir === 'string') {
    const normalized = outputDir.replace(/\\/g, '/');
    artifacts.push({ path: `${normalized}/analysis.md`, label: 'analysis.md' });
  }

  // analysis.json — in references subfolder
  if (typeof analysisJsonPath === 'string') {
    artifacts.push({ path: analysisJsonPath, label: 'analysis.json' });
  } else if (typeof outputDir === 'string') {
    const normalized = outputDir.replace(/\\/g, '/');
    artifacts.push({ path: `${normalized}/analysis.json`, label: 'analysis.json' });
  }

  // classification.json for classification tasks
  const classificationPath = task.classification_path;
  if (typeof classificationPath === 'string') {
    artifacts.push({ path: classificationPath, label: 'classification.json' });
  } else if (task.task_type === TaskType.CLASSIFICATION && typeof outputDir === 'string') {
    const normalized = outputDir.replace(/\\/g, '/');
    artifacts.push({ path: `${normalized}/classification.json`, label: 'classification.json' });
  }

  // Generic artifacts from task.artifacts array
  const taskArtifacts = task.artifacts;
  if (Array.isArray(taskArtifacts)) {
    for (const artifact of taskArtifacts) {
      if (typeof artifact === 'string') {
        // Simple string path
        const filename = artifact.split('/').pop() || artifact;
        artifacts.push({ path: artifact, label: filename });
      } else if (artifact && typeof artifact === 'object') {
        // Object with path and optional label
        const path = artifact.path;
        const label = artifact.label || artifact.name || path?.split('/').pop() || 'file';
        if (typeof path === 'string') {
          artifacts.push({ path, label });
        }
      }
    }
  }

  return artifacts;
}

/** Open an analysis report in the editor. */
export function openAnalysisReport(analysisPath: string, navigation: NavigationActions): void {
  const computeNodeTypeId = dataContext.computeNode?.typeId;
  if (computeNodeTypeId) {
    const vfsPath = VFSPath.fromMachinePath(analysisPath, computeNodeTypeId);
    navigation.openDock(DockPointer.forFile(vfsPath.absVfsPath));
  } else {
    navigation.openDock(DockPointer.forFile(analysisPath));
  }
}

/** Open any file artifact in the editor. */
export function openArtifact(artifactPath: string, navigation: NavigationActions): void {
  openAnalysisReport(artifactPath, navigation); // Reuse the same logic
}

/** Return Tailwind classes for a task status badge. */
export function getStatusBadgeClass(status: string): string {
  switch (status) {
    case TaskStatus.DONE:
      return 'bg-green-100 text-green-800';
    case TaskStatus.IN_PROGRESS:
      return 'bg-blue-100 text-blue-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

/**
 * Get a displayable type label from the task.
 * Checks active_form, task_type_label, or task_type field.
 */
export function getTaskTypeLabel(task: Task): string | null {
  if (task.active_form) return task.active_form;
  if (task.task_type_label) return task.task_type_label;
  if (task.task_type && task.task_type !== TaskType.TASK && task.task_type !== 'task') {
    return task.task_type
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  return null;
}
