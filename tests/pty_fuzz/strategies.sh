#!/usr/bin/env bash
# PTY fuzzer content strategies.
#
# Each strategy is a bash function that writes one adversarial content pattern
# to stdout. They are run *inside a real PTY* by the test harness; the harness
# (pytest / vitest) owns the other matrix axes — resize schedules, chunk-split
# schedules, and truncation points — because bash cannot resize its own PTY.
#
# Usage:
#   strategies.sh --list          # one strategy name per line
#   strategies.sh <name>          # emit that strategy's content
#
# Determinism: no $RANDOM, no timestamps — same bytes every run, so the
# differential oracle (continuous-feed vs replay+serialize) compares equals.

set -euo pipefail

ESC=$'\033'
CSI="${ESC}["

# --- 1. plain baseline ------------------------------------------------------

strategy_plain_lines() {
    for i in $(seq 1 40); do
        printf 'plain line %03d: the quick brown fox jumps over the lazy dog\n' "$i"
    done
}

# --- 2. colors --------------------------------------------------------------

strategy_ansi_colors() {
    # 16-color, 256-color, truecolor — each with reset
    for c in 31 32 33 34 35 36 91 92; do
        printf '%s%smfg-16 color %s%s0m\n' "$CSI" "$c" "$c" "$CSI"
    done
    for c in 17 42 99 160 201 255; do
        printf '%s38;5;%smfg-256 color %s%s0m\n' "$CSI" "$c" "$c" "$CSI"
    done
    printf '%s38;2;255;100;0mtruecolor orange%s0m\n' "$CSI" "$CSI"
    printf '%s48;2;0;60;120m%s38;2;255;255;255mtruecolor on bg%s0m\n' "$CSI" "$CSI" "$CSI"
}

# --- 3. cursor movement -----------------------------------------------------

strategy_cursor_moves() {
    printf 'base line one\nbase line two\nbase line three\n'
    printf '%sH'        "$CSI"          # CUP home
    printf 'HOME-OVERWRITE'
    printf '%s3;5H'     "$CSI"          # CUP absolute
    printf 'AT-3-5'
    printf '%s2A'       "$CSI"          # CUU
    printf 'UP2'
    printf '%s1B'       "$CSI"          # CUD
    printf '%s10C'      "$CSI"          # CUF
    printf 'RIGHT10'
    printf '%s5D'       "$CSI"          # CUB
    printf 'LEFT5\n'
    printf '%s6;1H'     "$CSI"
    printf 'done cursor-moves\n'
}

# --- 4. ink-style erase-and-repaint (the Claude Code pattern) ---------------

strategy_erase_repaint() {
    # Render a 5-line "frame", then cursor-up 5 + erase-line each + repaint.
    # This is exactly what ink/React TUIs emit and what garbles on naive
    # replay at a different width. Row 5 is a 90-char divider — like Claude
    # Code's separator/status rows it fits the recorded 100-col PTY, but
    # wraps when naively replayed at 80 cols, which desyncs the cursor-up
    # bookkeeping (the production failure mode).
    local divider
    divider=$(printf '%0.s─' $(seq 1 90))
    local frame
    for frame in $(seq 1 12); do
        if (( frame > 1 )); then
            printf '%s5A' "$CSI"                       # cursor up 5
        fi
        local row
        for row in $(seq 1 4); do
            printf '%s2K' "$CSI"                        # erase entire line
            printf '%sG'  "$CSI"                        # cursor to col 1
            printf 'frame %02d row %d: spinner-%d\n' "$frame" "$row" $(( (frame + row) % 4 ))
        done
        printf '%s2K%sG%s\n' "$CSI" "$CSI" "$divider"   # row 5: full-width-ish divider
    done
    printf 'erase-repaint done\n'
}

# --- 5. CR-overwrite progress bar -------------------------------------------

