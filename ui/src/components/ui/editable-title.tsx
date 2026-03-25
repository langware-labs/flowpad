import { Agent, dataContext, Flow, Page, PAGE_TYPE, Task } from '@sdk';
import React, { useEffect, useRef, useState } from 'react';
import { useEntity } from '@sdk/react/hooks/entity-hooks';
import { useDebounceCallback } from '@sdk/react/hooks/use-debounce-callback';
import { Input } from '../ui/input';

interface EditableTitleProps {
  entity: Page | Task | Agent | Flow;
  className?: string;
  placeholder?: string;
  debounceDelay?: number;
  testId?: string;
  autoFocus?: boolean;
}

export const EditableTitle: React.FC<EditableTitleProps> = ({
  entity: defaultEntity,
  className = '!text-3xl font-bold !border-none shadow-none !ring-0',
  placeholder = 'Untitled',
  debounceDelay = 1000,
  testId,
  autoFocus = true,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const entityRef = useRef(defaultEntity);

  const entityTypeId = defaultEntity?.typeId ?? null;
  const { data: nullableEntity } = useEntity<Page | Task | Agent | Flow>(entityTypeId, {
    watch: defaultEntity?.getType() === Page.type ? defaultEntity.saved && !defaultEntity.readOnly : undefined,
  });
  const entity = nullableEntity ?? defaultEntity;

  const [title, setTitle] = useState('');

  useEffect(() => {
    entityRef.current = entity;
  }, [entity]);

  useEffect(() => {
    if (!entity) return;

    if ('name' in entity) {
      if (!entity?.name) {
        if (autoFocus) {
          inputRef.current?.focus();
        }
        setTitle('');
      } else {
        setTitle(entity.name);
      }
    } else if ('title' in entity) {
      if (!entity?.title) {
        if (autoFocus) {
          inputRef.current?.focus();
        }
        setTitle('');
      } else {
        setTitle(entity.title);
      }
    }
  }, [entity, entity?.id, autoFocus]);

  const onChangeTitleCallback = useDebounceCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const currentEntity = entityRef.current;
      if (!currentEntity || currentEntity.readOnly) return;

      if ('name' in currentEntity) {
        // Agent
        currentEntity.name = e.target.value.trim();
      } else if ('title' in currentEntity) {
        // Page, Task, or Flow
        currentEntity.title = e.target.value.trim();
      }

      void currentEntity.save([dataContext.workspace!.typeId]);
    },
    debounceDelay,
    [],
  );

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTitle(e.target.value);
    onChangeTitleCallback?.(e);
  };

  if (!entity) {
    return null;
  }

  const canEditTitle =
    'tags' in entity
      ? !entity.readOnly && !entity.tags?.includes(PAGE_TYPE.PROFILE) && !entity.tags?.includes(PAGE_TYPE.INSTRUCTIONS)
      : !entity.readOnly;

  return (
    <Input
      ref={inputRef}
      className={className}
      data-testid={testId || `${defaultEntity.getType()}-title`}
      placeholder={placeholder}
      value={title}
      onChange={handleInputChange}
      readOnly={!canEditTitle}
    />
  );
};
