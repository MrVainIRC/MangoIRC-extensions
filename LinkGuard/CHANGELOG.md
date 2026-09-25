# Changelog

## 0.1.0

Initial public release.

- Server-scoped Grove Root with inbound URL reputation filtering.
- OpenPhish Community and optional Scam Blocklist Light support.
- Additional public GitHub threat-list sources.
- Local Allow/Block rules for domains, exact URLs, and wildcard URL patterns.
- Configurable listed/not-listed markers, marker position, plain-HTTP policy, and display-only defanging.
- Explicit Save workflow with Mango `settingsChanged` Root wake-up.
- Local source caching, serialized refreshes, bounded resource limits, and storage cleanup.
- Privacy-first local matching; chat URLs are never submitted to a reputation service.
