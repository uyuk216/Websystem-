import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DecryptViewer } from '../src/decrypt-viewer.js';

class FakeImage extends EventTarget {
  hidden = true;
  draggable = true;
  src = '';
  removeAttribute(name: string) { if (name === 'src') this.src = ''; }
}
const doc = new EventTarget() as EventTarget & { hidden: boolean };
const win = new EventTarget();
const envelope = { version: 1, ephemeralPublicKey: new Uint8Array(), kemCiphertext: new Uint8Array(), nonce: new Uint8Array(), ciphertext: new Uint8Array() };
const input = { envelope, uploadId: 'u', accountId: 'a' };
beforeEach(() => { vi.useFakeTimers(); doc.hidden = false; vi.stubGlobal('document', doc); vi.stubGlobal('window', win); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('zeros plaintext, prevents context/drag saving, revokes the URL after 30 seconds of inactivity', async () => {
  const bytes = new Uint8Array([1, 2, 3]), image = new FakeImage(), revoke = vi.spyOn(URL, 'revokeObjectURL');
  const viewer = new DecryptViewer(image as unknown as HTMLImageElement, { decrypt: async () => bytes });
  await viewer.show(input);
  expect([...bytes]).toEqual([0, 0, 0]); expect(image.hidden).toBe(false); expect(image.draggable).toBe(false);
  expect(image.dispatchEvent(new Event('contextmenu', { cancelable: true }))).toBe(false);
  expect(image.dispatchEvent(new Event('dragstart', { cancelable: true }))).toBe(false);
  vi.advanceTimersByTime(29_999); expect(image.hidden).toBe(false);
  doc.dispatchEvent(new Event('keydown')); vi.advanceTimersByTime(29_999); expect(image.hidden).toBe(false);
  vi.advanceTimersByTime(1); expect(image.hidden).toBe(true); expect(image.src).toBe(''); expect(revoke).toHaveBeenCalledTimes(1);
  viewer.dispose();
});
it('closing while decryption is in flight prevents a late image and still zeroes plaintext', async () => {
  const image = new FakeImage(); let resolve!: (b: Uint8Array) => void;
  const viewer = new DecryptViewer(image as unknown as HTMLImageElement, { decrypt: () => new Promise((r) => { resolve = r; }) });
  const pending = viewer.show(input); viewer.close(); const bytes = new Uint8Array([1, 2]); resolve(bytes); await pending;
  expect(image.hidden).toBe(true); expect(image.src).toBe(''); expect([...bytes]).toEqual([0, 0]); viewer.dispose();
});
it('in-flight decryption cannot resurrect an image after the idle timeout', async () => {
  const image = new FakeImage(); let resolve!: (b: Uint8Array) => void;
  const viewer = new DecryptViewer(image as unknown as HTMLImageElement, { decrypt: () => new Promise((r) => { resolve = r; }) });
  const pending = viewer.show(input); vi.advanceTimersByTime(30_000); resolve(new Uint8Array([1])); await pending;
  expect(image.hidden).toBe(true); expect(image.src).toBe(''); viewer.dispose();
});
it('hiding the document and page exit destroy the displayed image', async () => {
  const image = new FakeImage(), viewer = new DecryptViewer(image as unknown as HTMLImageElement, { decrypt: async () => new Uint8Array([1]) });
  await viewer.show(input); doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange')); expect(image.hidden).toBe(true);
  await viewer.show(input); win.dispatchEvent(new Event('pagehide')); expect(image.hidden).toBe(true); viewer.dispose();
});
