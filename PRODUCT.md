# Product

## Register

product

## Users

- **Developers** use the Dispatch desktop app every day to send requests, organise collections, run tests and load tests, and sync with Postman. They live in it for hours, on a laptop or a large monitor.
- **Team leads and platform engineers** run `dispatch-server` for their team. They set it up once (claim it, connect Postman accounts, invite people), then drop into the admin panel occasionally: to add someone, grant a workspace, rotate a key, publish documentation or check the audit log after something went wrong. They are technical, careful, and often doing it between other work.

## Product Purpose

Dispatch is a native API client for REST, WebSocket, gRPC and GraphQL that works on its own, can sync both ways with Postman, and can connect to a self-hosted team server. The server's admin panel controls who reaches which workspace and holds the team's Postman keys, so it has to make the current state of access obvious and every change deliberate. Success: an admin can see at a glance who has access to what, make a change with confidence, and later prove what happened from the audit log.

## Brand Personality

Calm, precise, trustworthy. Quiet and exact, like Linear or Stripe's dashboard: nothing decorative, every word and element doing a job. The admin panel guards keys and access, so it should feel like confident infrastructure, not a marketing surface. Copy is plain and specific; it says what will happen, not how great it is.

## Anti-references

- Generic SaaS admin templates: rows of stat cards, hero metrics, gradient accents, icon-heavy sidebars, decorative illustrations in empty states.
- Alarm styling for routine states. Red and warning colours are for things that are actually wrong or destructive.
- Walls of identical buttons on every table row.

## Design Principles

1. **State first.** Show who has access to what, and whether things are healthy, before offering actions.
2. **Deliberate changes.** Routine actions are one click; destructive and security-relevant ones are clearly marked and confirmed.
3. **Quiet until it matters.** Neutral by default; colour and emphasis are reserved for status, problems and the one primary action on a screen.
4. **Plain, exact language.** Name the thing and the consequence. No filler, no jargon the admin didn't bring.
5. **One system.** The admin panel and the desktop app share tokens, type and components, so the whole product feels made by one team.

## Accessibility & Inclusion

WCAG 2.1 AA: 4.5:1 text contrast, visible focus on everything interactive, full keyboard use including dialogs and menus, and no meaning carried by colour alone. Respect `prefers-reduced-motion` and the reader's light or dark setting.
