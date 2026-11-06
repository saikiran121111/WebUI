//! True pixel dimensions of encoded screenshots (PNG IHDR / JPEG SOF).
//!
//! The screenshot contract's `image_width`/`image_height` must describe
//! the pixels the receiving vision model actually sees, never a rect
//! computation. Predicting from the clip rect (`width × scale`, rounded)
//! drifts whenever Chromium rasterizes a fractional rect: a 138.625 px
//! box encodes 138 real pixels while `round()` claims 139 — caught live
//! by the two-session scoping journey's `assert_dims_honest` check.
//! So the dimensions come from the encoded bytes instead.
//!
//! There is deliberately no image or base64 crate in this workspace (see
//! the `content_api` notes), so decoding is lazy and bounded: a PNG's
//! dimensions live entirely in the first 32 base64 characters, and a
//! JPEG needs only a bounded header prefix.

/// (width, height) parsed from a base64-encoded PNG or JPEG. `None`
/// when the payload is not a decodable image of a known format — the
/// caller then keeps its computed estimate rather than claiming bytes
/// it never verified.
pub fn dims_from_b64(data: &str) -> Option<(u32, u32)> {
    // PNG signature in base64 is fixed: "iVBORw0KGgo".
    if data.starts_with("iVBORw0KGgo") {
        let b = b64_prefix(data, 24);
        if b.len() >= 24 && b[12..16] == *b"IHDR" {
            return Some((be32(&b[16..20]), be32(&b[20..24])));
        }
        return None;
    }
    // JPEG signature in base64 is fixed: "/9j/".
    if !data.starts_with("/9j/") {
        return None;
    }
    let b = b64_prefix(data, JPEG_SCAN_LIMIT);
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    // Segment walk: SOF0..SOF15 (minus DHT 0xC4, DAC 0xC8, DNL 0xCC)
    // carries height then width. Standalone markers carry no length.
    let mut i = 2usize;
    while i + 9 <= b.len() {
        if b[i] != 0xFF {
            i += 1;
            continue;
        }
        let m = b[i + 1];
        if (0xD0..=0xD9).contains(&m) || m == 0x01 || m == 0xFF {
            i += 2;
            continue;
        }
        let len = ((b[i + 2] as usize) << 8) | b[i + 3] as usize;
        if (0xC0..=0xCF).contains(&m) && !matches!(m, 0xC4 | 0xC8 | 0xCC) {
            let h = ((b[i + 5] as u32) << 8) | b[i + 6] as u32;
            let w = ((b[i + 7] as u32) << 8) | b[i + 8] as u32;
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

const JPEG_SCAN_LIMIT: usize = 96 * 1024;

const fn b64_table() -> [i16; 256] {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut t = [-1i16; 256];
    let mut i = 0;
    while i < 64 {
        t[alphabet[i] as usize] = i as i16;
        i += 1;
    }
    t
}

const B64: [i16; 256] = b64_table();

/// Decodes at most `max_bytes` of a standard-alphabet base64 payload
/// (CDP's encoder never wraps or url-safe-encodes; any stray character
/// ends the prefix rather than being skipped, so a wrong-format guess
/// can never fabricate a header).
fn b64_prefix(data: &str, max_bytes: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in data.as_bytes() {
        let v = if c == b'=' { break } else { B64[c as usize] };
        if v < 0 {
            break;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            out.push((acc >> (bits - 8)) as u8);
            bits -= 8;
            if out.len() >= max_bytes {
                break;
            }
        }
    }
    out
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions_come_from_ihdr() {
        // Canonical 1x1 transparent PNG.
        assert_eq!(
            dims_from_b64(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
            ),
            Some((1, 1))
        );
        // 138x17 — the exact live header the two-session journey caught
        // (metadata claimed 139; the raster says 138).
        assert_eq!(
            dims_from_b64("iVBORw0KGgoAAAANSUhEUgAAAIoAAAAR"),
            Some((138, 17))
        );
    }

    #[test]
    fn jpeg_dimensions_come_from_sof() {
        let mut jpg: Vec<u8> = vec![0xFF, 0xD8, 0xFF];
        jpg.extend_from_slice(&[0xE0, 0x00, 0x04, b'J', b'F']); // stub APP0
        jpg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x08, 0x08]); // SOF0, len 8
        jpg.extend_from_slice(&[0x00, 0x11, 0x00, 0x2A]); // height 17, width 42
        let b64 = b64_encode(&jpg);
        assert_eq!(dims_from_b64(&b64), Some((42, 17)));
    }

    #[test]
    fn non_images_are_none() {
        assert_eq!(dims_from_b64(""), None);
        assert_eq!(dims_from_b64("not an image at all"), None);
    }

    /// Test-only encoder (production never needs one).
    fn b64_encode(bytes: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut s = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
            s.push(A[(n >> 18) as usize] as char);
            s.push(A[((n >> 12) & 63) as usize] as char);
            s.push(if chunk.len() > 1 {
                A[((n >> 6) & 63) as usize] as char
            } else {
                '='
            });
            s.push(if chunk.len() > 2 {
                A[(n & 63) as usize] as char
            } else {
                '='
            });
        }
        s
    }
}
