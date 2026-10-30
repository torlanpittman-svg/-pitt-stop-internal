# Sticker assets

- `pitt-stop-logo-color.jpg` — the ORIGINAL color logo (red/yellow script + white subtitle on
  blue). Preserved untouched; the source for the print conversion.
- `pitt-stop-logo-print.png` — black-on-white print master (1600×566, grayscale) used on the
  oil-change sticker: solid black script, "Detail & Auto Sales" as outlined white lettering,
  matching the owner-approved mockup (`docs/assets/oil-sticker-approved-mockup.png`).
- `make-print-logo.py` — the conversion (background removal + per-region classification +
  adaptive threshold for the tiny subtitle + despeckle). Rerun only if the source logo changes:
  `python3 make-print-logo.py pitt-stop-logo-color.jpg pitt-stop-logo-print.png` (needs Pillow).

`../logo-data.ts` is GENERATED from the print master (zlib-deflated raw grayscale, base64) and is
what the PDF embeds. Regenerate after any master change:

```bash
python3 - <<'EOF'
from PIL import Image
import zlib, base64
im = Image.open('apps/stickers/assets/pitt-stop-logo-print.png').convert('L')
comp = base64.b64encode(zlib.compress(im.tobytes(), 9)).decode()
lines = [comp[i:i+120] for i in range(0, len(comp), 120)]
open('apps/stickers/logo-data.ts', 'w').write(
    "/**\n * GENERATED — do not edit by hand. See apps/stickers/assets/README.md.\n */\n"
    f"export const LOGO_WIDTH_PX = {im.width}\n"
    f"export const LOGO_HEIGHT_PX = {im.height}\n"
    "export const LOGO_GRAY_DEFLATED_BASE64 = [\n  '" + "',\n  '".join(lines) + "',\n].join('')\n")
EOF
```

Also update `public/stickers/pitt-stop-logo-print.png` (the in-app preview copy) and the
`LOGO_ASPECT_W/H` constants in `../render.ts` if the dimensions change (pdf.test.ts enforces
they stay in sync).
