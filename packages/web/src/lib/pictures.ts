/**
 * A photo from the office computer or phone, made small enough to store and
 * email: at most 1600 pixels on its longest side, as a JPEG (a PNG with
 * transparency stays a PNG). A 6 MB phone photo comes out at a few hundred
 * KB, which is what the server expects (News & offers pictures, 7 Oct 2026).
 */
export async function shrinkPicture(file: File, maxSide = 1600): Promise<string> {
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
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return readAsDataUrl(file);
    const png = /png$/i.test(file.type);
    if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.82);
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
