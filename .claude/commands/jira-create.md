---
description: Create one Jira Service Management request through a dry-run and exact payload-bound confirmation. Placeholders only.
disable-model-invocation: true
---

# /jira-create

## Risk metadata

- **Risk level:** R0 for preview; R1 when one request is created.
- **Access:** remote write only after both bare `--execute` and an exact `--confirm VALUE` bind the destination and full payload.
- **Credential-sensitive:** yes during execution; Jira credentials remain environment-only and are not loaded before the confirmation matches.
- **Invocation:** operator-only; Claude must not invoke this command automatically.

## Execution boundary

The first invocation is always an inert preview. It serializes the exact payload, hashes that serialization with full SHA-256, and prints the only confirmation accepted for that destination and payload. Missing, declined, stale, case-changed, whitespace-changed, or otherwise incorrect confirmation makes no network request and loads no credentials.

This command uses `scripts/jira-client.js` and the Jira Service Management customer-request API. It creates a portal request, not a raw Jira issue.

## One-time setup

Set these values in the shell. Never put the token in a file or commit.

- `JIRA_SITE`: a bare `<tenant>.atlassian.net` hostname. Schemes, paths, ports, userinfo, trailing dots, IP addresses, and suffix variants are rejected.
- `JIRA_EMAIL`: the API-token owner's email.
- `JIRA_API_TOKEN`: the Atlassian API token.
- `JIRA_SERVICE_DESK_ID` and `JIRA_REQUEST_TYPE_ID`: optional positive numeric defaults.

The read-only discovery calls are:

```bash
node scripts/jira-client.js list-desks --execute
node scripts/jira-client.js list-types --service-desk [DESK_ID] --execute
```

## Create workflow

1. Preview the exact request. This makes no API call and does not read the email or token:

```bash
node scripts/jira-client.js create --summary "[ONE-LINE SUMMARY]" --description "[2-3 SENTENCE DESCRIPTION]"
```

The client prints the exact serialized JSON plus a phrase with this shape:

```text
CREATE JSM REQUEST ON <tenant>.atlassian.net DESK <numeric-id> TYPE <numeric-id> PAYLOAD SHA256 <64-hex-digest>
```

2. Review the site, desk, request type, summary, description, and optional reporter. Copy the entire value printed after `Required confirmation:` without editing it.

3. Re-run the identical payload with both controls. In this example, `CONFIRMATION` means the complete phrase copied from step 1:

```bash
node scripts/jira-client.js create --summary "[ONE-LINE SUMMARY]" --description "[2-3 SENTENCE DESCRIPTION]" --execute --confirm "$CONFIRMATION"
```

Changing the site, desk, request type, summary, description, or reporter changes the SHA-256 phrase and invalidates the earlier confirmation.

To create on behalf of a reporter, add `--on-behalf-of [USER@DOMAIN.COM]` to both invocations. Use only the operator-supplied reporter value; never invent one.

## Failure behavior

- No `--execute`: preview only, zero network.
- Missing or wrong `--confirm VALUE`: refusal, zero credential reads and zero network.
- Invalid `JIRA_SITE`: refusal before credentials or network.
- HTTP failure before Jira accepts the request: nonzero exit; response body is withheld.
- A write was attempted but the result could not be established: exit 3 and `UNKNOWN/possibly changed`. Inspect Jira before retrying; the client never retries a write automatically.

## Verification

The client accepts the HTTP 201 receipt only when it contains a valid issue key and immutable ID, then independently GETs that request. Success requires the same key/ID plus the approved service desk, request type, summary, and description. This does not prove downstream automation or notifications completed; open the exact request in JSM and verify its reporter and resulting automation state before reporting the wider workflow complete.

Paste the ticket's existing Jira-ready note into `--description`. After verified creation, record the returned `[JIRA-###]` key in the local ticket thread.
