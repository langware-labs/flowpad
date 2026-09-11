import { expect, it } from 'vitest';
import { unitTestSetup } from '../utils/test-utils';

it('keeps browser Blob bytes intact when a File is created after shared setup', async () => {
  await unitTestSetup();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const file = new File([new Blob([bytes])], 'image.png');
  const read = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file bytes'));
    reader.readAsArrayBuffer(file);
  });
  expect(new Uint8Array(read)).toEqual(bytes);
});
