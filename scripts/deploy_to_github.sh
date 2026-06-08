#!/bin/bash
#
# Deploy flowpad to GitHub and PyPI
#
# This script:
#   1. Increments the patch version in _version.py
#   2. Signs the standalone flow-rs binaries (unless --skip-flow-rs-sign):
#      signs the host-OS binary locally and triggers the other OS's signing
#      workflow in langware-labs/flowpad-desktop, then downloads both into
#      flow_sdk/rust/bin/ so they get vendored into the wheel
#   3. Commits the version bump (+ signed binaries)
#   4. Creates a git tag
#   5. Pushes to GitHub
#   6. Builds and publishes to PyPI (unless --no-pypi)
#   7. Validates the installed version
#
# Usage: ./scripts/deploy_to_github.sh [--skip-tests] [--no-pypi] [--skip-flow-rs-sign]
#
# After deployment, install with:
#   pip install flowpad
#   pip install flowpad==X.Y.Z
#   pip install git+https://github.com/langware-labs/flowpad.git
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

VERSION_FILE="flow_sdk/_version.py"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
SKIP_TESTS=false
NO_PYPI=false
SKIP_FLOW_RS_SIGN=false
FORCE_FLOW_RS_SIGN=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --no-pypi)
            NO_PYPI=true
            shift
            ;;
        --skip-flow-rs-sign)
            SKIP_FLOW_RS_SIGN=true
            shift
            ;;
        --force-flow-rs-sign)
            FORCE_FLOW_RS_SIGN=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [--skip-tests] [--no-pypi] [--skip-flow-rs-sign] [--force-flow-rs-sign]"
            echo ""
            echo "Options:"
            echo "  --skip-tests          Skip running tests before deployment"
            echo "  --no-pypi             Skip publishing to PyPI"
            echo "  --skip-flow-rs-sign   Skip building/signing the standalone flow-rs binaries"
            echo "  --force-flow-rs-sign  Re-sign flow-rs even when the Rust crate source is unchanged"
            echo "  -h, --help            Show this help message"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Function to get current version from _version.py
get_current_version() {
    grep -o '"[0-9]*\.[0-9]*\.[0-9]*"' "$VERSION_FILE" | tr -d '"'
}

# Function to increment patch version
increment_patch_version() {
    local version="$1"
    local major minor patch
    IFS='.' read -r major minor patch <<< "$version"
    patch=$((patch + 1))
    echo "${major}.${minor}.${patch}"
}

# Function to update version in _version.py
update_version_file() {
    local new_version="$1"
    echo "__version__ = \"${new_version}\"" > "$VERSION_FILE"
}

echo -e "${GREEN}=== Flowpad Deployment ===${NC}"
echo ""

# Check if we're in a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo -e "${RED}Error: Not a git repository${NC}"
    exit 1
fi

# Check if _version.py exists
if [[ ! -f "$VERSION_FILE" ]]; then
    echo -e "${RED}Error: $VERSION_FILE not found${NC}"
    exit 1
fi

# Get current and new version
CURRENT_VERSION=$(get_current_version)
NEW_VERSION=$(increment_patch_version "$CURRENT_VERSION")

echo -e "Current version: ${YELLOW}${CURRENT_VERSION}${NC}"
echo -e "New version:     ${GREEN}${NEW_VERSION}${NC}"
echo ""

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)
echo -e "Branch: ${GREEN}$CURRENT_BRANCH${NC}"

# Check if remote exists
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
if [[ -z "$REMOTE_URL" ]]; then
    echo -e "${RED}Error: No 'origin' remote configured${NC}"
    exit 1
fi
echo -e "Remote: ${GREEN}$REMOTE_URL${NC}"
echo ""

# Run tests before deploying (unless skipped)
if [[ "$SKIP_TESTS" == false ]]; then
    echo -e "${YELLOW}Running tests...${NC}"
    if python3 -m pytest tests/ -v --tb=short; then
        echo -e "${GREEN}Tests passed!${NC}"
    else
        echo -e "${RED}Tests failed!${NC}"
        read -p "Do you want to deploy anyway? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${RED}Aborted due to test failures.${NC}"
            exit 1
        fi
    fi
    echo ""
else
    echo -e "${YELLOW}Skipping tests...${NC}"
    echo ""
fi

