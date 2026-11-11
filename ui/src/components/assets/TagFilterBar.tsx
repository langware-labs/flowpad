import { TagInput } from '@src/components/tags/TagInput';

interface Props {
  tags: string[];
  onTagsChange: (tags: string[]) => void;
}

/** The tag filter of an asset list: the shared tag field, so it suggests and converts like every other. */
export function TagFilterBar({ tags, onTagsChange }: Props) {
  return (
    <TagInput
      tags={tags}
      onAdd={(tag) => onTagsChange([...tags, tag])}
      onRemove={(tag) => onTagsChange(tags.filter((t) => t !== tag))}
    />
  );
}
