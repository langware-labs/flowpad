interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

type CaptureRegionFn = (region: CaptureRegion) => Promise<string>;

interface CaptureWindow {
  electronAPI?: {
    captureRegion?: CaptureRegionFn;
  };
  __flowpadCaptureRegion?: CaptureRegionFn;
}

function imageName(prefix = 'display-annotation') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}.png`;
}

export async function captureElementAsImageFile(element: HTMLElement, name = imageName()): Promise<File> {
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    throw new Error('The active view is too small to capture.');
  }

  const w = window as unknown as CaptureWindow;
  const captureRegion = w.electronAPI?.captureRegion ?? w.__flowpadCaptureRegion;
  if (!captureRegion) {
    throw new Error('Display capture is only available in the desktop app.');
  }

  const dataUrl = await captureRegion({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    devicePixelRatio: window.devicePixelRatio || 1,
  });

  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type || 'image/png', lastModified: Date.now() });
}

export function hasElectronDisplayCapture(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as CaptureWindow;
  return typeof w.electronAPI?.captureRegion === 'function';
}
