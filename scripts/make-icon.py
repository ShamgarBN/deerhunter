#!/usr/bin/env python3
"""Shape a square source image into a macOS app icon.

Why this exists rather than a one-line call to a tool: there is no ImageMagick, Pillow or
sharp on this machine, and sips cannot mask. PNG decode and encode is zlib plus a few
dozen lines, so it is done here instead of adding a dependency to a project that has five.

Two things make an icon look native on macOS, and neither is "rounded corners":

  1. The shape is a SUPERELLIPSE, not a rounded rectangle. A rounded rect joins a straight
     edge to a circular arc, and the curvature jumps at the join. Apple's shape has
     continuously varying curvature, which is why a plain rounded rect looks subtly wrong
     next to real icons even at the same corner radius.

  2. The artwork does not fill the canvas. On a 1024 grid the icon body is 824 square,
     centred, leaving 100px of padding that the system expects to be empty. Art drawn to
     the edges reads as oversized in the Dock next to everything else.

Usage: python3 scripts/make-icon.py <source.png> <out.png>
"""

import struct
import sys
import zlib

CANVAS = 1024
BODY = 824           # Apple's icon-body size on a 1024 grid
PAD = (CANVAS - BODY) // 2
N = 5.0              # superellipse exponent; ~5 matches the macOS squircle closely
SS = 4               # supersampling factor for the mask edge

# Scale the artwork past the body size and centre-crop it.
#
# Source art usually carries its own rounded corners on a white or transparent field. Cut
# that with a squircle of a different radius and a pale crescent survives in each corner,
# which reads as a halo at Dock size. Overfilling pushes the source's own corners outside
# the mask entirely, so the only curve left is this one.
OVERFILL = 1.12

SHADOW_OFFSET = 8
SHADOW_ALPHA = 0.22
SHADOW_BLUR = 12


def read_png(path):
    """Decode a non-interlaced 8-bit PNG into (w, h, rgba bytearray)."""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'{path} is not a PNG')
    pos, idat, w, h, depth, color = 8, b'', 0, 0, 0, 0
    while pos < len(data):
        (length,) = struct.unpack('>I', data[pos:pos + 4])
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if ctype == b'IHDR':
            w, h, depth, color, _, _, interlace = struct.unpack('>IIBBBBB', chunk)
            if depth != 8 or interlace:
                raise SystemExit('only 8-bit non-interlaced PNGs are handled')
            if color not in (2, 6):
                raise SystemExit('only RGB and RGBA PNGs are handled')
        elif ctype == b'IDAT':
            idat += chunk
        elif ctype == b'IEND':
            break
        pos += 12 + length

    raw = zlib.decompress(idat)
    ch = 3 if color == 2 else 4
    stride = w * ch
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        # Undo the per-scanline filter. This is the whole of PNG decoding that matters.
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                left = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 255
        elif f != 0:
            raise SystemExit(f'unknown PNG filter {f}')
        prev = line
        for x in range(w):
            s = x * ch
            d = (y * w + x) * 4
            out[d] = line[s]
            out[d + 1] = line[s + 1]
            out[d + 2] = line[s + 2]
            out[d + 3] = line[s + 3] if ch == 4 else 255
    return w, h, out


def write_png(path, w, h, rgba):
    rows = bytearray()
    for y in range(h):
        rows.append(0)                                   # filter 0; the data is tiny
        rows += rgba[y * w * 4:(y + 1) * w * 4]
    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xFFFFFFFF))
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(rows), 9))
           + chunk(b'IEND', b''))
    open(path, 'wb').write(png)


def resize(w, h, rgba, size):
    """Box-average downscale. The source is larger than the target, so averaging the
    covered block is both correct and cheap; bilinear would alias on the antlers."""
    out = bytearray(size * size * 4)
    for y in range(size):
        y0, y1 = y * h // size, max(y * h // size + 1, (y + 1) * h // size)
        for x in range(size):
            x0, x1 = x * w // size, max(x * w // size + 1, (x + 1) * w // size)
            r = g = b = a = n = 0
            for sy in range(y0, y1):
                base = sy * w
                for sx in range(x0, x1):
                    i = (base + sx) * 4
                    r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]
                    n += 1
            d = (y * size + x) * 4
            out[d] = r // n; out[d + 1] = g // n; out[d + 2] = b // n; out[d + 3] = a // n
    return out


