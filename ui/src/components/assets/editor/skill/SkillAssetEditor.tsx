import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { MarkdownAssetEditor } from '@src/components/assets/editor/markdown/MarkdownAssetEditor';
import { dataContext } from '@sdk';
import { useMemo } from 'react';

interface SkillAssetEditorProps {
  /** Absolute machine path to the skill folder, or bare skill name for legacy DB entries */
  sourcePath: string;
}

/**
 * Thin wrapper around MarkdownAssetEditor for skill assets.
 *
 * Handles two path forms:
 *   - Absolute folder path: /Users/x/.claude/skills/my-skill → appends /SKILL.md
 *   - Bare name (legacy DB entry): "my-skill" → resolves against user_skills base path
 */
export function SkillAssetEditor({ sourcePath }: SkillAssetEditorProps) {
  const { computeNode } = useAgentContext();
  const typeIdStr = computeNode?.typeId?.toString();

  const skillMdPath = useMemo(() => {
    if (!typeIdStr) return null;

    let resolvedPath = sourcePath.replace(/\/$/, '');
    const isBareName = !resolvedPath.includes('/') || resolvedPath.lastIndexOf('/') === 0;

    if (isBareName) {
      const userSkillsBase = dataContext.bootstrapInfo?.desktop_info?.paths?.user_skills;
      const name = resolvedPath.replace(/^\//, '');
      resolvedPath = userSkillsBase
        ? `${userSkillsBase}/${name}`
        : `${computeNode!.typeId}/.claude/skills/${name}`;
    }

    if (!resolvedPath.startsWith('/')) resolvedPath = '/' + resolvedPath;

    return resolvedPath + '/SKILL.md';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeIdStr, sourcePath]);

  if (!skillMdPath) return null;

  return <MarkdownAssetEditor sourcePath={skillMdPath} />;
}
