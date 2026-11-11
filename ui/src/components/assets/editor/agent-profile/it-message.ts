import type { ItAttachment, ItMessageRequest } from '@sdk/entities/agent';

/** A picked file named `*.shape.json` is the answer shape (a JSON Schema each machine's value must match). */
export const ANSWER_SHAPE_SUFFIX = '.shape.json';

/** The operation id a name stands for, as the hub derives it ("Class status" -> `class-status`); '' when none. */
export function opIdOf(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export interface ItDraftFile {
  name: string;
  bytes: Uint8Array;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The `agent/<id>/it_message` body for a draft: every file rides as an attachment, except a `*.shape.json` one,
 * which becomes `answer_shape` (it must hold a JSON object). Sent to all of the agent's machines.
 */
export function itMessageRequest(text: string, files: ItDraftFile[]): ItMessageRequest {
  const attachments: ItAttachment[] = [];
  let answerShape: Record<string, unknown> | null = null;
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(ANSWER_SHAPE_SUFFIX)) {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(file.bytes));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${file.name}: an answer shape must be a JSON object`);
      }
      answerShape = parsed as Record<string, unknown>;
      continue;
    }
    attachments.push({ name: file.name, content_b64: toBase64(file.bytes) });
  }
  return { text, attachments, answer_shape: answerShape, targets: 'all' };
}

/** `itMessageRequest` for files picked in the browser. */
export async function itMessageRequestOf(text: string, files: File[]): Promise<ItMessageRequest> {
  const drafts = await Promise.all(
    files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
  );
  return itMessageRequest(text, drafts);
}
