# ADR-0008 — Curated MCP tool surface

Status: accepted. Date: 2026-10-12. Source: H1=A.

## Context

The upstream Desktop Commander has more features than this application's v1 development scope.

## Decision

Expose only the necessary workspace file, search, development command and managed session tools via an explicit reviewed list. Keep client-visible schemas stable and validate the same scope on the Linux device. Do not automatically publish every upstream tool or configuration-management feature.

## Consequences

This reduces client-facing complexity and makes changes easier to review, at the cost of deliberately excluding other upstream tools. Exact schemas and limits remain open for subsequent review. This decision does not authorize implementation or deployment.
