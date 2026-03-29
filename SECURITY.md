# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Flowpad, please report it responsibly.

**Email:** [security@langware.dev](mailto:security@langware.dev) (or the appropriate contact)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if any)

**Response timeline:**
- Acknowledgment: within 48 hours
- Initial assessment: within 5 business days
- Fix or mitigation: dependent on severity (Critical: 7 days, High: 14 days, Medium: 30 days)

**Do not** open a public GitHub issue for security vulnerabilities.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Current |

## Security Considerations for Agentic Workflows

Flowpad executes AI agent workflows that may interact with external APIs, handle credentials, and process sensitive data. The following areas warrant explicit security guidance:

### Credential Storage

Users authenticate via `flow auth login`, which stores API keys and tokens locally. The project should document:
- Where credentials are stored on disk
- Whether credentials are encrypted at rest
- Token rotation and expiration policies
- How `flow auth logout` ensures complete credential removal

### Workflow Execution Isolation

Workflows built with Flowpad's composable blocks (Do, If, Each, Set, Block, Call) can execute arbitrary logic. Consider documenting:
- Sandboxing or isolation boundaries between workflow steps
- Whether workflows can access resources beyond their declared scope
- How untrusted workflow definitions are handled

### Prompt Injection & Data Integrity

Agentic systems are susceptible to prompt injection attacks where external data sources embed malicious instructions. Flowpad's execution tracing is a strong foundation — extending it with input validation and output sanitization would strengthen the security posture.

### Dependency Security

The project uses `pyproject.toml` / `uv.lock` for Python and npm for TypeScript, which is good practice. Consider:
- Automated dependency scanning (e.g., Dependabot, Snyk)
- Pinning all transitive dependencies
- Regular security audits of the dependency tree

## Security Assessment Framework

This security policy was informed by an assessment using the [SOSA™ (Supervised, Orchestrated, Secured, Agents)](https://github.com/topics/sosa-agents) methodology — an open governance framework for evaluating AI agent systems across four pillars:

1. **Supervised** — Human-in-the-loop checkpoints for high-impact actions
2. **Orchestrated** — Structured Plan → Act → Verify execution patterns
3. **Secured** — Credential management, injection defense, dependency hygiene
4. **Agents** — Clear role boundaries, tool manifests, and domain scoping

Flowpad's execution tracing and composable blocks demonstrate strong orchestration. Adding explicit supervision gates and credential security documentation would move the project toward full SOSA compliance.

## License Clarification

The repository's copyright notice states "All rights reserved" while the homepage describes the project as "free and open source." Clarifying the license (e.g., adopting MIT, Apache 2.0, or another OSI-approved license) would help users understand their rights regarding security auditing, forking, and self-hosting.

---

*This SECURITY.md was contributed as part of a [SOSA™](https://github.com/topics/sosa-agents) community security assessment. For questions about the SOSA framework, see the [SOSA agent governance methodology](https://github.com/topics/sosa-agents).*