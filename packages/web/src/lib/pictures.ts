/**
 * A photo from the office computer or phone, made small enough to store and
 * email: at most 2400 pixels on its longest side, as a JPEG (a PNG with
 * transparency stays a PNG). A 6 MB phone photo comes out at well under the
 * server's 3 MB (News & offers pictures, 7 Oct 2026).
 *
 * Sharper since 15 Oct 2026 (Everton: pictures came out at a lower quality):
 * a picture that is already small enough is kept exactly as it is, not
 * recompressed; a big one is scaled down in halves with high-quality
 * smoothing and saved at 92% rather than 82%.
 */
const KEEP_AS_IS_BYTES = 2_200_000;
export async function shrinkPicture(file: File, maxSide = 2400): Promise<string> {
  if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type)) {
    throw new Error(`${file.name} is not a picture this can use. Choose a JPEG or PNG photo.`);
  }
  // A GIF is kept as it is (it may move); everything else is redrawn.
  if (/gif$/i.test(file.type)) return readAsDataUrl(file);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error(`${file.name} could not be opened as a picture.`));
      i.src = url;
    });
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest <= maxSide && file.size <= KEEP_AS_IS_BYTES) return readAsDataUrl(file);
    const scale = Math.min(1, maxSide / longest);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const png = /png$/i.test(file.type);
    // Halve in steps until close, then the last step to size: one big jump
    // down throws away detail and looks soft.
    let src: HTMLImageElement | HTMLCanvasElement = img;
    let sw = img.naturalWidth; let sh = img.naturalHeight;
    while (sw / 2 >= w && sh / 2 >= h) {
      const step = document.createElement('canvas');
      step.width = Math.round(sw / 2); step.height = Math.round(sh / 2);
      const sc = step.getContext('2d');
      if (!sc) break;
      sc.imageSmoothingEnabled = true; sc.imageSmoothingQuality = 'high';
      sc.drawImage(src, 0, 0, step.width, step.height);
      src = step; sw = step.width; sh = step.height;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return readAsDataUrl(file);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(src, 0, 0, w, h);
    const out = canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92);
    // A big PNG photo can come out larger than the server takes: as a JPEG then.
    return png && out.length > 3_900_000 ? canvas.toDataURL('image/jpeg', 0.9) : out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`${file.name} could not be read.`));
    r.readAsDataURL(file);
  });
}
