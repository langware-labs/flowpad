#!/usr/bin/env python3
"""cred-scan inventory — every env var a project reads, with where and how.

    python3 cred_scan.py scan [ROOT] [--include-nested]   # the phase-1 inventory
    python3 cred_scan.py declared                          # what this project already declares

`scan` is stdlib-only and never talks to Flowpad. It prints ONE JSON object:

    {"root": ..., "vars": [{"name", "sources", "signals", "evidence": [...]}],
     "sdks": [...], "credential_files": [...], "alerts": [...]}

A value never leaves this script. Env files are read for their KEYS (everything
after `=` is dropped on the line it was read from), hardcoded-secret alerts carry
a file, a line and a kind — never the match — and template comments are kept
only from templates, which document rather than hold values.

Signals (what the evidence says about need; phase 2 turns them into a tier):
  hard            read with no fallback — the program fails when it is unset
  read            read, no default, no visible failure (None / undefined / "")
  default         read with a fallback value
  schema          a settings schema field with no default
  schema-default  a settings schema field with a default, or `.optional()`
  template        uncommented in an env template, empty value
  template-value  uncommented in an env template, with an example value
  optional        commented out in an env template
  present         a key in a real env file (.env, .env.local, …)
  infra-hard      compose/shell `${X:?}`, Terraform variable without a default
  infra-default   compose/shell `${X:-d}`, Dockerfile ARG/ENV with a default
  ci-test         a CI job that is not a deploy reads it
  ci-deploy       a deploy / release / publish job reads it
  test-skip       a test skips itself when it is unset
  sdk             a dependency's SDK reads it on its own (see SDK_IMPLICIT)
  cred-file       a credential file names it (`.npmrc ${X}`, …)
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__", "vendor", "dist", "build",
    ".next", ".nuxt", ".svelte-kit", "target", "coverage", ".tox", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".turbo", ".cache", ".idea", ".vscode", "site-packages",
    ".flow", "out",
}
MAX_BYTES = 1_000_000
MAX_EVIDENCE = 25
MINIFIED_LINE = 5000

CODE_EXT = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte", ".go", ".java",
    ".kt", ".kts", ".scala", ".rs", ".rb", ".php", ".cs", ".swift", ".ex", ".exs",
}
SHELL_EXT = {".sh", ".bash", ".zsh"}
YAML_EXT = {".yml", ".yaml"}

#: Variables every machine or CI runner sets itself — never a thing to declare.
AMBIENT = {
    "PATH", "HOME", "USER", "USERNAME", "PWD", "OLDPWD", "SHELL", "TERM", "LANG", "LC_ALL",
    "TMPDIR", "TMP", "TEMP", "HOSTNAME", "CI", "NODE_ENV", "PYTHONPATH", "VIRTUAL_ENV",
    "GITHUB_TOKEN", "GITHUB_WORKSPACE", "GITHUB_SHA", "GITHUB_REF", "GITHUB_OUTPUT",
    "GITHUB_ENV", "GITHUB_STEP_SUMMARY", "GITHUB_REPOSITORY", "GITHUB_ACTIONS",
    "RUNNER_OS", "RUNNER_TEMP", "EDITOR", "DISPLAY", "SSH_AUTH_SOCK",
}

NAME = r"([A-Z][A-Z0-9_]{1,})"

#: Dependency token → (service, env vars its SDK reads unprompted, help_url).
#: Keep in step with references/sdk-implicit.md, which explains each row.
SDK_IMPLICIT: dict[str, tuple[str, list[str], str]] = {
    "openai": ("openai", ["OPENAI_API_KEY"], "https://platform.openai.com/api-keys"),
    "anthropic": ("anthropic", ["ANTHROPIC_API_KEY"], "https://console.anthropic.com/settings/keys"),
    "@anthropic-ai/sdk": ("anthropic", ["ANTHROPIC_API_KEY"], "https://console.anthropic.com/settings/keys"),
    "google-generativeai": ("gemini", ["GOOGLE_API_KEY"], "https://aistudio.google.com/app/apikey"),
    "@google/generative-ai": ("gemini", ["GOOGLE_API_KEY"], "https://aistudio.google.com/app/apikey"),
    "mistralai": ("mistral", ["MISTRAL_API_KEY"], "https://console.mistral.ai/api-keys"),
    "cohere": ("cohere", ["CO_API_KEY"], "https://dashboard.cohere.com/api-keys"),
    "groq": ("groq", ["GROQ_API_KEY"], "https://console.groq.com/keys"),
    "boto3": ("aws", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"], "https://console.aws.amazon.com/iam/"),
    "aws-sdk": ("aws", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"], "https://console.aws.amazon.com/iam/"),
    "@aws-sdk/": ("aws", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"], "https://console.aws.amazon.com/iam/"),
    "github.com/aws/aws-sdk-go": ("aws", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"], "https://console.aws.amazon.com/iam/"),
    "google-cloud-": ("gcp", ["GOOGLE_APPLICATION_CREDENTIALS"], "https://console.cloud.google.com/iam-admin/serviceaccounts"),
    "@google-cloud/": ("gcp", ["GOOGLE_APPLICATION_CREDENTIALS"], "https://console.cloud.google.com/iam-admin/serviceaccounts"),
    "firebase-admin": ("firebase", ["GOOGLE_APPLICATION_CREDENTIALS"], "https://console.firebase.google.com/"),
    "azure-identity": ("azure", ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET"], "https://portal.azure.com/"),
    "@azure/identity": ("azure", ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET"], "https://portal.azure.com/"),
    "stripe": ("stripe", ["STRIPE_API_KEY"], "https://dashboard.stripe.com/apikeys"),
    "twilio": ("twilio", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"], "https://console.twilio.com/"),
    "sendgrid": ("sendgrid", ["SENDGRID_API_KEY"], "https://app.sendgrid.com/settings/api_keys"),
    "@sendgrid/mail": ("sendgrid", ["SENDGRID_API_KEY"], "https://app.sendgrid.com/settings/api_keys"),
    "resend": ("resend", ["RESEND_API_KEY"], "https://resend.com/api-keys"),
    "sentry-sdk": ("sentry", ["SENTRY_DSN"], "https://sentry.io/settings/projects/"),
    "@sentry/": ("sentry", ["SENTRY_DSN"], "https://sentry.io/settings/projects/"),
    "slack_sdk": ("slack", ["SLACK_BOT_TOKEN"], "https://api.slack.com/apps"),
    "@slack/web-api": ("slack", ["SLACK_BOT_TOKEN"], "https://api.slack.com/apps"),
    "@slack/bolt": ("slack", ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"], "https://api.slack.com/apps"),
    "supabase": ("supabase", ["SUPABASE_URL", "SUPABASE_KEY"], "https://supabase.com/dashboard/project/_/settings/api"),
    "@supabase/supabase-js": ("supabase", ["SUPABASE_URL", "SUPABASE_ANON_KEY"], "https://supabase.com/dashboard/project/_/settings/api"),
    "pinecone": ("pinecone", ["PINECONE_API_KEY"], "https://app.pinecone.io/"),
    "@pinecone-database/pinecone": ("pinecone", ["PINECONE_API_KEY"], "https://app.pinecone.io/"),
    "huggingface_hub": ("huggingface", ["HF_TOKEN"], "https://huggingface.co/settings/tokens"),
    "replicate": ("replicate", ["REPLICATE_API_TOKEN"], "https://replicate.com/account/api-tokens"),
    "langsmith": ("langsmith", ["LANGSMITH_API_KEY"], "https://smith.langchain.com/settings"),
    "e2b": ("e2b", ["E2B_API_KEY"], "https://e2b.dev/dashboard"),
    "PyGithub": ("github", ["GITHUB_TOKEN"], "https://github.com/settings/tokens"),
    "@octokit/rest": ("github", ["GITHUB_TOKEN"], "https://github.com/settings/tokens"),
}

#: Each dependency token as the matcher its scan uses, built once: a scoped
#: prefix (``@aws-sdk/``) is a substring; a bare name must stand alone on the line.
_DEP_MATCHERS = [
    (token, (lambda low, t=token.lower(): t in low) if token.endswith(("/", "-")) else re.compile(
        r"(^|[\s\"'/=<>~^\[,])" + re.escape(token.lower()) + r"($|[\s\"'=<>~^\[\],;:!@])").search)
    for token in SDK_IMPLICIT
]

DEP_FILES = {
    "package.json", "requirements.txt", "requirements-dev.txt", "pyproject.toml", "Pipfile",
    "setup.py", "setup.cfg", "go.mod", "Gemfile", "Cargo.toml", "composer.json",
}

#: A substring every SECRET_PATTERNS match contains — lines with none are skipped unscanned.
SECRET_MARKERS = ("sk-", "gh", "AKIA", "xox", "_live_", "AIza", "-----BEGIN", "://")

#: Hardcoded-secret shapes. Only the KIND is reported.
SECRET_PATTERNS = [
    ("anthropic-key", re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")),
    ("openai-key", re.compile(r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("slack-token", re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}")),
    ("stripe-live-key", re.compile(r"\b[sr]k_live_[A-Za-z0-9]{20,}")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("url-with-password", re.compile(r"\b[a-z][a-z0-9+.-]*://[^\s:/@'\"]+:[^\s@/'\"$]{3,}@([^\s/:'\"]+)")),
]
#: Words that mark a match as a placeholder or a test double, not a leak.
PLACEHOLDER = re.compile(r"\$\{|<[^>]+>|x{4,}|changeme|example|your[_-]|fake|dummy|not-a-real|placeholder|redacted|test",
                         re.I)
LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "example.com", "example.org", "host"}
#: A line this long is minified or generated — its matches are noise, not leaks.
MAX_SECRET_LINE = 1000

# ── per-language env reads ───────────────────────────────────────────────────
PY_INDEX = re.compile(r"os\.environ\[\s*['\"]" + NAME + r"['\"]\s*\]")
PY_GET = re.compile(r"(?:os\.environ\.get|os\.getenv|environ\.get|getenv)\(\s*['\"]" + NAME + r"['\"]\s*(,)?")
PY_SETDEFAULT = re.compile(r"os\.environ\.setdefault\(\s*['\"]" + NAME + r"['\"]")
JS_READ = re.compile(r"(?:process\.env|import\.meta\.env)(?:\.|\[\s*['\"])" + NAME + r"(['\"]\s*\])?(\s*!(?!=))?")
DENO_READ = re.compile(r"Deno\.env\.get\(\s*['\"]" + NAME + r"['\"]")
GO_READ = re.compile(r"os\.(Getenv|LookupEnv)\(\s*\"" + NAME + r"\"")
JAVA_READ = re.compile(r"System\.getenv\(\s*\"" + NAME + r"\"")
RUST_READ = re.compile(r"env::var\(\s*\"" + NAME + r"\"\s*\)(\s*\.\s*(unwrap_or\w*|unwrap|expect))?")
RUBY_FETCH = re.compile(r"ENV\.fetch\(\s*['\"]" + NAME + r"['\"]\s*(,|\)\s*\{)?")
RUBY_INDEX = re.compile(r"ENV\[\s*['\"]" + NAME + r"['\"]\s*\]")
PHP_READ = re.compile(r"(?:getenv\(\s*|\$_ENV\[\s*|\$_SERVER\[\s*|env\(\s*)['\"]" + NAME + r"['\"]\s*(,)?")
#: Config-helper reads: Strapi / AdonisJS / Laravel-style `env('X')`, `env.int('X', 3)`.
JS_ENV_HELPER = re.compile(r"(?<![\w.])env(?:\.\w+)?\(\s*['\"]" + NAME + r"['\"]\s*(?:,\s*([^)\s][^)]*))?\)")
CSHARP_READ = re.compile(r"Environment\.GetEnvironmentVariable\(\s*\"" + NAME + r"\"")
PRISMA_ENV = re.compile(r"env\(\s*\"" + NAME + r"\"\s*\)")

SHELL_REF = re.compile(r"\$\{" + NAME + r"(:?[?\-=+])?")
SHELL_BARE = re.compile(r"(?<![\w$])\$" + NAME + r"\b")
GH_SECRET = re.compile(r"\$\{\{\s*(?:secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
YAML_ENV_KEY = re.compile(r"^\s*-?\s*" + NAME + r"\s*[:=]")
DOCKER_ARG = re.compile(r"^\s*ARG\s+" + NAME + r"(\s*=)?")
DOCKER_ENV = re.compile(r"^\s*ENV\s+" + NAME + r"[\s=]")
TF_VAR = re.compile(r"^\s*variable\s+\"([A-Za-z_][A-Za-z0-9_]*)\"")
ENV_LINE = re.compile(r"^\s*(#\s*)?(?:export\s+)?" + NAME + r"\s*=\s*(.*)$")
TEST_SKIP = re.compile(r"skip(?:if|If|_unless|Unless)?\b|pytest\.mark\.skip|\.skip\(")
ZOD_FIELD = re.compile(r"^\s*" + NAME + r"\s*:\s*z\.")
PYDANTIC_FIELD = re.compile(r"^\s{4}([a-z_][a-z0-9_]*)\s*:\s*[^=]+?(=\s*.+)?$")
ENV_PREFIX = re.compile(r"env_prefix\s*=\s*['\"]([A-Za-z0-9_]*)['\"]")

TEMPLATE_SUFFIXES = (".example", ".sample", ".template", ".dist", ".defaults", ".tmpl")


class Inventory:
    def __init__(self, root: Path):
        self.root = root
        self.vars: dict[str, dict] = {}
        self.sdks: dict[str, dict] = {}
        self.credential_files: list[dict] = []
        self.alerts: list[dict] = []

    def add(self, name: str, path: Path, line: int, source: str, signal: str, note: str = "") -> None:
        if name in AMBIENT:
            return
        entry = self.vars.setdefault(name, {"name": name, "sources": [], "signals": [], "evidence": []})
        if source not in entry["sources"]:
            entry["sources"].append(source)
        if signal not in entry["signals"]:
            entry["signals"].append(signal)
        if len(entry["evidence"]) < MAX_EVIDENCE:
            ev = {"file": self.rel(path), "line": line, "source": source, "signal": signal}
            if note:
                ev["note"] = note[:160]
            entry["evidence"].append(ev)

    def rel(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.root))
        except ValueError:
            return str(path)

    def to_json(self) -> dict:
        return {
            "root": str(self.root),
            "vars": sorted(self.vars.values(), key=lambda v: v["name"]),
            "sdks": sorted(self.sdks.values(), key=lambda s: s["service"]),
            "credential_files": self.credential_files,
            "alerts": self.alerts,
        }


# ── classification of a file ─────────────────────────────────────────────────
def is_env_template(name: str) -> bool:
    lower = name.lower()
    return (lower.startswith(".env") or lower.endswith(".env")) and lower.endswith(TEMPLATE_SUFFIXES) or lower in {
        "example.env", "sample.env", "env.example", "env.sample", "env.template",
    }


def is_env_file(name: str) -> bool:
    lower = name.lower()
    return not is_env_template(name) and (lower == ".env" or lower.startswith(".env.") or lower == ".envrc"
                                          or lower == ".flaskenv" or lower.endswith(".env"))


def is_test_file(rel: str) -> bool:
    parts = rel.replace("\\", "/").split("/")
    name = parts[-1]
    return (
        any(p in {"test", "tests", "__tests__", "spec", "e2e"} for p in parts[:-1])
        or name.startswith("test_") or name.endswith(("_test.py", "_test.go", "conftest.py"))
        or re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", name) is not None
        or re.match(r"(jest|vitest|playwright)\.config\.", name) is not None
    )


def ci_kind(rel: str) -> bool:
    r = rel.replace("\\", "/")
    return (r.startswith(".github/workflows/") or r in {".gitlab-ci.yml", "bitbucket-pipelines.yml",
            ".circleci/config.yml", "azure-pipelines.yml", "Jenkinsfile", ".travis.yml"})


def is_compose(name: str) -> bool:
    return re.match(r"(docker-)?compose[\w.-]*\.ya?ml$", name) is not None


# ── scanners ─────────────────────────────────────────────────────────────────
def scan_env_template(inv: Inventory, path: Path, lines: list[str]) -> None:
    comment = ""
    for i, line in enumerate(lines, 1):
        m = ENV_LINE.match(line)
        if m:
            commented, name, value = m.group(1), m.group(2), m.group(3).strip().strip("'\"")
            signal = "optional" if commented else ("template" if not value else "template-value")
            inv.add(name, path, i, "env-template", signal, comment)
            comment = ""
        elif line.strip().startswith("#"):
            comment = line.strip().lstrip("#").strip()
        elif not line.strip():
            comment = ""


def scan_env_file(inv: Inventory, path: Path, lines: list[str]) -> None:
    for i, line in enumerate(lines, 1):
        m = ENV_LINE.match(line)
        if m and not m.group(1):
            inv.add(m.group(2), path, i, "env-file", "present")


def scan_code(inv: Inventory, path: Path, lines: list[str], test: bool) -> None:
    source = "test" if test else "code"
    for i, line in enumerate(lines, 1):
        low = line.lower()
        if "env" not in low and "_server" not in low:
            continue  # every reader below names env (getenv, process.env, ENV[, env::var…) or $_SERVER
        hits: list[tuple[str, str]] = []
        for m in PY_INDEX.finditer(line):
            hits.append((m.group(1), "hard"))
        for m in PY_GET.finditer(line):
            hits.append((m.group(1), "default" if m.group(2) else "read"))
        for m in PY_SETDEFAULT.finditer(line):
            hits.append((m.group(1), "default"))
        for m in JS_READ.finditer(line):
            rest = line[m.end():].lstrip()
            if m.group(3):
                sig = "hard"
            elif rest.startswith(("??", "||")):
                sig = "default"
            else:
                sig = "read"
            hits.append((m.group(1), sig))
        for m in DENO_READ.finditer(line):
            hits.append((m.group(1), "read"))
        for m in GO_READ.finditer(line):
            hits.append((m.group(2), "read"))
        for m in JAVA_READ.finditer(line):
            hits.append((m.group(1), "read"))
        for m in CSHARP_READ.finditer(line):
            hits.append((m.group(1), "read"))
        for m in RUST_READ.finditer(line):
            tail = m.group(3) or ""
            hits.append((m.group(1), "default" if tail.startswith("unwrap_or") else "hard" if tail else "read"))
        for m in RUBY_FETCH.finditer(line):
            hits.append((m.group(1), "default" if m.group(2) else "hard"))
        for m in RUBY_INDEX.finditer(line):
            hits.append((m.group(1), "read"))
        if path.suffix in {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"}:
            for m in JS_ENV_HELPER.finditer(line):
                fallback = (m.group(2) or "").strip()
                hits.append((m.group(1), "default" if fallback and fallback != "undefined" else "read"))
        if path.suffix == ".php":
            for m in PHP_READ.finditer(line):
                hits.append((m.group(1), "default" if m.group(2) else "read"))
        if test and hits and TEST_SKIP.search(line):
            hits = [(n, "test-skip") for n, _ in hits]
        for name, sig in hits:
            inv.add(name, path, i, source, sig)


def scan_pydantic(inv: Inventory, path: Path, lines: list[str]) -> None:
    text = "\n".join(lines)
    if "BaseSettings" not in text:
        return
    prefix_m = ENV_PREFIX.search(text)
    prefix = prefix_m.group(1).upper() if prefix_m else ""
    in_settings = False
    for i, line in enumerate(lines, 1):
        if re.match(r"^class\s+\w+\(.*BaseSettings.*\)\s*:", line):
            in_settings = True
            continue
        if in_settings and re.match(r"^\S", line):
            in_settings = False
        if not in_settings:
            continue
        m = PYDANTIC_FIELD.match(line)
        if m and m.group(1) not in {"model_config"}:
            default = m.group(2) or ""
            optional = bool(default) or "Optional[" in line or "| None" in line
            inv.add(prefix + m.group(1).upper(), path, i, "schema", "schema-default" if optional else "schema")


def scan_zod(inv: Inventory, path: Path, lines: list[str]) -> None:
    text = "\n".join(lines)
    if "createEnv" not in text and not re.search(r"(?i)env", path.name):
        return
    for i, line in enumerate(lines, 1):
        m = ZOD_FIELD.match(line)
        if m:
            optional = ".optional()" in line or ".default(" in line
            inv.add(m.group(1), path, i, "schema", "schema-default" if optional else "schema")


def scan_shellish(inv: Inventory, path: Path, lines: list[str], source: str) -> None:
    for i, line in enumerate(lines, 1):
        if "$" not in line or line.lstrip().startswith("#"):
            continue
        for m in SHELL_REF.finditer(line):
            op = m.group(2) or ""
            sig = "infra-hard" if "?" in op else "infra-default" if op else "read"
            inv.add(m.group(1), path, i, source, sig)
        for m in SHELL_BARE.finditer(line):
            inv.add(m.group(1), path, i, source, "read")


def scan_compose(inv: Inventory, path: Path, lines: list[str]) -> None:
    scan_shellish(inv, path, lines, "compose")
    in_env = False
    env_indent = 0
    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if stripped.startswith("environment:"):
            in_env, env_indent = True, indent
            continue
        if in_env and stripped and indent <= env_indent:
            in_env = False
        if in_env:
            m = YAML_ENV_KEY.match(line)
            if m:
                # `- KEY` / `KEY:` with no value passes the host's value through.
                has_value = re.search(r"[:=]\s*\S", line[m.end() - 1:]) is not None
                inv.add(m.group(1), path, i, "compose", "infra-default" if has_value else "read")


def scan_dockerfile(inv: Inventory, path: Path, lines: list[str]) -> None:
    for i, line in enumerate(lines, 1):
        m = DOCKER_ARG.match(line)
        if m:
            inv.add(m.group(1), path, i, "dockerfile", "infra-default" if m.group(2) else "read")
        m = DOCKER_ENV.match(line)
        if m:
            inv.add(m.group(1), path, i, "dockerfile", "infra-default")
    scan_shellish(inv, path, [ln for ln in lines if not DOCKER_ARG.match(ln)], "dockerfile")


def scan_terraform(inv: Inventory, path: Path, lines: list[str]) -> None:
    i = 0
    while i < len(lines):
        m = TF_VAR.match(lines[i])
        if not m:
            i += 1
            continue
        start, depth, body = i, 0, []
        while i < len(lines):
            depth += lines[i].count("{") - lines[i].count("}")
            body.append(lines[i])
            i += 1
            if depth <= 0 and "{" in "".join(body):
                break
        block = "\n".join(body)
        has_default = re.search(r"^\s*default\s*=", block, re.M) is not None
        sensitive = re.search(r"sensitive\s*=\s*true", block) is not None
        inv.add(f"TF_VAR_{m.group(1)}", path, start + 1, "terraform",
                "infra-default" if has_default else "infra-hard", "sensitive" if sensitive else "")


def scan_ci(inv: Inventory, path: Path, lines: list[str], rel: str) -> None:
    job = ""
    deploy_file = re.search(r"deploy|release|publish|cd\b", rel, re.I) is not None
    for i, line in enumerate(lines, 1):
        jm = re.match(r"^\s{2}([A-Za-z0-9_-]+):\s*$", line)
        if jm:
            job = jm.group(1)
        sig = "ci-deploy" if deploy_file or re.search(r"deploy|release|publish", job, re.I) else "ci-test"
        for m in GH_SECRET.finditer(line):
            inv.add(m.group(1).upper(), path, i, "ci", sig)
        for m in SHELL_REF.finditer(line):
            inv.add(m.group(1), path, i, "ci", sig)


def scan_deps(inv: Inventory, path: Path, lines: list[str]) -> None:
    for i, line in enumerate(lines, 1):
        low = line.strip().lower()
        if not low or low.startswith("#"):
            continue
        for token, matches in _DEP_MATCHERS:
            if not matches(low):
                continue
            service, names, help_url = SDK_IMPLICIT[token]
            sdk = inv.sdks.setdefault(service, {"service": service, "vars": names, "help_url": help_url,
                                                "evidence": []})
            if len(sdk["evidence"]) < 5:
                sdk["evidence"].append({"file": inv.rel(path), "line": i, "dependency": token})
            for name in names:
                inv.add(name, path, i, "sdk", "sdk", f"{service} SDK ({token})")


def scan_credential_file(inv: Inventory, path: Path, lines: list[str] | None) -> None:
    name = path.name.lower()
    kind = ""
    if name.endswith((".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")):
        kind = "key-material"
    elif name in {".npmrc", ".pypirc", ".netrc", "pip.conf", ".yarnrc.yml"}:
        kind = "registry-auth"
    elif name.endswith(".json") and lines is not None and any('"service_account"' in ln for ln in lines[:40]):
        kind = "service-account"
    if not kind:
        return
    inv.credential_files.append({"file": inv.rel(path), "kind": kind})
    if lines and kind == "registry-auth":
        for i, line in enumerate(lines, 1):
            for m in SHELL_REF.finditer(line):
                inv.add(m.group(1), path, i, "cred-file", "cred-file")


def scan_secrets(inv: Inventory, path: Path, lines: list[str]) -> None:
    if path.name.endswith((".min.js", ".map", ".lock")) or path.name in {"package-lock.json", "SOURCES.txt"}:
        return
    for i, line in enumerate(lines, 1):
        if len(line) > MAX_SECRET_LINE or not any(marker in line for marker in SECRET_MARKERS):
            continue
        for kind, pattern in SECRET_PATTERNS:
            m = pattern.search(line)
            if not m or PLACEHOLDER.search(m.group(0)):
                continue
            if kind == "url-with-password" and m.group(1).lower() in LOCAL_HOSTS:
                continue  # a local dev default (postgres:postgres@localhost) is not a leaked secret
            if kind.endswith(("-key", "-token")) and not re.search(r"\d", m.group(0)):
                continue  # real keys are random; an all-letter token is prose
            inv.alerts.append({"file": inv.rel(path), "line": i, "kind": kind})
            break


def read_lines(path: Path) -> list[str] | None:
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None


def walk(root: Path, include_nested: bool):
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        keep = []
        for d in dirnames:
            if d in SKIP_DIRS or d.endswith(".egg-info") or d.startswith("dist-"):
                continue
            if not include_nested and (here / d / ".git").exists():
                continue  # a nested repository is its own project
            keep.append(d)
        dirnames[:] = sorted(keep)
        for f in sorted(filenames):
            yield here / f


def scan(root: Path, include_nested: bool = False) -> Inventory:
    inv = Inventory(root)
    for path in walk(root, include_nested):
        rel = inv.rel(path)
        name = path.name
        suffix = path.suffix.lower()
        key_material = name.lower().endswith((".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"))
        if key_material:
            scan_credential_file(inv, path, None)
            continue
        lines = read_lines(path)
        if lines is None or any(len(ln) > MINIFIED_LINE for ln in lines[:50]):
            continue  # unreadable, or a minified/generated bundle — its env reads are a library's
        if is_env_template(name):
            scan_env_template(inv, path, lines)
            continue
        if is_env_file(name):
            scan_env_file(inv, path, lines)  # keys only; never secret-scanned, never echoed
            continue
        scan_credential_file(inv, path, lines)
        if name in DEP_FILES:
            scan_deps(inv, path, lines)
        if ci_kind(rel):
            scan_ci(inv, path, lines, rel)
        elif is_compose(name):
            scan_compose(inv, path, lines)
        elif name == "Dockerfile" or name.startswith("Dockerfile.") or suffix == ".dockerfile":
            scan_dockerfile(inv, path, lines)
        elif suffix == ".tf":
            scan_terraform(inv, path, lines)
        elif suffix == ".prisma":
            for i, line in enumerate(lines, 1):
                for m in PRISMA_ENV.finditer(line):
                    inv.add(m.group(1), path, i, "schema", "schema")
        elif suffix in SHELL_EXT or name in {"Makefile", "justfile", "Procfile"}:
            scan_shellish(inv, path, lines, "script")
        elif suffix in CODE_EXT:
            test = is_test_file(rel)
            scan_code(inv, path, lines, test)
            if suffix == ".py" and not test:
                scan_pydantic(inv, path, lines)
            if suffix in {".ts", ".js", ".mjs", ".cjs"} and not test:
                scan_zod(inv, path, lines)
        if suffix in CODE_EXT | SHELL_EXT | YAML_EXT | {".json", ".toml", ".ini", ".cfg", ".tf", ".md", ".txt"} \
                or name in {"Dockerfile", "Makefile"}:
            scan_secrets(inv, path, lines)
    return inv


def declared() -> dict:
    """What this project (and the user) already declare — the backend's own status."""
    from flow_sdk.cli.commands.credentials_cmd import _status  # noqa: PLC0415

    status = _status(None)
    return {
        "project_id": status.get("project_id"),
        "credentials": [
            {"name": c.get("name"), "typeid": c.get("typeid"), "scope": c.get("scope"),
             "vars": [v.get("env_var") for v in c.get("vars", [])]}
            for c in status.get("credentials", [])
        ],
        "env_files": [
            {"scope": f.get("scope"), "path": f.get("path"), "keys": [k.get("key") for k in f.get("detected", [])]}
            for f in status.get("files", [])
        ],
    }


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(__doc__)
        return 0
    try:
        if argv[0] == "scan":
            rest = [a for a in argv[1:] if not a.startswith("--")]
            root = Path(rest[0] if rest else ".").resolve()
            result = scan(root, include_nested="--include-nested" in argv).to_json()
        elif argv[0] == "declared":
            result = declared()
        else:
            print(json.dumps({"error": f"unknown command {argv[0]!r}"}))
            return 2
    except Exception as exc:  # one JSON object, always — stdout is the caller's only evidence
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
