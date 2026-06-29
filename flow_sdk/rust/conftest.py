# Empty conftest at the crate root. Its presence (combined with the
# [tool.pytest.ini_options] section in this directory's pyproject.toml)
# anchors pytest's rootdir here, preventing it from walking up to the repo
# root and pulling in the repo-root pytest config + tests/conftest.py.
#
# (The repo-root conftest installs a process-wide in-memory keyring backend
# for the broader test suite. The interchange matrix shells out to
# `/usr/bin/security` directly and would not be affected even if that
# conftest loaded — but isolating the crate's test environment from the
# rest of the repo is the right default regardless.)
