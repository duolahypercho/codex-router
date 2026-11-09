# Meta model coverage

Reviewed against Meta's official documentation on November 9, 2026.
The router's chat picker includes Muse Wonder (`muse-wonder-1.0`), Muse Ember
(`muse-ember-1.0`), Muse Spark 1.3 and 1.2 (Standard and Contributor), and
Muse Spark 1.1 through the existing Meta Responses provider.
Wonder and Ember expose minimal through max reasoning, defaulting to max.
Spark 1.3 Standard also supports max; Contributor does not. The router publishes
text and image input, the modalities supported by its client catalog.

The rest of the Meta product catalog cannot be added as ordinary Meta chat routes:

| Model | Availability / integration needed |
| --- | --- |
| Muse Wonder Full | Muse Code subscription only; no Model API ID. Wonder at max effort does not select Full. |
| Muse Spark Open | Self-hosted or separately hosted inference; needs an explicit endpoint and its credentials. |
| Muse Glimmer | Self-hosted inference; needs an explicit endpoint. |
| Muse Image 1.0 | Image generation/editing; requires media output handling, not an agent chat preset. |
| Muse Voice Transcribe | Dedicated file/realtime transcription API; not chat inference. |
| SAM 3.1 | Segmentation output (boxes/masks); requires a specialized integration. |

Selecting Meta still requires the user's Meta API credential and provider selection.
Adding presets does not enable providers or change model visibility preferences.
Contributor variants retain their training-data disclosure. Ember has higher
long-context pricing above 200K input tokens; consult the provider before use.
No quota-consuming inference probe is part of this catalog update.

Sources: [models](https://dev.meta.ai/docs/models),
[Wonder](https://dev.meta.ai/docs/muse-wonder),
[Ember](https://dev.meta.ai/docs/muse-ember), and
[reasoning](https://dev.meta.ai/docs/reasoning).
