//! One `.gitignore` file as a matcher — a port of what the Python walk uses:
//! `pathspec.GitIgnoreSpec` (1.1, "simple" backend).
//!
//! The port is line for line, not "a gitignore matcher": the walk's oracle is
//! `GitIgnoreSpec.match_file`, whose answers differ from git's own and from
//! other gitignore libraries in ways a tree walk can see. `build/**` matches
//! the directory `build/` itself here (the regex is `^build/`), so the walk
//! drops that directory instead of yielding it empty.
//!
//! * `parse_line` is `GitIgnoreSpecPattern.pattern_to_regex`: the same segment
//!   normalisation, the same regex text (written in this crate's regex dialect),
//!   the same three outcomes — a pattern, a no-op, or an unparseable line.
//! * `Spec::match_file` is `SimpleGiBackend.match_file` over reversed patterns:
//!   the last pattern matching the path ITSELF wins; failing that, the last
//!   pattern matching through a directory marker.

use std::cell::OnceCell;

use regex::{Regex, RegexSet};

/// The capture group a directory-marker match sets (`pathspec`'s `_DIR_MARK`).
const DIR_MARK: &str = "ps_d";
const DIR_MARK_CG: &str = "(?P<ps_d>/)";
/// `(?:(?P<ps_d>/)|$)` — Python's `$` also matches before one final newline.
const DIR_MARK_OPT: &str = "(?:(?P<ps_d>/)|\\n?\\z)";

/// What one line of a `.gitignore` is.
#[derive(Debug, PartialEq)]
pub enum Line {
    /// Blank, a comment, `/`, or a bracket with no closing `]` — matches nothing.
    NoOp,
    /// A pattern: its regex and whether a match ignores (`true`) or re-includes.
    Pattern { regex: String, ignore: bool },
    /// A line pathspec cannot parse (`a\`, a bare `!`) — dropped, as git does.
    Unparseable,
}

/// The characters `str.isspace()` is true for — `str.rstrip()` strips these.
fn py_space(c: char) -> bool {
    matches!(c as u32,
        0x09..=0x0d | 0x1c..=0x20 | 0x85 | 0xa0 | 0x1680 | 0x2000..=0x200a
        | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000)
}

/// The boundaries `str.splitlines()` splits on.
fn py_line_break(c: char) -> bool {
    matches!(c as u32, 0x0a..=0x0d | 0x1c..=0x1e | 0x85 | 0x2028 | 0x2029)
}

fn literal(c: char, out: &mut String) {
    let mut buf = [0u8; 4];
    out.push_str(&regex::escape(c.encode_utf8(&mut buf)));
}

/// A glob bracket expression as Python's `re` reads it: literals and ranges,
/// nothing else (a backslash is a literal, there are no POSIX classes).
/// `None` when `re.compile` would refuse it (a reversed range).
fn bracket(negated: bool, content: &[char]) -> Option<String> {
    let mut out = String::from(if negated { "[^" } else { "[" });
    let hex = |c: char| format!("\\x{{{:x}}}", c as u32);
    let mut k = 0;
    while k < content.len() {
        let lo = content[k];
        k += 1;
        if k < content.len() && content[k] == '-' {
            if k + 1 == content.len() {
                out.push_str(&hex(lo));
                out.push_str(&hex('-'));
                break;
            }
            let hi = content[k + 1];
            k += 2;
            if hi < lo {
                return None;
            }
            out.push_str(&hex(lo));
            out.push('-');
            out.push_str(&hex(hi));
        } else {
            out.push_str(&hex(lo));
        }
    }
    out.push(']');
    Some(out)
}

enum GlobError {
    /// No closing bracket: git discards the pattern (a no-op).
    Range,
    /// A trailing escape, or a class `re` cannot compile.
    Invalid,
}

/// `_GitIgnoreBasePattern._translate_segment_glob(pattern, 'raise')`.
fn translate_segment_glob(seg: &[char]) -> Result<String, GlobError> {
    let mut escape = false;
    let mut regex = String::new();
    let (mut i, end) = (0, seg.len());
    while i < end {
        let ch = seg[i];
        i += 1;
        if escape {
            escape = false;
            literal(ch, &mut regex);
        } else if ch == '\\' {
            escape = true;
        } else if ch == '*' {
            regex.push_str("[^/]*");
        } else if ch == '?' {
            regex.push_str("[^/]");
        } else if ch == '[' {
            let mut j = i;
            if j < end && (seg[j] == '!' || seg[j] == '^') {
                j += 1;
            }
            if j < end && seg[j] == ']' {
                j += 1;
            }
            while j < end && seg[j] != ']' {
                j += 1;
            }
            if j >= end {
                return Err(GlobError::Range);
            }
            let negated = seg[i] == '!' || seg[i] == '^';
            if negated {
                i += 1;
            }
            regex.push_str(&bracket(negated, &seg[i..j]).ok_or(GlobError::Invalid)?);
            i = j + 1;
        } else {
            literal(ch, &mut regex);
        }
    }
    if escape {
        return Err(GlobError::Invalid);
    }
    Ok(regex)
}