# Check for uncommitted changes (other than version file)
UNCOMMITTED=$(git status --porcelain | grep -v "$VERSION_FILE" || true)
if [[ -n "$UNCOMMITTED" ]]; then
    echo -e "${YELLOW}Warning: You have uncommitted changes:${NC}"
    echo "$UNCOMMITTED"
    echo ""
    read -p "These changes will be included in the version bump commit. Continue? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}Aborted. Please commit your changes first.${NC}"
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Sign the standalone flow-rs binaries (vendored into the wheel)
# ---------------------------------------------------------------------------
# Sign the host-OS binary locally, trigger the OTHER OS's signing workflow in
# langware-labs/flowpad-desktop, wait for it, and download the signed artifact.
# Both signed binaries land under flow_sdk/rust/bin/ so the `git add -A` below
# commits them and the `uv build` later packages them into the wheel.
#
# Runs BEFORE the version-bump commit so the signed binaries ride the release
# commit + tag (and are present for the wheel build).
DESKTOP_REPO="langware-labs/flowpad-desktop"
BIN_DIR="flow_sdk/rust/bin"
MAC_BIN="${BIN_DIR}/darwin/flow-rs"
WIN_BIN="${BIN_DIR}/win32/flow-rs.exe"
# Crate SOURCE that the binary is built from (everything that affects the build,
# NOT the vendored binaries themselves).
RUST_SRC_PATHS=("flow_sdk/rust/src" "flow_sdk/rust/Cargo.toml")

# Decide whether signing is needed. Skip it when the already-committed signed
# binaries are present AND the crate source hasn't changed since they were last
# committed — no point rebuilding/notarizing and burning a CI run for identical
# output. --force-flow-rs-sign overrides; a first run (binaries never committed)
# always signs.
needs_flow_rs_sign() {
    [[ "$FORCE_FLOW_RS_SIGN" == true ]] && return 0
    # Missing committed binaries → must sign.
    local last_bin_commit
    last_bin_commit=$(git log -1 --format=%H -- "$BIN_DIR" 2>/dev/null || true)
    [[ -z "$last_bin_commit" || ! -f "$MAC_BIN" || ! -f "$WIN_BIN" ]] && return 0
    # Source commits landed after the binaries were last committed?
    [[ -n "$(git log --oneline "${last_bin_commit}..HEAD" -- "${RUST_SRC_PATHS[@]}" 2>/dev/null)" ]] && return 0
    # Uncommitted (staged/unstaged) source changes in the working tree?
    [[ -n "$(git status --porcelain -- "${RUST_SRC_PATHS[@]}" 2>/dev/null)" ]] && return 0
    return 1  # binaries present and source unchanged → reuse them
}

if [[ "$SKIP_FLOW_RS_SIGN" == false ]] && ! needs_flow_rs_sign; then
    echo -e "${GREEN}flow-rs crate source unchanged since the committed signed binaries — reusing them (use --force-flow-rs-sign to re-sign).${NC}"
    echo ""
