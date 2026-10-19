//! Python-compatible string and path behaviour.
//!
//! The parity oracle is Python (`pathlib`, `os`, `str`), so every place where
//! Rust's defaults differ — sort order of a non-UTF-8 name, `PurePath.suffix`,
//! `repr()` of a path inside `str(OSError)`, the JSON form of a lone surrogate —
//! is reproduced here rather than at the call sites.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
pub fn os_bytes(s: &OsStr) -> Cow<'_, [u8]> {
    use std::os::unix::ffi::OsStrExt;
    Cow::Borrowed(s.as_bytes())
}
#[cfg(not(unix))]
pub fn os_bytes(s: &OsStr) -> Cow<'_, [u8]> {
    match s.to_string_lossy() {
        Cow::Borrowed(b) => Cow::Borrowed(b.as_bytes()),
        Cow::Owned(o) => Cow::Owned(o.into_bytes()),
    }
}

#[cfg(unix)]
pub fn os_from_bytes(b: Vec<u8>) -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(b)
}
#[cfg(not(unix))]
pub fn os_from_bytes(b: Vec<u8>) -> OsString {
    OsString::from(String::from_utf8_lossy(&b).into_owned())
}

/// The code points `os.fsdecode` gives: valid UTF-8 as itself, every other byte
/// as the lone surrogate U+DC00+byte (surrogateescape).
fn py_chars(b: &[u8]) -> impl Iterator<Item = u32> + '_ {
    b.utf8_chunks().flat_map(|c| {
        c.valid().chars().map(|ch| ch as u32).chain(c.invalid().iter().map(|&x| 0xDC00 + x as u32))
    })
}

/// Python's `str` ordering of two names (code point order of the fsdecoded form).
pub fn py_cmp(a: &OsStr, b: &OsStr) -> Ordering {
    if let (Some(x), Some(y)) = (a.to_str(), b.to_str()) {
        return x.as_bytes().cmp(y.as_bytes()); // UTF-8 byte order IS code point order
    }
    py_chars(&os_bytes(a)).cmp(py_chars(&os_bytes(b)))
}

/// `sorted()` of `pathlib` paths: compared part by part, not as one string.
pub fn py_cmp_paths(a: &Path, b: &Path) -> Ordering {
    let (mut ia, mut ib) = (a.components(), b.components());
    loop {
        match (ia.next(), ib.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => match py_cmp(x.as_os_str(), y.as_os_str()) {
                Ordering::Equal => {}
                o => return o,
            },
        }
    }
}

/// A name as text for pattern matching. A byte that is not UTF-8 becomes ONE
/// private-use character, as it is one (surrogate) character in Python.
pub fn match_text(name: &OsStr) -> Cow<'_, str> {
    if let Some(s) = name.to_str() {
        return Cow::Borrowed(s);
    }
    let b = os_bytes(name);
    let mut out = String::with_capacity(b.len());
    for c in b.utf8_chunks() {
        out.push_str(c.valid());
        for &x in c.invalid() {
            out.push(char::from_u32(0xF700 + x as u32).unwrap());
        }
    }
    Cow::Owned(out)
}

/// `str.lower()` of a name.
pub fn lower(name: &OsStr) -> String {
    name.to_string_lossy().to_lowercase()
}

/// `name.lower() == target` where `target` is already lowercase.
pub fn lower_eq(name: &OsStr, target_lower: &str) -> bool {
    let b = os_bytes(name);
    if b.is_ascii() {
        return b.eq_ignore_ascii_case(target_lower.as_bytes());
    }
    lower(name) == target_lower
}

/// `PurePath.suffix` (3.11): `name[i:]` for the last `.` when `0 < i < len-1`, else empty.
pub fn py_suffix(name: &[u8]) -> &[u8] {
    match name.iter().rposition(|&c| c == b'.') {
        Some(i) if i > 0 && i < name.len() - 1 => &name[i..],
        _ => b"",
    }
}

/// `str(PurePosixPath(raw))`: duplicate slashes and `.` segments collapse, a
/// trailing slash goes, exactly two leading slashes are kept.
pub fn py_norm_path(raw: &OsStr) -> PathBuf {
    let b = os_bytes(raw);
    let lead = if b.starts_with(b"//") && !b.starts_with(b"///") {
        "//"
    } else if b.starts_with(b"/") {
        "/"
    } else {
        ""
    };
    let mut out: Vec<u8> = lead.as_bytes().to_vec();
    let mut first = true;
    for seg in b.split(|&c| c == b'/') {
        if seg.is_empty() || seg == b"." {
            continue;
        }
        if !first {
            out.push(b'/');
        }
        out.extend_from_slice(seg);
        first = false;
    }
    if out.is_empty() {
        out.push(b'.');
    }
    PathBuf::from(os_from_bytes(out))
}

