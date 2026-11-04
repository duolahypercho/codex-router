#!/usr/bin/env node
// Keep the published manual hook path callable after retiring answer guessing.
// The model and client decide when a turn ends.
process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