strategy_cr_overwrite() {
    # ~87-char total line: fits the recorded 100-col PTY, wraps at 80 —
    # CR then returns to the start of the LAST wrapped row, the classic
    # progress-bar garble under naive different-width replay.
    local i
    for i in $(seq 0 5 100); do
        printf '\rprogress: %3d%% [' "$i"
        local j
        for j in $(seq 1 70); do
            if (( j * 100 <= i * 70 )); then printf '#'; else printf '.'; fi
        done
        printf ']'
    done
    printf '\rprogress: 100%% done                      \n'
}

# --- 6. wide chars / multi-byte UTF-8 ---------------------------------------

strategy_wide_utf8() {
    printf 'cjk: 終端機歷史緩衝區測試 漢字寬度\n'
    printf 'kana: ターミナルふぁじんぐ\n'
    printf 'emoji: 🚀🔥👍🏽🧑‍💻 (zwj sequence)\n'
    printf 'combining: e\xcc\x81 a\xcc\x80 n\xcc\x83 (e<U+0301> etc)\n'
    printf 'mixed: abc漢def🚀ghi한글jkl\n'
    # wide chars straddling the right edge force awkward wrap decisions
    local i
    for i in $(seq 1 4); do
        printf '%s' '邊界換行測試字元寬度二格邊界換行測試字元寬度二格邊界換行測試字元寬度二格'
    done
    printf '\n'
}

# --- 7. long soft-wrapping lines --------------------------------------------

strategy_long_wrap() {
    # Lines far wider than any plausible terminal — exercises soft-wrap and
    # later reflow-on-resize. Marker pattern makes split points checkable.
    local i
    for i in 1 2 3; do
        local n
        for n in $(seq -w 1 120); do
            printf 'W%s-%s.' "$i" "$n"
        done
        printf '\n'
    done
}

# --- 8. alternate screen ----------------------------------------------------

strategy_alt_screen() {
    printf 'before alt-screen\n'
    printf '%s?1049h' "$CSI"            # enter alt screen
    printf '%s2J%sH'  "$CSI" "$CSI"     # clear + home
    printf 'INSIDE ALT SCREEN line 1\nINSIDE ALT SCREEN line 2\n'
    printf '%s?1049l' "$CSI"            # leave alt screen
    printf 'after alt-screen\n'
}

# --- 9. scroll region (DECSTBM) ---------------------------------------------

strategy_scroll_region() {
    printf 'header stays put\n'
    printf '%s2;8r' "$CSI"              # margins rows 2..8
    printf '%s8;1H' "$CSI"
    local i
    for i in $(seq 1 15); do
        printf 'scrolling region line %02d\n' "$i"
    done
    printf '%sr' "$CSI"                 # reset margins
    printf '%s10;1Hafter scroll region\n' "$CSI"
}

# --- 10. clear screen / clear scrollback ------------------------------------

strategy_clear_screen() {
    local i
    for i in $(seq 1 30); do printf 'pre-clear line %02d\n' "$i"; done
    printf '%s2J%sH' "$CSI" "$CSI"      # clear visible + home
    printf 'after 2J clear\n'
    for i in $(seq 1 10); do printf 'post-clear line %02d\n' "$i"; done
    printf '%s3J' "$CSI"                # clear scrollback (xterm extension)
    printf 'after 3J scrollback-clear\n'
}

# --- 11. OSC: title + hyperlink ---------------------------------------------

strategy_osc() {
    printf '%s]0;fuzz-title-%d\007' "$ESC" 42
    printf 'set a window title\n'
    printf '%s]8;;https://example.com/fuzz\007link text here%s]8;;\007 plain again\n' "$ESC" "$ESC"
    # OSC terminated by ST instead of BEL
    printf '%s]0;st-terminated-title%s\\' "$ESC" "$ESC"
    printf 'osc done\n'
}

# --- 12. SGR style soup ------------------------------------------------------

