# DigitalTouch

DigitalTouch is a MangoIRC client composer extension for creating animated touch messages.

Draw with Apple Pencil, finger, mouse, or trackpad, add touch effects, replay the animation, and send the finished result through Mango's configured uploader.

## Requirements

- Mango 3.1 or newer

## Features

- Live animated drawing canvas
- Apple Pencil pressure support when available
- Mouse, trackpad, and touch input
- Four ink styles:
  - Ink
  - Neon
  - Comet
  - Electric
- Velocity-aware fading strokes
- Rounded stroke endings
- Five touch effects:
  - Tap
  - Fireball
  - Kiss
  - Heartbeat
  - Heartbreak
- Editable animation replay
- Timeline-position insertion while replaying
- Undo and clear controls
- Adjustable stroke size
- Adjustable playback speed
- Optional looping for animated image formats
- Configurable export size and frame rate
- Quality presets with custom settings
- GIF, APNG, WebP, WebM, and MP4 export
- Upload through Mango's configured uploader

## Drawing

DigitalTouch records drawing actions instead of recording the canvas in real time.

Idle time between actions is omitted from the animation timeline.

Stroke visibility is based on drawing velocity. Faster movement creates a longer visible trail, while slower movement fades sooner.

## Replay

Recorded drawings and effects can be replayed directly in the composer.

New strokes or effects added while replay is active are inserted at the current replay position instead of being appended to the end of the animation.

Playback speed can be changed directly in the composer.

## Touch effects

DigitalTouch includes several touch-style effects:

- **Tap** — creates a short expanding touch marker
- **Fireball** — creates a bright moving burst
- **Kiss** — creates an animated kiss effect
- **Heartbeat** — creates a beating heart animation
- **Heartbreak** — creates an animated breaking heart

The selected effect remains active until another drawing tool or effect is selected.

## Export formats

DigitalTouch supports several output formats.

### GIF

GIF provides broad compatibility and is usually the safest choice for inline playback.

### APNG

APNG preserves full color more accurately than GIF, but files can be larger.

### WebP

Animated WebP is encoded directly inside the extension using a bundled pure JavaScript VP8L encoder.

Some embedded WebViews may not play animated WebP even when the same file works correctly in Safari or another browser.

### WebM

WebM export uses the browser's media recording capabilities when supported by the current WebView.

### MP4

MP4 export also depends on media recording support provided by the current WebView.

## Export settings

The default export format and quality options can be configured in the extension settings.

Available presets are:

- Small
- Balanced
- High
- Max
- Custom

Selecting a preset immediately updates its related settings.

Changing an individual export setting switches the preset to **Custom**.

Format-specific options are only shown when they apply to the selected format.

Looping is controlled directly from the composer for animated image formats.

## Privacy

Drawing data and animation state stay inside the extension.

Only the finished export is handed to Mango's configured uploader.

DigitalTouch does not require an external service for image encoding.

## Third-party software

DigitalTouch includes a modified pure JavaScript WebP encoder based on the VP8L encoder from `cross-org/image`.

The encoder is distributed under the MIT License.

See `THIRD_PARTY_LICENSES.md` for the required copyright and license notices.

## License

DigitalTouch is licensed under the BSD 2-Clause License.

Third-party components may use different licenses. See `THIRD_PARTY_LICENSES.md` for details.
