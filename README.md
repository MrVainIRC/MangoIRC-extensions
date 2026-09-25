# LinkGuard

LinkGuard is a MangoIRC client extension that checks links in IRC messages against locally stored threat lists.

It marks links directly in chat and can optionally defang unsafe links to reduce accidental clicks.

## Requirements

- Mango 3.1 or newer

## Features

- Checks links locally against enabled threat lists
- Marks links that match a threat source
- Can show a separate marker for links that are not found in loaded lists
- Can treat plain `http://` links as unsafe
- Can display unsafe links as `hxxp://` or `hxxps://`
- Supports local allow and block rules
- Supports additional public GitHub threat lists
- Automatically refreshes enabled lists
- Keeps downloaded threat data cached locally

## Built-in lists

LinkGuard includes support for:

- OpenPhish Community
- Scam Blocklist Light

You can enable or disable each source in the extension settings.

## Additional GitHub lists

You can add public GitHub files containing links or host entries.

Supported GitHub links are converted to their raw file URL automatically.

Additional lists are downloaded and checked locally.

## Local rules

Local rules can override downloaded list results.

Available rule types:

- **Host** — matches links on a host and its subdomains
- **Exact link** — matches one specific HTTP or HTTPS link
- **Wildcard** — matches links using `*`

Rules can either:

- **Allow** a matching link
- **Block** a matching link

If several rules match, the last matching rule is used.

## Link markers

LinkGuard can display a configurable symbol next to checked links.

For example:

```text
https://example.com ✓
https://unsafe.example ✕
```

The marker can appear before or after the link.

A link marked as not listed has only not been found in the currently enabled and loaded threat lists. It is not a guarantee that the link is safe.

## HTTP links

When **Treat HTTP links as unsafe** is enabled, plain `http://` links are treated as unsafe even if no threat list matches them.

## Defanging

When **Defang listed links** is enabled, unsafe links are displayed as:

```text
hxxp://example.com
hxxps://example.com
```

This only changes how the link is displayed in Mango. The original IRC message is not modified.

## Automatic list updates

Enabled threat lists are refreshed automatically.

The refresh interval can be set to:

- 6 hours
- 12 hours
- 24 hours

Downloaded lists are cached locally between updates.

## Privacy

LinkGuard is designed to keep link checking local.

Links from IRC messages are not submitted to external reputation services.

Network access is only used to download enabled threat lists from GitHub.

## License

These extensions are provided as-is, without warranty. Use them at your own risk.

See the license file for more information.