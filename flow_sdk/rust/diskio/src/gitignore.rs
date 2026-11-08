//! One ignore file (`.gitignore` or `.flowignore`), matched the way git matches
//! it — the same port as `flow_sdk/fs_store/ignore_rules.py`, line for line.
//!
//! git's `wildmatch.c` (`dowild`) and the pattern rules of `dir.c`
//! (`add_patterns_from_buffer`, `trim_trailing_spaces`, `parse_path_pattern`,
//! `match_basename`, `match_pathname`, `last_matching_pattern_from_list`).
//! Matching is on bytes and case-sensitive (git with `core.ignorecase=false`).
//! The oracle is git itself: `tests/unit/diskio/test_ignore_files.py`.

use std::fs;
use std::path::Path;

pub const GITIGNORE: &str = ".gitignore";
pub const FLOWIGNORE: &str = ".flowignore";

const MATCH: i32 = 0;
const NOMATCH: i32 = 1;
const ABORT_ALL: i32 = -1;
const ABORT_TO_STARSTAR: i32 = -2;

const NEGATIVE: u8 = 1;
const MUSTBEDIR: u8 = 2;
const NODIR: u8 = 4;
const ENDSWITH: u8 = 8;

fn glob_special(c: u8) -> bool {
    matches!(c, b'*' | b'?' | b'[' | b'\\')
}

/// The `[:class:]` names wildmatch knows, over git's ASCII-only ctype (its
/// `isspace` has no `\v` or `\f`). `None` for a name it does not know.
fn class_matches(name: &[u8], c: u8) -> Option<bool> {
    Some(match name {
        b"alnum" => c.is_ascii_alphanumeric(),
        b"alpha" => c.is_ascii_alphabetic(),
        b"blank" => c == b' ' || c == b'\t',
        b"cntrl" => c < 32 || c == 127,
        b"digit" => c.is_ascii_digit(),
        b"graph" => (33..=126).contains(&c),
        b"lower" => c.is_ascii_lowercase(),
        b"print" => (32..=126).contains(&c),
        b"punct" => c.is_ascii_punctuation(),
        b"space" => matches!(c, b'\t' | b'\n' | b'\r' | b' '),
        b"upper" => c.is_ascii_uppercase(),
        b"xdigit" => c.is_ascii_hexdigit(),
        _ => return None,
    })
}

/// `wildmatch.c`'s `dowild`, index for pointer.
fn dowild(p: &[u8], mut pi: usize, t: &[u8], mut ti: usize, pathname: bool) -> i32 {
    let at = |s: &[u8], i: usize| s.get(i).copied().unwrap_or(0);
    while pi < p.len() {
        let mut p_ch = p[pi];
        let mut t_ch = at(t, ti);
        if ti >= t.len() && p_ch != b'*' {
            return ABORT_ALL;
        }
        match p_ch {
            b'\\' => {
                pi += 1;
                p_ch = at(p, pi);
                if t_ch != p_ch {
                    return NOMATCH;
                }
            }
            b'?' => {
                if pathname && t_ch == b'/' {
                    return NOMATCH;
                }
            }
            b'*' => {
                pi += 1;
                let match_slash;
                if at(p, pi) == b'*' {
                    let prev = pi.checked_sub(2);
                    while at(p, pi) == b'*' {
                        pi += 1;
                    }
                    let next = at(p, pi);
                    if prev.is_none_or(|i| p[i] == b'/')
                        && (next == 0 || next == b'/' || (next == b'\\' && at(p, pi + 1) == b'/'))
                    {
                        // "foo/**/bar" matches "foo/bar": try "**/" as nothing first.
                        if next == b'/' && dowild(p, pi + 1, t, ti, pathname) == MATCH {
                            return MATCH;
                        }
                        match_slash = true;
                    } else {
                        match_slash = false;
                    }
                } else {
                    match_slash = !pathname;
                }
                if pi >= p.len() {
                    // A trailing "**" matches everything; a trailing "*" only what has no more slashes.
                    if !match_slash && t[ti..].contains(&b'/') {
                        return NOMATCH;
                    }
                    return MATCH;
                }
                if !match_slash && p[pi] == b'/' {
                    // One star then a slash: the rest of this directory name, then that slash.
                    let Some(slash) = t[ti..].iter().position(|&c| c == b'/') else { return NOMATCH };
                    pi += 1;
                    ti += slash + 1;
                    continue;
                }
                loop {
                    if t_ch == 0 {
                        break;
                    }
                    if !glob_special(p[pi]) {
                        // A literal follows the star: skip straight to its next occurrence.
                        p_ch = p[pi];
                        t_ch = 0;
                        while ti < t.len() {
                            t_ch = t[ti];
                            if (!match_slash && t_ch == b'/') || t_ch == p_ch {
                                break;
                            }
                            ti += 1;
                            t_ch = 0;
                        }
                        if t_ch != p_ch {
                            return if match_slash { ABORT_ALL } else { ABORT_TO_STARSTAR };
                        }
                    }
                    let matched = dowild(p, pi, t, ti, pathname);
                    if matched != NOMATCH {
                        if !match_slash || matched != ABORT_TO_STARSTAR {
                            return matched;
                        }
                    } else if !match_slash && t_ch == b'/' {
                        return ABORT_TO_STARSTAR;
                    }
                    ti += 1;
                    t_ch = at(t, ti);
                }
                return ABORT_ALL;
            }
            b'[' => {
                pi += 1;
                p_ch = at(p, pi);
                if p_ch == b'^' {
                    p_ch = b'!';
                }
                let negated = p_ch == b'!';
                if negated {
                    pi += 1;
                    p_ch = at(p, pi);
                }
                let mut prev_ch = 0u8;
                let mut matched = false;
                loop {
                    if p_ch == 0 {
                        return ABORT_ALL;
                    }
                    if p_ch == b'\\' {
                        pi += 1;
                        p_ch = at(p, pi);
                        if p_ch == 0 {
                            return ABORT_ALL;
                        }
                        if t_ch == p_ch {
                            matched = true;
                        }
                    } else if p_ch == b'-' && prev_ch != 0 && pi + 1 < p.len() && p[pi + 1] != b']' {
                        pi += 1;
                        p_ch = p[pi];
                        if p_ch == b'\\' {
                            pi += 1;
                            p_ch = at(p, pi);
                            if p_ch == 0 {
                                return ABORT_ALL;
                            }
                        }
                        if prev_ch <= t_ch && t_ch <= p_ch {
                            matched = true;
                        }
                        p_ch = 0; // so the next prev_ch is 0: a range never starts a range
                    } else if p_ch == b'[' && at(p, pi + 1) == b':' {
                        pi += 2;
                        let start = pi;
                        while pi < p.len() && p[pi] != b']' {
                            pi += 1;
                        }
                        if pi >= p.len() {
                            return ABORT_ALL;
                        }
                        if pi < start + 1 || p[pi - 1] != b':' {
                            // No ":]": the "[" is an ordinary member of the set.
                            pi = start - 2;
                            p_ch = b'[';
                            if t_ch == p_ch {
                                matched = true;
                            }
                        } else {
                            match class_matches(&p[start..pi - 1], t_ch) {
                                None => return ABORT_ALL,
                                Some(true) => matched = true,
                                Some(false) => {}
                            }
                            p_ch = 0;
                        }
                    } else if t_ch == p_ch {
                        matched = true;
                    }
                    prev_ch = p_ch;
                    pi += 1;
                    p_ch = at(p, pi);
                    if p_ch == b']' {
                        break;
                    }
                }
                if matched == negated || (pathname && t_ch == b'/') {
                    return NOMATCH;
                }
            }
            _ => {
                if t_ch != p_ch {
                    return NOMATCH;
                }
            }
        }
        pi += 1;
        ti += 1;
    }
    if ti < t.len() { NOMATCH } else { MATCH }
}

