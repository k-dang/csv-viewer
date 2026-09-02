import { supportedCsvFileExtensions } from '../shared/csv-viewer-contract';

export const portableCsvInputAccept = supportedCsvFileExtensions
  .map((extension) => `.${extension}`)
  .join(',');

/** Opens a portable single-file input and forgets the element as soon as the choice settles. */
export function pickPortableCsvSource(): Promise<File | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = portableCsvInputAccept;
  input.hidden = true;
  document.body.append(input);

  return new Promise((resolve, reject) => {
    // Whichever of change and cancel arrives first settles the Promise; a second one is a no-op,
    // as is removing an already-detached element.
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.item(0) ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    try {
      input.click();
    } catch (error) {
      input.remove();
      reject(error);
    }
  });
}
