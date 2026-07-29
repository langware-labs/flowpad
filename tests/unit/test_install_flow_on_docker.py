from pathlib import Path


def test_existing_install_is_replaced_without_reinstalling_dependencies():
    script = Path("install_flow_on_docker.sh").read_text(encoding="utf-8")

    assert 'pip" show flowpad' in script
    assert "PIP_INSTALL_ARGS+=(--force-reinstall --no-deps)" in script
    assert 'pip" install "${PIP_INSTALL_ARGS[@]}" "$WHEEL"' in script