/// `Path.parts` as lowercase strings (the anchor `/` is a part, as in Python).
pub fn parts_lower(p: &Path) -> Vec<String> {
    p.components()
        .filter_map(|c| match c {
            Component::CurDir => None,
            other => Some(lower(other.as_os_str())),
        })
        .collect()
}

pub fn is_appledouble(name: &OsStr) -> bool {
    os_bytes(name).starts_with(b"._")
}

fn py_unprintable(c: char) -> bool {
    let u = c as u32;
    u < 0x20
        || (0x7f..=0xa0).contains(&u)
        || u == 0xad
        || u == 0x1680
        || (0x2000..=0x200f).contains(&u)
        || (0x2028..=0x202f).contains(&u)
        || (0x205f..=0x206f).contains(&u)
        || u == 0x3000
        || u == 0xfeff
        || (0xe000..=0xf8ff).contains(&u)
}

/// `repr()` of a path string, as it appears inside `str(OSError)`.
pub fn py_repr(path: &OsStr) -> String {
    let b = os_bytes(path);
    let quote = if b.contains(&b'\'') && !b.contains(&b'"') { '"' } else { '\'' };
    let mut out = String::with_capacity(b.len() + 2);
    out.push(quote);
    for chunk in b.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if c == quote => {
                    out.push('\\');
                    out.push(c);
                }
                c if py_unprintable(c) => {
                    let u = c as u32;
                    if u < 0x100 {
                        out.push_str(&format!("\\x{u:02x}"));
                    } else if u < 0x10000 {
                        out.push_str(&format!("\\u{u:04x}"));
                    } else {
                        out.push_str(&format!("\\U{u:08x}"));
                    }
                }
                c => out.push(c),
            }
        }
        for &x in chunk.invalid() {
            out.push_str(&format!("\\udc{x:02x}"));
        }
    }
    out.push(quote);
    out
}

/// One JSON string. A byte that is not UTF-8 is written as the `\udcXX` escape
/// Python's `json.loads` turns back into the surrogate `os.fsencode` expects —
/// the one place `serde_json`'s string writer is not used (diskio.md §0 Encoding).
pub fn write_json_bytes(out: &mut Vec<u8>, b: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    for chunk in b.utf8_chunks() {
        for ch in chunk.valid().chars() {
            match ch {
                '"' => out.extend_from_slice(b"\\\""),
                '\\' => out.extend_from_slice(b"\\\\"),
                '\n' => out.extend_from_slice(b"\\n"),
                '\r' => out.extend_from_slice(b"\\r"),
                '\t' => out.extend_from_slice(b"\\t"),
                // Control characters, and the three line separators above ASCII:
                // a reader that splits the stream with `str.splitlines()` must
                // still see one value per line.
                c if (c as u32) < 0x20 || matches!(c, '\u{85}' | '\u{2028}' | '\u{2029}') => {
                    let u = c as u32;
                    out.extend_from_slice(b"\\u");
                    for shift in [12, 8, 4, 0] {
                        out.push(HEX[((u >> shift) & 15) as usize]);
                    }
                }
                c => {
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                }
            }
        }
        for &x in chunk.invalid() {
            out.extend_from_slice(b"\\udc");
            out.push(HEX[(x >> 4) as usize]);
            out.push(HEX[(x & 15) as usize]);
        }
    }
    out.push(b'"');
}

pub fn write_json_os(out: &mut Vec<u8>, s: &OsStr) {
    write_json_bytes(out, &os_bytes(s));
}

/// Marks a `\udcXX` escape of the REQUEST so `serde_json` (which refuses a lone
/// surrogate) can parse it; `request_os_string` turns the marker back into the byte.
const LONE_MARK: char = '\u{fdd0}';