/// git's `wildmatch(pattern, text, pathname ? WM_PATHNAME : 0) == WM_MATCH`.
pub fn wildmatch(pattern: &[u8], text: &[u8], pathname: bool) -> bool {
    dowild(pattern, 0, text, 0, pathname) == MATCH
}

fn simple_length(p: &[u8]) -> usize {
    p.iter().position(|&c| glob_special(c)).unwrap_or(p.len())
}

/// Drop trailing spaces unless the first of them is escaped (`\ `).
fn trim_trailing_spaces(line: &[u8]) -> &[u8] {
    let mut last_space: Option<usize> = None;
    let mut i = 0;
    while i < line.len() {
        match line[i] {
            b' ' => {
                if last_space.is_none() {
                    last_space = Some(i);
                }
            }
            b'\\' => {
                i += 1;
                if i >= line.len() {
                    return line;
                }
                last_space = None;
            }
            _ => last_space = None,
        }
        i += 1;
    }
    &line[..last_space.unwrap_or(line.len())]
}

struct Rule {
    pattern: Vec<u8>,
    flags: u8,
    prefix: usize,
}

impl Rule {
    fn new(mut line: &[u8]) -> Rule {
        let mut flags = 0;
        if line.first() == Some(&b'!') {
            flags |= NEGATIVE;
            line = &line[1..];
        }
        let mut len = line.len();
        if len > 0 && line[len - 1] == b'/' {
            len -= 1;
            flags |= MUSTBEDIR;
        }
        if !line[..len].contains(&b'/') {
            flags |= NODIR;
        }
        if line.first() == Some(&b'*') && simple_length(&line[1..]) == line.len() - 1 {
            flags |= ENDSWITH;
        }
        Rule { pattern: line[..len].to_vec(), flags, prefix: simple_length(line).min(len) }
    }

    fn matches(&self, rel: &[u8], basename: &[u8]) -> bool {
        let (mut pattern, mut prefix) = (self.pattern.as_slice(), self.prefix);
        if self.flags & NODIR != 0 {
            // match_basename
            if prefix == pattern.len() {
                return pattern == basename;
            }
            if self.flags & ENDSWITH != 0 {
                return pattern.len() - 1 <= basename.len() && basename.ends_with(&pattern[1..]);
            }
            return wildmatch(pattern, basename, false);
        }
        // match_pathname, relative to the file's own folder. The literal prefix is only a
        // shortcut: the whole pattern is matched, so a "**" right after it ("ab**/c") stays
        // an ordinary star, as git has it.
        if pattern.first() == Some(&b'/') {
            pattern = &pattern[1..];
            prefix = prefix.saturating_sub(1);
        }
        if rel.is_empty() || (prefix > 0 && rel.get(..prefix) != Some(&pattern[..prefix])) {
            return false;
        }
        wildmatch(pattern, rel, true)
    }
}

