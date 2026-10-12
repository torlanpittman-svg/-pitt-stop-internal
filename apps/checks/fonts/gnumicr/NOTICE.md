# GnuMICR 0.30 — E-13B MICR font (third-party, GPL v2)

- Author: Eric Sandeen. Copyright (c) 2000-2003. License: GNU GPL v2 or later (see `COPYING`).
- Source: https://github.com/alerque/gnumicr tag `v0.30` (mirror of sandeen.net/GnuMICR),
  tarball sha256 `e087b0a85d1e5aa1ed4b11ae8f5716ec74e48ab4ca1b10b7fbba0dff6784b39b`.
- Files are UNMODIFIED. `GnuMICR.raw` is the font's source; `GnuMICR.pfb` is the compiled Type 1 font
  that `apps/checks/micr-font.ts` reads from disk at print time and embeds in the check PDF.
- Kept as separate files with license + source intact (not compiled into application code), per the
  GPL and the author's stated wishes in `README`. Pitt Stop OS is internal and is not distributed.
- Use the Type 1 font at exactly 12 pt (author's design size). The package's TTF/OTF conversions are
  deliberately not included — the author does not vouch for them.
- The author states the font has not been bank-tested. Dimensional checks live in
  `apps/checks/micr-font.test.ts`; physical/bank validation is tracked in `docs/CHECK_PRINTING_STATUS.md`.
