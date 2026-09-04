# ADR-010: Pluggable Chat Provider

## Status

Accepted

## Date

2026-01-10

## Context

Need chat platform integration. Many options exist (Telegram, WhatsApp, Discord, Slack, etc.) with varying APIs, features, and target audiences.

## Decision

Build provider-agnostic interface:

- Define `ChatProvider` interface in `libs/chat-provider/`
- Each provider implements the interface (Telegram, WhatsApp, etc.)
- Store provider-specific metadata in `conversation_events.metadata`
- Core system never directly depends on specific provider

### Interface Contract

- Send message to chat
- Receive messages from chat
- Handle media (images, documents)
- Manage group membership

## Consequences

### Positive

- No lock-in to single platform
- Families can use their preferred chat app
- Provider abstraction enables future flexibility

### Negative

- Slightly more code than direct integration

### Trade-off

Worth the abstraction for flexibility
