# Security policy

## Supported versions

Security fixes target the latest released version of this extension. Update to the latest release before checking whether a problem still occurs. Older releases do not receive separate security backports.

This is an independent VS Code extension. For vulnerabilities in the APM CLI itself, follow [Microsoft APM's security policy](https://github.com/microsoft/apm/security/policy).

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/aalmada/agent-package-manager-extension/security/advisories/new). Do not open a public issue or pull request with exploit details.

Include:

- The affected extension, VS Code, and APM CLI versions.
- The operating system and whether the extension runs locally or in a remote host.
- The impact, reproduction steps, and a minimal example using fictional data.
- Any suggested mitigation or fix.

Do not include real tokens, credentials, private package contents, or unsanitized logs. If a credential has been exposed, revoke or rotate it through its provider.

The maintainer will assess the report and coordinate remediation and disclosure in the private advisory. This volunteer-maintained project does not guarantee a response or resolution deadline.