def crop_centre(rgba, size, out_size):
    off = (size - out_size) // 2
    out = bytearray(out_size * out_size * 4)
    for y in range(out_size):
        src = ((y + off) * size + off) * 4
        out[y * out_size * 4:(y + 1) * out_size * 4] = rgba[src:src + out_size * 4]
    return out


def squircle_mask(size, n=N, ss=SS):
    """Coverage mask for |x|^n + |y|^n = 1, antialiased by supersampling.

    Coverage rather than a hard in/out test: a binary mask on a curve this shallow shows
    visible stair-stepping at the corners at Dock size.
    """
    mask = bytearray(size * size)
    half = size / 2.0
    inv = 1.0 / half
    step = 1.0 / ss
    off = step / 2.0
    for y in range(size):
        for x in range(size):
            hits = 0
            for sy in range(ss):
                fy = abs((y + off + sy * step) - half) * inv
                if fy >= 1.0:
                    continue
                yn = fy ** n
                if yn >= 1.0:
                    continue
                for sx in range(ss):
                    fx = abs((x + off + sx * step) - half) * inv
                    if fx < 1.0 and fx ** n + yn <= 1.0:
                        hits += 1
            mask[y * size + x] = (hits * 255) // (ss * ss)
    return mask


def box_blur(mask, size, radius, passes=3):
    """Three box passes approximate a gaussian closely enough for a drop shadow."""
    buf = bytearray(mask)
    tmp = bytearray(len(mask))
    for _ in range(passes):
        for y in range(size):                     # horizontal
            row = y * size
            for x in range(size):
                lo, hi = max(0, x - radius), min(size - 1, x + radius)
                tmp[row + x] = sum(buf[row + i] for i in range(lo, hi + 1)) // (hi - lo + 1)
        for x in range(size):                     # vertical
            for y in range(size):
                lo, hi = max(0, y - radius), min(size - 1, y + radius)
                buf[y * size + x] = sum(tmp[i * size + x] for i in range(lo, hi + 1)) // (hi - lo + 1)
    return buf


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]

    w, h, rgba = read_png(src)
    if w != h:
        print(f'  note: source is {w}x{h}, not square; it will be squashed to fit')
    grown = int(BODY * OVERFILL)
    art = crop_centre(resize(w, h, rgba, grown), grown, BODY)
    mask = squircle_mask(BODY)

    canvas = bytearray(CANVAS * CANVAS * 4)       # transparent

    # Shadow first, so the body sits on top of it.
    shadow = box_blur(mask, BODY, SHADOW_BLUR)
    for y in range(BODY):
        cy = y + PAD + SHADOW_OFFSET
        if not (0 <= cy < CANVAS):
            continue
        for x in range(BODY):
            a = shadow[y * BODY + x]
            if not a:
                continue
            d = (cy * CANVAS + x + PAD) * 4
            canvas[d + 3] = int(a * SHADOW_ALPHA)   # black, so only alpha is set

    # Body, composited over the shadow.
    for y in range(BODY):
        for x in range(BODY):
            m = mask[y * BODY + x]
            if not m:
                continue
            s = (y * BODY + x) * 4
            d = ((y + PAD) * CANVAS + x + PAD) * 4
            sa = m * art[s + 3] // 255
            da = canvas[d + 3]
            out_a = sa + da * (255 - sa) // 255
            if out_a:
                for c in range(3):
                    # Shadow colour is black, so its contribution to RGB is zero.
                    canvas[d + c] = (art[s + c] * sa) // out_a
            canvas[d + 3] = out_a

    write_png(dst, CANVAS, CANVAS, canvas)
    print(f'  wrote {dst}: {CANVAS}x{CANVAS}, body {BODY}px superellipse n={N}, {PAD}px padding')


if __name__ == '__main__':
    main()