/// Rewrite every lone `\udc80`..`\udcff` escape of a JSON document to `LONE_MARK` + two hex digits.
pub fn protect_lone_surrogates(raw: &str) -> Cow<'_, str> {
    if !raw.contains("\\ud") && !raw.contains("\\uD") {
        return Cow::Borrowed(raw);
    }
    let b = raw.as_bytes();
    let hex4 = |i: usize| -> Option<u32> {
        let h = b.get(i..i + 4)?;
        u32::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok()
    };
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' || i + 1 >= b.len() {
            out.push(b[i]);
            i += 1;
            continue;
        }
        if b[i + 1] != b'u' {
            out.extend_from_slice(&b[i..i + 2]); // any other escape, `\\` included
            i += 2;
            continue;
        }
        match hex4(i + 2) {
            Some(hi) if (0xD800..0xDC00).contains(&hi) => {
                // a real pair stays as written
                let paired = b.get(i + 6..i + 8) == Some(b"\\u".as_slice())
                    && hex4(i + 8).is_some_and(|lo| (0xDC00..0xE000).contains(&lo));
                let n = if paired { 12 } else { 6 };
                out.extend_from_slice(&b[i..i + n]);
                i += n;
            }
            Some(v) if (0xDC80..=0xDCFF).contains(&v) => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(LONE_MARK.encode_utf8(&mut buf).as_bytes());
                out.extend_from_slice(format!("{:02x}", v - 0xDC00).as_bytes());
                i += 6;
            }
            Some(_) => {
                out.extend_from_slice(&b[i..i + 6]);
                i += 6;
            }
            None => {
                out.extend_from_slice(&b[i..i + 2]);
                i += 2;
            }
        }
    }
    Cow::Owned(String::from_utf8(out).expect("only ASCII escapes were rewritten"))
}

/// A request string back to the OS form: `LONE_MARK` + two hex digits is one raw byte.
pub fn request_os_string(s: &str) -> OsString {
    if !s.contains(LONE_MARK) {
        return OsString::from(s);
    }
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let after = i + c.len_utf8();
        let byte = (c == LONE_MARK)
            .then(|| s.get(after..after + 2))
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match byte {
            Some(x) => {
                out.push(x);
                it.next();
                it.next();
            }
            None => out.extend_from_slice(c.to_string().as_bytes()),
        }
    }
    os_from_bytes(out)
}

/// The errno NAME (`errno.errorcode`) — what `ItemError.detail` carries for `unreadable`;
/// `OSError` for one this table does not name.
pub fn errno_name(e: &io::Error) -> String {
    #[cfg(unix)]
    if let Some(n) = e.raw_os_error() {
        let known: &[(i32, &str)] = &[
            (libc::EPERM, "EPERM"),
            (libc::ENOENT, "ENOENT"),
            (libc::EIO, "EIO"),
            (libc::EBADF, "EBADF"),
            (libc::ENOMEM, "ENOMEM"),
            (libc::EACCES, "EACCES"),
            (libc::EBUSY, "EBUSY"),
            (libc::ENOTDIR, "ENOTDIR"),
            (libc::EINVAL, "EINVAL"),
            (libc::ENFILE, "ENFILE"),
            (libc::EMFILE, "EMFILE"),
            (libc::ENAMETOOLONG, "ENAMETOOLONG"),
            (libc::ELOOP, "ELOOP"),
            (libc::ESTALE, "ESTALE"),
            (libc::ETIMEDOUT, "ETIMEDOUT"),
            (libc::EINTR, "EINTR"),
            (libc::ENXIO, "ENXIO"),
            (libc::EILSEQ, "EILSEQ"),
            (libc::EAGAIN, "EAGAIN"),
            (libc::EEXIST, "EEXIST"),
            (libc::EISDIR, "EISDIR"),
            (libc::ENODEV, "ENODEV"),
            (libc::ENOSPC, "ENOSPC"),
            (libc::EROFS, "EROFS"),
            (libc::EOVERFLOW, "EOVERFLOW"),
            (libc::ENOTSUP, "ENOTSUP"),
            (libc::ECONNREFUSED, "ECONNREFUSED"),
            (libc::EHOSTDOWN, "EHOSTDOWN"),
            (libc::EHOSTUNREACH, "EHOSTUNREACH"),
            (libc::ENETDOWN, "ENETDOWN"),
            (libc::ENOTCONN, "ENOTCONN"),
        ];
        return match known.iter().find(|(c, _)| *c == n) {
            Some((_, name)) => (*name).to_string(),
            None => "OSError".to_string(), // Python: the exception's class name
        };
    }
    match e.kind() {
        io::ErrorKind::PermissionDenied => "EACCES".to_string(),
        io::ErrorKind::NotFound => "ENOENT".to_string(),
        _ => "OSError".to_string(),
    }
}