enum Normalized {
    Segments(Vec<Vec<char>>),
    Override(&'static str),
}

fn is_star2(seg: &[char]) -> bool {
    seg == ['*', '*']
}

/// `GitIgnoreSpecPattern.__normalize_segments`; `None` = "normalized to nothing".
fn normalize_segments(is_dir_pattern: bool, mut segs: Vec<Vec<char>>) -> Option<Normalized> {
    if segs[0].is_empty() {
        segs.remove(0);
    } else if (segs.len() == 1 || (segs.len() == 2 && segs[1].is_empty())) && !is_star2(&segs[0]) {
        segs.insert(0, vec!['*', '*']);
    }
    if segs.is_empty() {
        return None;
    }
    if segs.last().is_some_and(|s| s.is_empty()) {
        *segs.last_mut().unwrap() = vec!['*', '*'];
    }
    for i in (1..segs.len()).rev() {
        if is_star2(&segs[i - 1]) && is_star2(&segs[i]) {
            segs.remove(i);
        }
    }
    let star = |s: &Vec<char>| s.as_slice() == ['*'];
    Some(match segs.as_slice() {
        [a] if is_star2(a) => Normalized::Override(if is_dir_pattern { DIR_MARK_CG } else { "." }),
        [a, b] if is_star2(a) && star(b) => Normalized::Override("."),
        [a, b, c] if is_star2(a) && star(b) && is_star2(c) => {
            Normalized::Override(if is_dir_pattern { DIR_MARK_CG } else { "/" })
        }
        _ => Normalized::Segments(segs),
    })
}

/// `GitIgnoreSpecPattern.__translate_segments`.
fn translate_segments(is_dir_pattern: bool, segs: &[Vec<char>]) -> Result<String, GlobError> {
    let mut out = String::new();
    let mut need_slash = false;
    let end = segs.len() - 1;
    for (i, seg) in segs.iter().enumerate() {
        if is_star2(seg) {
            if i == 0 {
                out.push_str("^(?:.+/)?");
            } else if i < end {
                out.push_str("(?:/.+)?");
                need_slash = true;
            } else {
                out.push_str(if is_dir_pattern { DIR_MARK_CG } else { "/" });
            }
            continue;
        }
        if i == 0 {
            out.push('^');
        }
        if need_slash {
            out.push('/');
        }
        if seg.as_slice() == ['*'] {
            out.push_str("[^/]+");
        } else {
            out.push_str(&translate_segment_glob(seg)?);
        }
        if i == end {
            out.push_str(DIR_MARK_OPT);
        }
        need_slash = true;
    }
    Ok(out)
}

/// `GitIgnoreSpecPattern.pattern_to_regex` for one line.
pub fn parse_line(line: &str) -> Line {
    let mut pattern: &str = if line.ends_with("\\ ") { line } else { line.trim_end_matches(py_space) };
    if pattern.is_empty() || pattern.starts_with('#') || pattern == "/" {
        return Line::NoOp;
    }
    let ignore = !pattern.starts_with('!');
    if !ignore {
        pattern = &pattern[1..];
    }
    let segs: Vec<Vec<char>> = pattern.split('/').map(|s| s.chars().collect()).collect();
    let is_dir_pattern = segs.last().is_some_and(|s| s.is_empty());
    let regex = match normalize_segments(is_dir_pattern, segs) {
        None => return Line::Unparseable,
        Some(Normalized::Override(regex)) => regex.to_string(),
        Some(Normalized::Segments(segs)) => match translate_segments(is_dir_pattern, &segs) {
            Ok(regex) => regex,
            Err(GlobError::Range) => return Line::NoOp,
            Err(GlobError::Invalid) => return Line::Unparseable,
        },
    };
    Line::Pattern { regex, ignore }
}

/// One pattern of a file: compiled on its own only when a path matches it and
/// the directory-marker question has to be asked.
struct Pattern {
    source: String,
    ignore: bool,
    regex: OnceCell<Option<Regex>>,
}

impl Pattern {
    /// Did `path` match through the directory marker (`foo/` matching `foo/bar`)?
    fn through_dir_mark(&self, path: &str) -> bool {
        self.regex
            .get_or_init(|| Regex::new(&self.source).ok())
            .as_ref()
            .and_then(|regex| regex.captures(path))
            .is_some_and(|captures| captures.name(DIR_MARK).is_some())
    }
}

/// One `.gitignore` file, compiled.
pub struct Spec {
    /// Every pattern at once: most paths match none, and that is one pass.
    set: RegexSet,
    /// The same patterns, in file order.
    patterns: Vec<Pattern>,
}

impl Spec {
    /// Compile the text of a `.gitignore`. A line that cannot be parsed is
    /// dropped and the rest of the file applies (diskio.md §1 step 0).
    pub fn from_text(text: &str) -> Spec {
        let mut patterns: Vec<Pattern> = Vec::new();
        for line in text.split(py_line_break) {
            match parse_line(line) {
                Line::NoOp => {}
                Line::Unparseable => eprintln!("flowpad-diskio-scan: dropped unparseable .gitignore line {line:?}"),
                Line::Pattern { regex, ignore } => patterns.push(Pattern { source: regex, ignore, regex: OnceCell::new() }),
            }
        }
        let compile = |patterns: &[Pattern]| RegexSet::new(patterns.iter().map(|p| p.source.as_str()));
        let set = match compile(&patterns) {
            Ok(set) => set,
            Err(_) => {
                // One pattern this regex dialect refuses: find it, drop it, keep the rest.
                patterns.retain(|pattern| {
                    let ok = Regex::new(&pattern.source).is_ok();
                    if !ok {
                        eprintln!("flowpad-diskio-scan: dropped .gitignore pattern {:?}", pattern.source);
                    }
                    ok
                });
                compile(&patterns).unwrap_or_else(|_| RegexSet::empty())
            }
        };
        Spec { set, patterns }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// `GitIgnoreSpec.match_file(path)`: does this file's last word on `path` ignore it?
    pub fn match_file(&self, path: &str) -> bool {
        if self.patterns.is_empty() {
            return false;
        }
        let matched = self.set.matches(path);
        if !matched.matched_any() {
            return false;
        }
        let mut hits: Vec<usize> = matched.iter().collect();
        hits.reverse();
        let mut verdict = false;
        let mut priority = 0;
        for index in hits {
            let pattern = &self.patterns[index];
            let this = if pattern.through_dir_mark(path) { 1 } else { 2 };
            if this > priority {
                verdict = pattern.ignore;
                priority = this;
            }
            if this == 2 {
                break;
            }
        }
        verdict
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(lines: &[&str]) -> Spec {
        Spec::from_text(&lines.join("\n"))
    }

    #[test]
    fn the_three_outcomes_of_a_line() {
        for noop in ["", "   ", "# comment", "/", "a[b"] {
            assert_eq!(parse_line(noop), Line::NoOp, "{noop:?}");
        }
        for bad in ["a\\", "!", "[z-a]"] {
            assert_eq!(parse_line(bad), Line::Unparseable, "{bad:?}");
        }
        assert!(matches!(parse_line("!keep"), Line::Pattern { ignore: false, .. }));
        assert!(matches!(parse_line("\\!literal"), Line::Pattern { ignore: true, .. }));
    }

    #[test]
    fn an_unparseable_line_is_dropped_and_the_rest_applies() {
        let s = spec(&["*.log", "a\\", "!", "tmp/"]);
        assert!(s.match_file("x.log"));
        assert!(s.match_file("tmp/"));
        assert!(!s.match_file("tmp"));
        assert!(!s.match_file("a"));
    }

    #[test]
    fn a_trailing_double_star_matches_the_directory_itself() {
        // pathspec: `x.d/**` is `^x\.d/` — "x.d/" matches, "x.d" does not.
        let s = spec(&["x.d/**"]);
        assert!(s.match_file("x.d/"));
        assert!(!s.match_file("x.d"));
        assert!(s.match_file("x.d/inner.txt"));
    }

    #[test]
    fn the_last_pattern_matching_the_path_itself_wins() {
        let s = spec(&["foo", "!foo/"]);
        assert!(!s.match_file("foo/")); // re-included as a directory …
        assert!(s.match_file("foo")); // … and still ignored as a bare name
        let s = spec(&["*.md", "!keep.md"]);
        assert!(s.match_file("a.md"));
        assert!(!s.match_file("keep.md"));
        assert!(!s.match_file("sub/keep.md"));
    }

    #[test]
    fn a_match_on_the_path_itself_outranks_a_later_directory_marker() {
        let s = spec(&["*.txt", "!dir/"]);
        assert!(s.match_file("dir/a.txt"));
    }

    #[test]
    fn anchoring_and_inner_double_star() {
        let s = spec(&["/top", "a/**/b", "docs/*.tmp"]);
        assert!(s.match_file("top"));
        assert!(!s.match_file("sub/top"));
        assert!(s.match_file("a/b"));
        assert!(s.match_file("a/x/y/b"));
        assert!(s.match_file("docs/x.tmp"));
        assert!(!s.match_file("docs/sub/x.tmp"));
        assert!(!s.match_file("other/docs/x.tmp"));
    }

    #[test]
    fn brackets_and_escapes() {
        let s = spec(&["[ab]x", "[!c]y", "q\\*", "sp\\ "]);
        assert!(s.match_file("ax"));
        assert!(!s.match_file("cx"));
        assert!(s.match_file("dy"));
        assert!(!s.match_file("cy"));
        assert!(s.match_file("q*"));
        assert!(!s.match_file("qq"));
        assert!(s.match_file("sp "));
    }

    #[test]
    fn lines_split_and_strip_as_python_does() {
        let s = Spec::from_text("a.txt  \r\nb.txt\u{2028}c.txt\u{0c}d.txt");
        for name in ["a.txt", "b.txt", "c.txt", "d.txt"] {
            assert!(s.match_file(name), "{name}");
        }
    }
}
