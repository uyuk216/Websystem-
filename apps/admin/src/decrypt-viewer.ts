import type { Decryptor, IdEnvelope } from '../../../packages/shared/src/idcrypt/index.js';

/** Best-effort save prevention, not DRM. Plaintext and object URLs are never persisted. */
export class DecryptViewer {
  private url: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private readonly activity = () => this.touch();
  private readonly hidden = () => { if (document.hidden) this.close(); };
  private readonly stopSave = (e: Event) => e.preventDefault();
  constructor(private readonly image: HTMLImageElement, private readonly decryptor: Decryptor, private readonly idleMs = 30_000) {
    image.draggable = false;
    image.addEventListener('contextmenu', this.stopSave);
    image.addEventListener('dragstart', this.stopSave);
    for (const event of ['pointerdown', 'pointermove', 'keydown']) document.addEventListener(event, this.activity);
    document.addEventListener('visibilitychange', this.hidden);
    window.addEventListener('pagehide', this.activityClose);
  }
  private readonly activityClose = () => this.close();
  async show(input: { envelope: IdEnvelope; uploadId: string; accountId: string }): Promise<void> {
    this.close();
    const generation = this.generation;
    this.touch(); // Covers an in-flight local tool, too.
    const bytes = await this.decryptor.decrypt(input);
    try {
      if (generation !== this.generation) return;
      this.url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
      this.image.src = this.url;
      this.image.hidden = false;
      this.touch();
    } finally { bytes.fill(0); }
  }
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), this.idleMs);
  }
  close(): void {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.image.removeAttribute('src');
    this.image.hidden = true;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
  dispose(): void {
    this.close();
    for (const event of ['pointerdown', 'pointermove', 'keydown']) document.removeEventListener(event, this.activity);
    document.removeEventListener('visibilitychange', this.hidden);
    window.removeEventListener('pagehide', this.activityClose);
    this.image.removeEventListener('contextmenu', this.stopSave);
    this.image.removeEventListener('dragstart', this.stopSave);
  }
}
