import { ChevronRight, ChevronDown, FileIcon, FolderIcon } from 'lucide-react';
import { useState } from 'react';
import './SkillFileTree.css';

export interface TreeNode {
  name: string;
  type: 'file' | 'directory';
  children?: TreeNode[];
}

interface SkillFileTreeProps {
  tree: TreeNode;
  skillFolder: string;
  onSelectFile: (absolutePath: string) => void;
  _relativePath?: string;
  _level?: number;
}

function TreeNodeComponent({
  node,
  skillFolder,
  onSelectFile,
  relativePath,
  level = 0,
}: {
  node: TreeNode;
  skillFolder: string;
  onSelectFile: (absolutePath: string) => void;
  relativePath: string;
  level?: number;
}) {
  const [isOpen, setIsOpen] = useState(level === 0);

  if (node.type === 'file') {
    const absolutePath = relativePath ? `${skillFolder}/${relativePath}/${node.name}` : `${skillFolder}/${node.name}`;
    return (
      <li className="skill-tree-file">
        <button
          className="skill-tree-file-button"
          onClick={() => onSelectFile(absolutePath)}
          title={absolutePath}
        >
          <FileIcon className="h-4 w-4" />
          <span>{node.name}</span>
        </button>
      </li>
    );
  }

  const newRelativePath = relativePath ? `${relativePath}/${node.name}` : node.name;

  return (
    <li className="skill-tree-folder">
      <button
        className="skill-tree-folder-button"
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        <FolderIcon className="h-4 w-4" />
        <span>{node.name}</span>
      </button>
      {isOpen && node.children && (
        <ul className="skill-tree-children">
          {node.children.map((child) => (
            <TreeNodeComponent
              key={`${newRelativePath}/${child.name}`}
              node={child}
              skillFolder={skillFolder}
              onSelectFile={onSelectFile}
              relativePath={newRelativePath}
              level={level + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function SkillFileTree({
  tree,
  skillFolder,
  onSelectFile,
}: SkillFileTreeProps) {
  return (
    <div className="skill-file-tree">
      <ul className="skill-tree-root">
        {tree.children?.map((child) => (
          <TreeNodeComponent
            key={`${child.name}`}
            node={child}
            skillFolder={skillFolder}
            onSelectFile={onSelectFile}
            relativePath=""
            level={0}
          />
        ))}
      </ul>
    </div>
  );
}