/// `str(OSError)` for a failed stat of `path`: `[Errno <n>] <strerror>: '<path>'`
/// (`[WinError <n>] <text>: '<path>'` on Windows) — a `ScanProblem.message` template.
pub fn py_oserror_str(e: &io::Error, path: &Path) -> String {
    let n = e.raw_os_error().unwrap_or(0);
    let full = e.to_string();
    let text = full.rsplit_once(" (os error").map_or(full.as_str(), |(t, _)| t);
    let label = if cfg!(windows) { "WinError" } else { "Errno" };
    format!("[{label} {n}] {text}: {}", py_repr(path.as_os_str()))
}

/// The four errnos `pathlib` (3.11) reads as "not there" instead of raising.
pub fn py_ignored_error(e: &io::Error) -> bool {
    #[cfg(unix)]
    if let Some(n) = e.raw_os_error() {
        return n == libc::ENOENT || n == libc::ENOTDIR || n == libc::EBADF || n == libc::ELOOP;
    }
    e.kind() == io::ErrorKind::NotFound
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_follows_pathlib() {
        assert_eq!(py_suffix(b"a.md"), b".md");
        assert_eq!(py_suffix(b".md"), b"");
        assert_eq!(py_suffix(b"p2."), b"");
        assert_eq!(py_suffix(b"w3.js.txt"), b".txt");
        assert_eq!(py_suffix(b"noext"), b"");
    }

    #[test]
    fn norm_path_follows_purepath() {
        let n = |s: &str| py_norm_path(OsStr::new(s)).to_string_lossy().into_owned();
        assert_eq!(n("/a//b/./c/"), "/a/b/c");
        assert_eq!(n("//a/b"), "//a/b");
        assert_eq!(n("///a"), "/a");
        assert_eq!(n("a/b/"), "a/b");
        assert_eq!(n(""), ".");
        assert_eq!(n("/"), "/");
    }

    #[test]
    fn repr_picks_the_quote_python_picks() {
        assert_eq!(py_repr(OsStr::new("/a/b")), "'/a/b'");
        assert_eq!(py_repr(OsStr::new("/a'b")), "\"/a'b\"");
        assert_eq!(py_repr(OsStr::new("/a'\"b")), "'/a\\'\"b'");
        assert_eq!(py_repr(OsStr::new("/a\nb\\c")), "'/a\\nb\\\\c'");
    }

    #[test]
    fn a_non_utf8_byte_is_written_as_a_surrogate_escape() {
        let mut out = Vec::new();
        write_json_bytes(&mut out, b"caf\xe9 \"q\" \\ \x01 \xc3\xa9");
        assert_eq!(out, b"\"caf\\udce9 \\\"q\\\" \\\\ \\u0001 \xc3\xa9\"".to_vec());
        let mut out = Vec::new();
        write_json_bytes(&mut out, "a\u{2028}b\u{85}c".as_bytes());
        assert_eq!(out, b"\"a\\u2028b\\u0085c\"".to_vec());
    }

    #[cfg(unix)]
    #[test]
    fn a_surrogate_escape_in_the_request_round_trips_to_the_byte() {
        let raw = r#"{"path":"/t/caf\udce9/x","pair":"😀","lit":"\\udce9"}"#;
        let v: serde_json::Value = serde_json::from_str(&protect_lone_surrogates(raw)).unwrap();
        assert_eq!(os_bytes(&request_os_string(v["path"].as_str().unwrap())).as_ref(), b"/t/caf\xe9/x");
        assert_eq!(v["pair"].as_str().unwrap(), "\u{1f600}");
        assert_eq!(v["lit"].as_str().unwrap(), "\\udce9");
    }

    #[cfg(unix)]
    #[test]
    fn names_sort_in_python_code_point_order() {
        // b"\xff" decodes to U+DCFF, which sorts BEFORE U+FFFD (EF BF BD) in Python
        // although the byte 0xFF sorts after 0xEF.
        let a = os_from_bytes(vec![0xff]);
        let b = OsString::from("\u{fffd}");
        assert_eq!(py_cmp(&a, &b), Ordering::Less);
        assert_eq!(py_cmp(OsStr::new("B"), OsStr::new("a")), Ordering::Less);
    }
}
