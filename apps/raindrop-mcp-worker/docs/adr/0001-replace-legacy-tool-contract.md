# Replace the legacy Raindrop MCP tool contract with official resource semantics

Status: accepted. Date: 2026-09-20.

The existing 17 tools combine reads, writes, and multiple operations, and some parameters or upstream mappings are incorrect. The approved redesign replaces that public surface with resource/action tools grounded in verified Raindrop API semantics, separates reads, writes, deletes, and explicit batch actions, removes old aliases and server-side AI Sampling, and retains the stateless Worker, MCP Portal, and two-credential deployment shape. This deliberately accepts one breaking client migration to avoid preserving incorrect behavior and a permanent compatibility layer; it does not authorize deployment or production-data mutation.