elif [[ "$SKIP_FLOW_RS_SIGN" == false ]]; then
    echo -e "${YELLOW}Signing standalone flow-rs (vendored into wheel)...${NC}"

    if ! command -v gh &> /dev/null; then
        echo -e "${RED}Error: gh CLI not found — required to trigger the remote signing workflow.${NC}"
        echo -e "${RED}Install: https://cli.github.com  (or re-run with --skip-flow-rs-sign)${NC}"
        exit 1
    fi
    if ! gh auth status >/dev/null 2>&1; then
        echo -e "${RED}Error: gh not authenticated. Run 'gh auth login' (needs actions:read/write on ${DESKTOP_REPO}).${NC}"
        exit 1
    fi

    # The remote workflow rebuilds flow-rs from source at CURRENT_BRANCH, so
    # that branch must already be pushed with the current crate source.
    echo -e "${YELLOW}  Pushing ${CURRENT_BRANCH} so the remote workflow builds current crate source...${NC}"
    git push origin "$CURRENT_BRANCH"

    HOST_OS="$(uname -s)"
    case "$HOST_OS" in
        Darwin)
            LOCAL_PLAT="macOS"
            REMOTE_WF="sign-flow-rs-windows.yml"
            REMOTE_ARTIFACT="flow-rs-windows"
            REMOTE_DEST="${BIN_DIR}/win32"
            ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT)
            LOCAL_PLAT="Windows"
            REMOTE_WF="sign-flow-rs-macos.yml"
            REMOTE_ARTIFACT="flow-rs-macos"
            REMOTE_DEST="${BIN_DIR}/darwin"
            ;;
        *)
            echo -e "${RED}Error: flow-rs signing unsupported on host '$HOST_OS' (need macOS or Windows).${NC}"
            exit 1
            ;;
    esac

    # 1. Sign the local-platform binary
    echo -e "${YELLOW}  Local sign (${LOCAL_PLAT})...${NC}"
    if [[ "$LOCAL_PLAT" == "macOS" ]]; then
        "${SCRIPT_DIR}/sign_flow_rs_macos.sh"
    else
        powershell -ExecutionPolicy Bypass -File "${SCRIPT_DIR}/sign_flow_rs_windows.ps1"
    fi

    # 2. Trigger the other platform's signing workflow remotely
    echo -e "${YELLOW}  Triggering ${REMOTE_WF} on ${DESKTOP_REPO} (branch ${CURRENT_BRANCH})...${NC}"
    gh workflow run "$REMOTE_WF" --repo "$DESKTOP_REPO" -f flowpad_branch="$CURRENT_BRANCH"

    # Resolve the run id we just dispatched (gh workflow run doesn't return it;
    # poll the dispatched runs on this branch until it appears).
    RUN_ID=""
    for _ in $(seq 1 30); do
        RUN_ID=$(gh run list --repo "$DESKTOP_REPO" -w "$REMOTE_WF" -b "$CURRENT_BRANCH" \
                  -e workflow_dispatch -L1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
        [[ -n "$RUN_ID" ]] && break
        sleep 3
    done
    if [[ -z "$RUN_ID" ]]; then
        echo -e "${RED}Error: could not find the dispatched run for ${REMOTE_WF}.${NC}"
        exit 1
    fi

    # 3. Wait for it (gh run watch exits non-zero if the run fails)
    echo -e "${YELLOW}  Waiting for run ${RUN_ID} to finish...${NC}"
    gh run watch "$RUN_ID" --repo "$DESKTOP_REPO" --exit-status

    # 4. Download the signed artifact into the vendor dir
    mkdir -p "$REMOTE_DEST"
    rm -f "${REMOTE_DEST}/flow-rs" "${REMOTE_DEST}/flow-rs.exe"
    gh run download "$RUN_ID" --repo "$DESKTOP_REPO" -n "$REMOTE_ARTIFACT" -D "$REMOTE_DEST"

    # 5. Assert BOTH signed binaries are present before continuing
    if [[ ! -f "$MAC_BIN" || ! -f "$WIN_BIN" ]]; then
        echo -e "${RED}Error: expected both signed flow-rs binaries.${NC}"
        echo -e "${RED}  mac: ${MAC_BIN}  ($( [[ -f $MAC_BIN ]] && echo OK || echo MISSING ))${NC}"
        echo -e "${RED}  win: ${WIN_BIN}  ($( [[ -f $WIN_BIN ]] && echo OK || echo MISSING ))${NC}"
        exit 1
    fi
    chmod +x "$MAC_BIN" 2>/dev/null || true
    echo -e "${GREEN}Signed flow-rs ready:${NC}"
    echo -e "${GREEN}  ${MAC_BIN}${NC}"
    echo -e "${GREEN}  ${WIN_BIN}${NC}"
    echo ""
else
    echo -e "${YELLOW}Skipping flow-rs signing (--skip-flow-rs-sign)${NC}"
    echo ""
fi

# Update version file
echo -e "${YELLOW}Updating version to ${NEW_VERSION}...${NC}"
update_version_file "$NEW_VERSION"

# Stage and commit all changes
echo -e "${YELLOW}Committing version bump...${NC}"
git add -A
git commit -m "Bump version to ${NEW_VERSION}"
echo -e "${GREEN}Committed version bump${NC}"

# Create git tag
TAG_NAME="v${NEW_VERSION}"
echo -e "${YELLOW}Creating tag: ${TAG_NAME}${NC}"

# Check if tag already exists
if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
    echo -e "${RED}Error: Tag '$TAG_NAME' already exists${NC}"
    exit 1
fi

git tag -a "$TAG_NAME" -m "Release ${NEW_VERSION}"
echo -e "${GREEN}Tag '${TAG_NAME}' created${NC}"

# Push to GitHub
echo ""
echo -e "${YELLOW}Pushing to GitHub...${NC}"
git push origin "$CURRENT_BRANCH"
git push origin "$TAG_NAME"
echo -e "${GREEN}Pushed to origin/$CURRENT_BRANCH with tag ${TAG_NAME}${NC}"

# Build and publish to PyPI
if [[ "$NO_PYPI" == false ]]; then
    echo ""
    echo -e "${YELLOW}Building package...${NC}"

    # Check for PyPI credentials
    if [[ -z "$TWINE_API_TOKEN" ]] && [[ ! -f "$HOME/.pypirc" ]]; then
        echo -e "${RED}Error: No PyPI credentials found.${NC}"
        echo -e "Set TWINE_API_TOKEN or configure ~/.pypirc"
        echo -e "Skipping PyPI publish. Use --no-pypi to suppress this error."
        echo ""
    else
        # Clean previous builds (including any stale setuptools artifacts)
        rm -rf dist/ build/ flowpad.egg-info/

        # Build UI assets (required for the wheel to include frontend)
        echo -e "${YELLOW}Building UI assets...${NC}"
        python3 build_ui.py
        echo -e "${GREEN}UI assets built${NC}"

        # Verify index.html references a JS file that actually exists
        STATIC_DIR="flow_sdk/server/static"
        HTML_JS=$(grep -o 'assets/index-[^"]*\.js' "${STATIC_DIR}/index.html" | head -1)
        if [[ -z "$HTML_JS" ]]; then
            echo -e "${RED}Error: Could not find JS reference in ${STATIC_DIR}/index.html${NC}"
            exit 1
        fi
        if [[ ! -f "${STATIC_DIR}/${HTML_JS}" ]]; then
            echo -e "${RED}Error: ${STATIC_DIR}/index.html references ${HTML_JS} but file does not exist!${NC}"
            echo -e "${RED}Run python3 build_ui.py to regenerate static assets.${NC}"
            exit 1
        fi
        echo -e "${GREEN}Asset check passed: ${HTML_JS}${NC}"

        # Build wheel + sdist (prefer uv, fall back to python3 -m build)
        if command -v uv &> /dev/null; then
            uv build
        else
            python3 -m build
        fi
        echo -e "${GREEN}Package built${NC}"

        # Upload to PyPI (prefer uv run twine, fall back to python3 -m twine)
        echo -e "${YELLOW}Publishing to PyPI...${NC}"
        if command -v uv &> /dev/null; then
            if [[ -n "$TWINE_API_TOKEN" ]]; then
                uv run twine upload dist/* -u __token__ -p "$TWINE_API_TOKEN"
            else
                uv run twine upload dist/*
            fi
        else
            if [[ -n "$TWINE_API_TOKEN" ]]; then
                python3 -m twine upload dist/* -u __token__ -p "$TWINE_API_TOKEN"
            else
                python3 -m twine upload dist/*
            fi
        fi
        echo -e "${GREEN}Published to PyPI${NC}"

        # Validate PyPI install
        echo ""
        echo -e "${YELLOW}Validating PyPI package...${NC}"
        pip3 install --quiet "flowpad==${NEW_VERSION}" --force-reinstall
        echo -e "${GREEN}PyPI package validated${NC}"
    fi
else
    echo ""
    echo -e "${YELLOW}Skipping PyPI publish (--no-pypi)${NC}"
fi

# Install from GitHub
echo ""
echo -e "${YELLOW}Installing from GitHub...${NC}"
pip3 install --quiet git+https://github.com/langware-labs/flowpad.git@${TAG_NAME} --force-reinstall
echo -e "${GREEN}Installed from GitHub${NC}"

# Run post-install smoke test
echo ""
echo -e "${YELLOW}Running post-install validation...${NC}"
if "${SCRIPT_DIR}/validate_install.sh"; then
    echo -e "${GREEN}✓ Install validation passed${NC}"
else
    echo -e "${RED}✗ Install validation FAILED${NC}"
    echo -e "${RED}The package is broken. Do NOT publish.${NC}"
    exit 1
fi

# Print summary
echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}=== Deployment Complete ===${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo -e "  Version:  ${BLUE}${NEW_VERSION}${NC}"
echo -e "  Tag:      ${BLUE}${TAG_NAME}${NC}"
echo ""
echo -e "Install with:"
echo -e "  ${GREEN}pip install flowpad${NC}"
echo -e "  ${GREEN}pip install flowpad==${NEW_VERSION}${NC}"
echo -e "  ${GREEN}pip install git+https://github.com/langware-labs/flowpad.git${NC}"
echo -e "  ${GREEN}pip install git+https://github.com/langware-labs/flowpad.git@${TAG_NAME}${NC}"
echo ""