/// The rules of one ignore file, in file order.
pub struct IgnoreFile {
    rules: Vec<Rule>,
}

impl IgnoreFile {
    /// `add_patterns_from_buffer`: a BOM dropped, blank and `#` lines skipped, one
    /// `\r` and the unescaped trailing spaces cut from each line.
    pub fn parse(mut data: &[u8]) -> IgnoreFile {
        if data.starts_with(b"\xef\xbb\xbf") {
            data = &data[3..];
        }
        let mut lines: Vec<&[u8]> = data.split(|&c| c == b'\n').collect();
        if lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        let mut rules = Vec::new();
        for mut line in lines {
            if line.is_empty() || line[0] == b'#' {
                continue;
            }
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            rules.push(Rule::new(trim_trailing_spaces(line)));
        }
        IgnoreFile { rules }
    }

    /// Stands in for the rules of a folder that is itself excluded: nothing under it survives.
    pub fn exclude_all() -> IgnoreFile {
        IgnoreFile::parse(b"*")
    }

    /// `dir/name` parsed, or `None` when it is absent, unreadable or not a regular
    /// file — git does not follow an in-tree ignore file that is a symlink.
    pub fn read(dir: &Path, name: &str) -> Option<IgnoreFile> {
        let path = dir.join(name);
        if !fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) {
            return None;
        }
        fs::read(&path).ok().map(|bytes| IgnoreFile::parse(&bytes))
    }

    /// git's word on `rel` (`/`-separated, relative to this file's folder): `Some(true)`
    /// ignored, `Some(false)` re-included by a `!` line, `None` when no line matches.
    pub fn decide(&self, rel: &[u8], is_dir: bool) -> Option<bool> {
        let basename = &rel[rel.iter().rposition(|&c| c == b'/').map_or(0, |i| i + 1)..];
        self.rules
            .iter()
            .rev()
            .find(|rule| (is_dir || rule.flags & MUSTBEDIR == 0) && rule.matches(rel, basename))
            .map(|rule| rule.flags & NEGATIVE == 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(lines: &[&str]) -> IgnoreFile {
        IgnoreFile::parse(lines.join("\n").as_bytes())
    }

    #[test]
    fn the_last_matching_line_decides_and_none_means_no_line_spoke() {
        let f = file(&["*.md", "!keep.md"]);
        assert_eq!(f.decide(b"a.md", false), Some(true));
        assert_eq!(f.decide(b"sub/keep.md", false), Some(false));
        assert_eq!(f.decide(b"a.txt", false), None);
    }

    #[test]
    fn a_trailing_slash_matches_only_a_directory_and_never_what_is_inside_it() {
        let f = file(&["out/"]);
        assert_eq!(f.decide(b"out", true), Some(true));
        assert_eq!(f.decide(b"out", false), None);
        assert_eq!(f.decide(b"out/a.md", false), None); // the walk never enters out/
    }

    #[test]
    fn anchoring_and_double_star() {
        let f = file(&["/top", "a/**/b", "docs/*.tmp", "ab**/c"]);
        assert_eq!(f.decide(b"top", false), Some(true));
        assert_eq!(f.decide(b"sub/top", false), None);
        assert_eq!(f.decide(b"a/b", false), Some(true));
        assert_eq!(f.decide(b"a/x/y/b", false), Some(true));
        assert_eq!(f.decide(b"docs/sub/x.tmp", false), None);
        assert_eq!(f.decide(b"abq/c", false), Some(true));
        assert_eq!(f.decide(b"ab/x/c", false), None); // "**" after a literal is one star
    }

    #[test]
    fn brackets_classes_and_escapes() {
        let f = file(&["[!c]y", "[[:digit:]]*.dat", "q\\*", "sp\\ ", "trail   ", "\\#hash"]);
        assert_eq!(f.decide(b"dy", false), Some(true));
        assert_eq!(f.decide(b"cy", false), None);
        assert_eq!(f.decide(b"1.dat", false), Some(true));
        assert_eq!(f.decide(b"q*", false), Some(true));
        assert_eq!(f.decide(b"qq", false), None);
        assert_eq!(f.decide(b"sp ", false), Some(true));
        assert_eq!(f.decide(b"trail", false), Some(true));
        assert_eq!(f.decide(b"#hash", false), Some(true));
    }

    #[test]
    fn comments_blank_lines_crlf_and_a_bom() {
        let f = IgnoreFile::parse(b"\xef\xbb\xbf# note\r\n\r\n*.log\r\n");
        assert_eq!(f.decide(b"x.log", false), Some(true));
        assert_eq!(f.decide(b"# note", false), None);
    }
}
