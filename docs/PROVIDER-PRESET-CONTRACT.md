# Provider preset contract

This document records a safe, inactive contract for future provider presets. It is not a provider registry and it is not consumed by the router runtime yet. A preset cannot add a model, select a provider, discover an endpoint, or send a request.

The validation helper is `src/provider-preset-contract.mjs`. It is deliberately standalone so the contract can be reviewed without importing the generic-provider implementation from the earlier stacked proposal.

## Accepted fields

Each preset contains only:

- `id`: lowercase provider identifier, unique against the checked-in registry;
- `displayName`: user-facing name;
- `protocol`: one of `openai-chat`, `openai-responses`, or `openai-completions`;
- `baseUrl`: absolute `https://` URL, or an explicitly private loopback/RFC1918 URL with `allowPrivate: true`;
- `allowPrivate`: explicit opt-in for private endpoints;
- `discoveryPath`: a short absolute path such as `/v1/models`;
- `auth`: exactly one of `none`, `credential-ref`, or `environment`.

Public endpoints must reference a credential through an opaque `cred_...` identifier or a validated uppercase environment variable name. Secret values, authorization headers, query-string keys, and URL userinfo are rejected.

## Deliberate non-features

The contract does not accept capability claims (`supportsTools`, vision, search, reasoning, or context size), retry policy, enablement, static headers, model lists, or discovery results. None of those fields is enforced by the current router boundary. Accepting them now would make the catalog promise behavior that routing does not prove.

The contract also performs lexical URL/path validation only. Any future runtime caller must resolve DNS, re-check the resolved address against its private/public policy, authenticate through the existing credential boundary, and bind the selected protocol before making a request. Until that caller exists, this module must remain metadata validation only.

## Activation requirements

An implementation that consumes this contract must be a separate change with:

1. an explicit caller in the request path;
2. credential resolution through the existing provider credential boundary;
3. protocol-specific request and response tests;
4. DNS-rebinding and path-escape tests;
5. catalog tests proving that only capabilities observed by the runtime are published.

This keeps the current router unchanged while preserving a reviewable boundary for a later, proven integration.
