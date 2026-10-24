- **Keep streamed function calls consistent when transport item IDs change.**
  Responses streams use the announced function item ID across argument events,
  the final item, and the completion snapshot. A known function output index
  permits normalization; conflicting IDs, invalid indices, and unknown calls
  remain errors.