strategy_sgr_styles() {
    printf '%s1mbold%s22m %s3mitalic%s23m %s4munderline%s24m\n' \
        "$CSI" "$CSI" "$CSI" "$CSI" "$CSI" "$CSI"
    printf '%s7mreverse%s27m %s9mstrike%s29m %s2mdim%s22m\n' \
        "$CSI" "$CSI" "$CSI" "$CSI" "$CSI" "$CSI"
    printf '%s1;3;4;31mcombined bold-italic-underline-red%s0m\n' "$CSI" "$CSI"
    # style spanning a soft-wrapped line
    printf '%s1;44m' "$CSI"
    local n
    for n in $(seq -w 1 80); do printf 'S%s.' "$n"; done
    printf '%s0m\n' "$CSI"
}

# --- 13. tabs and raw control chars -----------------------------------------

strategy_tabs_controls() {
    printf 'col1\tcol2\tcol3\tcol4\n'
    printf 'a\tbb\tccc\tdddd\n'
    printf 'backspace: abcX\bY\n'
    printf 'bell here \007 (should be invisible)\n'
    printf 'vertical\vtab\n'
}

# --- 14. high-volume burst ---------------------------------------------------

strategy_burst() {
    # ~250KB fast: exercises chunking, truncation, parser throughput.
    local i
    for i in $(seq 1 4500); do
        printf 'burst %04d %sthe quick brown fox%s0m 0123456789abcdef\n' \
            "$i" "${CSI}3$(( i % 8 ))m" "$CSI"
    done
}

# --- 15. save/restore cursor -------------------------------------------------

strategy_save_restore_cursor() {
    printf 'line A\nline B\nline C\n'
    printf '%s7'    "$ESC"              # DECSC save
    printf '%s1;1H' "$CSI"
    printf 'JUMPED-HOME'
    printf '%s8'    "$ESC"              # DECRC restore
    printf 'back after restore\n'
    printf '%ss'    "$CSI"              # CSI s save (SCO)
    printf '%s2;1H' "$CSI"
    printf 'JUMP2'
    printf '%su'    "$CSI"              # CSI u restore
    printf 'done save-restore\n'
}

# --- 16. insert/delete lines and chars ---------------------------------------

strategy_line_edits() {
    local i
    for i in $(seq 1 8); do printf 'edit-base line %d\n' "$i"; done
    printf '%s3;1H' "$CSI"
    printf '%s2L'   "$CSI"              # insert 2 lines
    printf 'INSERTED-LINE\n'
    printf '%s6;1H' "$CSI"
    printf '%s1M'   "$CSI"              # delete 1 line
    printf '%s7;5H' "$CSI"
    printf '%s3@'   "$CSI"              # insert 3 chars
    printf 'ICH'
    printf '%s7;1H' "$CSI"
    printf '%s2P'   "$CSI"              # delete 2 chars
    printf '%s9;1Hline edits done\n' "$CSI"
}

# --- 17. stream ends mid-escape ----------------------------------------------

strategy_incomplete_escape() {
    printf 'complete content first\n'
    printf 'truncation sentinel\n'
    # Deliberately end the stream inside an escape sequence: replay and
    # serialize must not crash or corrupt prior content.
    printf '%s38;5;1' "$CSI"
}

# --- dispatch -----------------------------------------------------------------

ALL_STRATEGIES=(
    plain_lines
    ansi_colors
    cursor_moves
    erase_repaint
    cr_overwrite
    wide_utf8
    long_wrap
    alt_screen
    scroll_region
    clear_screen
    osc
    sgr_styles
    tabs_controls
    burst
    save_restore_cursor
    line_edits
    incomplete_escape
)

main() {
    if [[ "${1:-}" == "--list" ]]; then
        printf '%s\n' "${ALL_STRATEGIES[@]}"
        exit 0
    fi
    local name="${1:?usage: strategies.sh --list | <strategy-name>}"
    local s
    for s in "${ALL_STRATEGIES[@]}"; do
        if [[ "$s" == "$name" ]]; then
            "strategy_${name}"
            exit 0
        fi
    done
    echo "unknown strategy: ${name}" >&2
    exit 1
}

main "$@"
