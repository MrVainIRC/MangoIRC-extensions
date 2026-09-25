# LinkGuard v0.1.0

Initial public release of LinkGuard for Mango 3.1.

LinkGuard checks links in IRC messages against locally stored threat lists and marks potentially unsafe links directly in chat.

## Highlights

- Local link checking against enabled threat lists
- OpenPhish Community support
- Scam Blocklist Light support
- Additional public GitHub threat lists
- Local allow and block rules
- Configurable listed / not-listed markers
- Marker position before or after links
- Optional defanging of unsafe links
- Plain `http://` links can be treated as unsafe
- Automatic threat-list updates
- Local caching of downloaded lists
- Privacy-focused design — chat links are not submitted to external reputation services

## Requirements

- Mango 3.1 or newer

## Installation

Download the `LinkGuard-0.1.0.grove` file from this release and install it in Mango.

See the LinkGuard README for configuration and usage details.
