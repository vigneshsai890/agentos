# Security

This repository contains an experimental/reference implementation. It is not a production security boundary and has no security support SLA.

## Reporting

Do not publish exploit details, credentials, personal data, or sensitive logs in issues or discussions. If GitHub Private Vulnerability Reporting is enabled, use **Security → Advisories → Report a vulnerability**. If it is unavailable, contact the repository owner through a privately verified GitHub channel and withhold sensitive details until a private channel is confirmed.

Reports should include the affected repository and revision, prerequisites, impact, minimal reproduction using synthetic data, and a suggested mitigation.

## Scope and residual risk

The module's README documents its trust boundaries and development-only components. Consumers remain responsible for authentication, authorization, tenant isolation, secret management, dependency review, sandboxing, network controls, durable storage, monitoring, backups, and incident response. Automated tests and CodeQL do not constitute a security audit.
