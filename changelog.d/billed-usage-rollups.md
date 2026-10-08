- **Control Center retry totals now include the billed cost of every attempt.** Hourly
  traffic, Dashboard and Status events, model breakdowns, and Usage event
  fallbacks prefer billed input and output counts over the selected response's
  raw total, matching the provider usage summary. Missing billed components
  fall back to their raw counts, while measured zeros and ordinary non-retry
  totals retain their meaning.
