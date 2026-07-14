---
description: Read or update one Jira Service Management request with payload-bound comments and drift-resistant transition confirmation. Placeholders only.
disable-model-invocation: true
---

# /jira-update

## Risk metadata

- **Risk level:** R0 for reads/previews, R1 for one comment, and R3 for a reporter-visible workflow transition.
- **Access:** remote read or one separately confirmed remote write, according to the subcommand.
- **Credential-sensitive:** yes for live reads and writes; Jira credentials remain environment-only.
- **Invocation:** operator-only; Claude must not invoke this command automatically.

## Execution boundary

`scripts/jira-client.js` uses bare `--execute` to distinguish local preview from live API access. Every comment and transition also requires `--confirm VALUE`; it is a quoted, action-specific phrase, not a boolean consent flag. `--public` remains a bare visibility switch.

Create/comment confirmations bind the normalized Jira site and full serialized payload. Transition confirmation additionally binds the immutable issue ID, current-state hash, selected transition ID, and transition hash. Exact comparison is case- and whitespace-sensitive.

## Read one request

```bash
node scripts/jira-client.js get --issue [JIRA-###] --execute
```

The response must return the same issue key, a numeric immutable issue ID, and a valid current status.

## Add one comment

1. Preview the exact payload and visibility. Both commands are inert:

```bash
# Internal note; reporter cannot see it.
node scripts/jira-client.js comment --issue [JIRA-###] --body "[NOTE]"

# Public reply; reporter can see it.
node scripts/jira-client.js comment --issue [JIRA-###] --body "[REPLY TO USER]" --public
```

The required phrase has one of these shapes:

```text
POST INTERNAL JSM COMMENT ON <tenant>.atlassian.net ISSUE [JIRA-###] PAYLOAD SHA256 <64-hex-digest>
POST PUBLIC JSM COMMENT ON <tenant>.atlassian.net ISSUE [JIRA-###] PAYLOAD SHA256 <64-hex-digest>
```

2. Copy the entire value printed after `Required confirmation:`. Re-run the identical arguments with both controls. Here, `CONFIRMATION` means that exact copied phrase:

```bash
node scripts/jira-client.js comment --issue [JIRA-###] --body "[NOTE]" --execute --confirm "$CONFIRMATION"
node scripts/jira-client.js comment --issue [JIRA-###] --body "[REPLY TO USER]" --public --execute --confirm "$CONFIRMATION"
```

An INTERNAL phrase cannot authorize a PUBLIC comment, and a PUBLIC phrase cannot authorize an INTERNAL comment. Any body, issue, visibility, or site change invalidates the phrase. Missing or wrong confirmation loads no credentials and sends no request.

## Transition one request

Transitions can fire SLAs, automations, notifications, and reporter-visible workflow changes. Use this three-stage protocol:

1. Local preview, zero API calls:

```bash
node scripts/jira-client.js transition --issue [JIRA-###] --to "Resolved"
```

2. Read-only live preflight. This GETs the request and every paginated transition page, requires one unique transition match, and prints the exact confirmation. It does not POST:

```bash
node scripts/jira-client.js transition --issue [JIRA-###] --to "Resolved" --execute
```

The phrase shape is:

```text
TRANSITION JSM ISSUE [JIRA-###] ID <immutable-id> ON <tenant>.atlassian.net FROM STATE SHA256 <64-hex-digest> USING TRANSITION <numeric-id> SHA256 <64-hex-digest>
```

3. Copy that complete phrase and re-run the same selector with both controls:

```bash
node scripts/jira-client.js transition --issue [JIRA-###] --to "Resolved" --execute --confirm "$CONFIRMATION"
```

The exact invocation performs the live preflight, checks the copied phrase, then repeats the full preflight immediately before POST. State, issue identity, transition identity, pagination, or uniqueness drift stops before the write and prints a new required phrase. The client never follows a server-supplied pagination URL; it constructs bounded numeric pages on the already validated Jira host.

After Jira returns the documented transition acknowledgement, the client GETs the request again. Success requires the same issue key and immutable ID plus a changed current status.

## Failure behavior

- Local transition preview: zero credentials and zero network.
- Transition `--execute` without confirmation: read-only GET preflight; zero POST.
- Wrong/stale transition confirmation: preflight GETs may occur to recompute live state; zero POST.
- Duplicate transition names, duplicate transition IDs, missing match, malformed pages, or non-progressing pagination: zero POST.
- POST ambiguity, failed read-back, mismatched immutable ID, or unchanged status: exit 3 and `UNKNOWN/possibly changed`. Inspect the issue before retrying. No write is retried automatically.
- API response bodies are withheld from terminal errors.

## Risk warning

- `--public` makes a comment reporter-visible. Default visibility is INTERNAL.
- A transition is a state change even when its label sounds harmless. The confirmation must identify this exact issue state and transition; generic `yes`, a bare `--confirm`, or a phrase from another request cannot authorize it.

> **PREVIEW ONLY [jira-token-leak-response]:** A suspected token leak requires immediate credential-owner/provider revocation, but this Jira command cannot perform it. Do not paste the token; report only the credential type and route the exact credential identity to the private incident workflow.

## Verification

- Comment: the HTTP 201 receipt returned a valid immutable comment ID and an independent GET proved that ID, exact body, and intended visibility. Inspect the comment in JSM before reporting downstream effects.
- Transition: rely on the client's immutable-ID read-back and changed status. If it returns exit 3, do not claim completion and do not retry until the actual Jira state is inspected.
- Record the acknowledged or verified change in the local ticket thread so the work-up stays synchronized with `[JIRA-###]`.
