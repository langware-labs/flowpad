"""Worker-identity matching for the pty-recovery liveness gate.

``Shell.worker_alive()`` decides whether a spawned CLI worker is still running
by comparing the recorded ``worker_pid``'s argv against the expected executable.
A false negative here is not cosmetic: ``pty_recovery`` reads it as "worker dead
after restart", drops the shell (killing the live PTY, SIGTERM → exit 15) and
respawns — an endless ~5s relaunch loop. These cases pin the argv shapes each
platform actually produces.
"""

from flow_sdk.builtin.shell import Shell

# Verbatim from psutil on Windows: npm installs `codex` as a .CMD batch shim, so
# the PTY process is cmd.exe and the worker name lands at argv[2].
WINDOWS_NPM_CMD_SHIM = [
    r"C:\WINDOWS\system32\cmd.exe",
    "/c",
    r"C:\Users\gaditunes\AppData\Roaming\npm\codex.CMD",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    "check_for_update_on_startup=false",
]

# POSIX: the npm entrypoint is a Node shebang script, so argv[1] is the script.
POSIX_NODE_SHEBANG = ["node", "/usr/local/lib/node_modules/@openai/codex/bin/codex.js", "--foo"]

# Native binary — the plain case, argv[0].
NATIVE_EXE = [r"C:\Users\gaditunes\.local\bin\claude.exe", "--resume", "abc"]


class TestCmdlineMatchesExpected:
    def test_windows_npm_cmd_shim_is_recognized(self):
        """The regression: worker name at argv[2] behind `cmd.exe /c`."""
        assert Shell._cmdline_matches_expected(WINDOWS_NPM_CMD_SHIM, expected_exe="codex") is True

    def test_posix_node_shebang_still_matches(self):
        assert Shell._cmdline_matches_expected(POSIX_NODE_SHEBANG, expected_exe="codex") is True

    def test_native_exe_still_matches(self):
        assert Shell._cmdline_matches_expected(NATIVE_EXE, expected_exe="claude") is True

    def test_extension_and_case_are_ignored(self):
        assert Shell._cmdline_matches_expected([r"C:\bin\CODEX.EXE"], expected_exe="codex") is True

    def test_unwrap_does_not_match_a_different_worker(self):
        """Seeing through the shim must not turn the check into "any cmd.exe"."""
        assert Shell._cmdline_matches_expected(WINDOWS_NPM_CMD_SHIM, expected_exe="claude") is False

    def test_bare_cmd_exe_is_not_a_worker(self):
        assert Shell._cmdline_matches_expected([r"C:\WINDOWS\system32\cmd.exe"], expected_exe="codex") is False

    def test_empty_cmdline_is_not_a_match(self):
        assert Shell._cmdline_matches_expected([], expected_exe="codex") is False

    def test_no_expectation_matches_anything(self):
        assert Shell._cmdline_matches_expected(NATIVE_EXE, expected_exe=None) is True


class TestSessionIdGate:
    def test_session_id_is_read_through_the_shim(self):
        """argv scanning must see the real args, not the shim's."""
        argv = [r"C:\WINDOWS\system32\cmd.exe", "/c", r"C:\npm\claude.CMD", "--resume", "sess-1"]
        assert Shell._cmdline_matches_expected(argv, expected_exe="claude", expected_session_id="sess-1") is True
        assert Shell._cmdline_matches_expected(argv, expected_exe="claude", expected_session_id="sess-2") is False

    def test_absent_session_id_is_not_a_mismatch(self):
        """The codex TUI doesn't surface a session id on argv; absence must pass."""
        assert (
            Shell._cmdline_matches_expected(WINDOWS_NPM_CMD_SHIM, expected_exe="codex", expected_session_id="sess-1")
            is True
        )


class TestStripCmdShim:
    def test_strips_slash_c_and_slash_k(self):
        assert Shell._strip_cmd_shim([r"C:\WINDOWS\system32\cmd.exe", "/c", "codex.CMD"]) == ["codex.CMD"]
        assert Shell._strip_cmd_shim(["cmd.exe", "/K", "codex.CMD"]) == ["codex.CMD"]

    def test_leaves_non_shim_cmdlines_untouched(self):
        assert Shell._strip_cmd_shim(POSIX_NODE_SHEBANG) == POSIX_NODE_SHEBANG
        # cmd.exe with no /c payload is not a shim
        assert Shell._strip_cmd_shim(["cmd.exe", "/c"]) == ["cmd.exe", "/c"]
