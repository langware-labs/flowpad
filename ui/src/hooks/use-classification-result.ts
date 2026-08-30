import { useEffect, useState } from 'react';
import { dataContext, fsManager, type Task } from '@sdk';
import { type ClassificationInfo, getClassificationInfo } from '@src/components/task-bar/task-utils';

/**
 * Hook that resolves the classification result for a classification task.
 *
 * First checks the task fields (fast path). If not present, reads the
 * classification.json file via fsManager (reliable path — same file
 * the Bookmarks tab links to). Tries the file read regardless of task status
 * since the file may exist even if the task is stuck in_progress.
 */
export function useClassificationResult(task: Task | null): ClassificationInfo | null {
  const [fileResult, setFileResult] = useState<ClassificationInfo | null>(null);

  // Fast path: task already has the fields
  const metaResult = task ? getClassificationInfo(task) : null;

  // Derive path: explicit classification_path, or output_dir + '/classification.json'
  const classificationPath =
    task?.classification_path ??
    (task?.output_dir ? `${task.output_dir.replace(/\\/g, '/')}/classification.json` : null) ??
    null;
  const needsFileRead = !metaResult && !!classificationPath;

  useEffect(() => {
    if (!needsFileRead || !classificationPath) {
      setFileResult(null);
      return;
    }

    const computeNodeTypeId = dataContext.computeNode?.typeId;
    if (!computeNodeTypeId) return;

    let cancelled = false;

    const readFile = async () => {
      try {
        const content = await fsManager.download(computeNodeTypeId, classificationPath);
        if (cancelled || !content) return;
        // `download` without `asBlob` resolves a string; the Blob arm is decoded
        // through Blob.text() — TextDecoder cannot read a Blob, it needs a buffer.
        const text = typeof content === 'string' ? content : await content.text();
        const parsed = JSON.parse(text);
        if (parsed.category && parsed.title && parsed.command) {
          setFileResult({
            category: parsed.category,
            title: parsed.title,
            command: parsed.command,
          });
        }
      } catch {
        // File not ready yet or unreadable — leave as null
      }
    };
    void readFile();

    return () => {
      cancelled = true;
    };
  }, [needsFileRead, classificationPath]);

  return metaResult ?? fileResult;
}
