# Desktop archive readback proofs

Signed proofs in bounded Desktop JSON result wrappers are decoded and verified
with the same signature, expiry and conversation/permission scope checks as
direct exec output. Wrapping is never permission to omit data.

Decoding is limited to eight nested levels, complete JSON strings of at most
64KiB, the first 64 array entries, and known text/output/content/value fields.
Missing, inaccessible, forged, expired or cross-context proofs keep full
tool output in the request. No source command is rerun to recover it.
