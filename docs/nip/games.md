# NIP-XX — Game Events (draft, not yet submitted)

`draft` `optional`

> **Meta:** This is the working draft to be proposed as a PR to
> [nostr-protocol/nips](https://github.com/nostr-protocol/nips). The kind
> numbers below are what two interoperating implementations (a game store /
> escrow and a game) run in production today — **except kind:31337, which has
> a confirmed de-facto collision with "Audio Track" (Zapstr/Stemstr/Wavlake,
> see [nips PR #1043](https://github.com/nostr-protocol/nips/pull/1043) and
> `registry-of-kinds`) and will be renumbered before submission** (candidate:
> 31339). Treat all numbers as provisional until registered in
> [registry-of-kinds](https://github.com/nostr-protocol/registry-of-kinds).
> Plan and prior-art research: [roadmap.md](roadmap.md). Canonical spec
> (Spanish, more detailed): [`../spec/`](../spec/README.md).

This NIP defines how games publish their social layer on Nostr: game identity,
player scores, oracle attestations, and transparent Lightning wagers. It reuses
existing NIPs wherever possible (NIP-23 for game identity, NIP-38 for presence,
NIP-17 for challenges, NIP-57 for deposits and payouts) and defines five new
kinds.

## Motivation

Web games routinely rebuild the same stack: accounts, leaderboards backends,
challenge inboxes, and ad-hoc payment integrations that die with the platform.
Nostr already provides portable identity (the player's key) and a network of
relays for signed, verifiable data. With the events below, a game gets a
leaderboard, presence, private challenges and auditable wagers with **no user
database**, and everything it publishes remains readable by any Nostr client
even if any single platform disappears.

## Game identity

A game is identified by the **coordinate of a NIP-23 long-form article**
describing it:

```
30023:<developer-pubkey>:<slug>
```

Throughout this NIP, `GAME` is that coordinate. All events below anchor to it
with an `a` tag. The article MAY declare the game's authorized oracle with an
`["oracle", "<pubkey>"]` tag (see *Attestations* and *Wagers*).

## Score event (kind:31337)

An addressable event **signed by the player** holding their best score on one
of the game's boards.

```jsonc
{
  "kind": 31337,
  "pubkey": "<player-pubkey>",
  "tags": [
    ["a", "<GAME>"],
    ["d", "<GAME>:<board>"],
    ["board", "classic"],
    ["score", "128400"],
    ["unit", "points"],
    ["client", "my-game-web"]
  ],
  "content": ""
}
```

- The `d` tag MUST be `<GAME>:<board>`, so each player holds exactly **one
  record per board** and relays replace older ones automatically.
- `board` MUST match `^[a-z0-9][a-z0-9_-]{0,63}$`. Games may run several
  boards (`classic`, `weekly`, `speedrun`, …).
- `score` MUST be a non-negative integer serialized as a string. The optional
  `unit` tag (`points`, `ms`, `goals`, …) tells ranking clients which direction
  is better (`ms` = lower is better).
- Reading a leaderboard requires no server:
  `{"kinds":[31337],"#a":["<GAME>"],"#board":["classic"]}` — group by pubkey,
  sort by score, resolve names via kind:0.

**Scores are self-reported and forgeable.** Clients MUST treat kind:31337 as
social data and MUST NOT use it to settle money. That is what attestations and
wager results are for.

## Score attestation (kind:31338)

An addressable event signed by an **oracle** (typically the game's server)
certifying an outcome it witnessed — e.g. the winner of a server-arbitrated
match.

```jsonc
{
  "kind": 31338,
  "pubkey": "<oracle-pubkey>",
  "tags": [
    ["a", "<GAME>"],
    ["d", "<GAME>:<ref>"],
    ["ref", "<unique-match-id>"],
    ["p", "<attested-player-pubkey>"],
    ["e", "<attested kind:31337 id>"],
    ["score", "128400"],
    ["status", "verified"]
  ],
  "content": ""
}
```

- The `d` tag MUST be `<GAME>:<ref>` with a unique `ref` per match, making the
  record permanent; re-signing the same `ref` corrects it.
- `status` is `verified` or `rejected` (revoking a previous attestation; the
  `p` tag MAY be omitted).
- Verifiers MUST only trust attestations whose signer equals the oracle pubkey
  declared in the game's kind:30023 article (`["oracle", "<pubkey>"]`).

This creates two tiers: an open tier (player-signed, social) and a verified
tier (oracle-signed, suitable for prizes).

## Presence and challenges (existing NIPs)

- **"Playing X" presence** is a standard NIP-38 status (kind:30315) with
  `["a", "<GAME>"]` and a short NIP-40 `expiration` (~30–60 s). Clearing it is
  an empty-content status with immediate expiration.
- **1v1 challenges** are standard NIP-17 private DMs whose kind:14 rumor
  carries `["game", "<GAME>"]`, `["room", "<room-id>"]`, `["url", "<join-url>"]`
  and `["expiration", "<ts>"]`. Receivers MUST discard expired challenges and
  SHOULD refuse to navigate to foreign origins.

## Wagers

A wager is coordinated entirely with public events. Money custody requires an
escrow (real trustlessness would need DLCs, out of scope); this NIP makes the
escrow **transparent**: every action it takes is a signed, public, verifiable
event. The guarantee is detectability, not impossibility — misbehavior is
publicly provable.

### Wager contract (kind:1339)

Regular (immutable) event signed by the **challenger**. Its `id` is the hash
of the terms.

```jsonc
{
  "kind": 1339,
  "pubkey": "<challenger-pubkey>",
  "tags": [
    ["a", "<GAME>"],
    ["p", "<player-1-pubkey>"],
    ["p", "<player-2-pubkey>"],
    ["p", "<escrow-pubkey>", "<relay-url>", "escrow"],
    ["p", "<oracle-pubkey>", "<relay-url>", "oracle"],
    ["stake", "1000"],
    ["deadline", "1751763600"],
    ["t", "ngp-bet"]
  ],
  "content": "1v1 on classic board, best of 3."
}
```

- `p` tags carrying an `escrow` or `oracle` token declare roles; plain `p`
  tags are the seats (one per participant, in order).
- `stake` is integer sats per seat; `deadline` is the funding cutoff (do NOT
  use NIP-40 `expiration` — relays may delete the event and the contract must
  survive as a record).
- Escrows SHOULD publish their fees and limits as a kind:31340 event with
  `["d","terms"]` so games can read them before creating contracts, and MAY
  ignore contracts until the first deposit attempt arrives (spam costs
  nothing; funding costs sats).

### Deposits are acceptance (NIP-57)

There is no acceptance event: each participant's **zap request (kind:9734)**
tagging the contract (`e`) and the escrow (`p`), with `amount` equal to the
stake, is their signature over the terms. The escrow publishes the standard
zap receipt (kind:9735), which embeds the signed 9734 — public proof of the
deposit.

### Escrow state (kind:31340)

Addressable event signed by the **escrow**, `d` = contract id: a single
current state per wager, every transition signed and timestamped.

```jsonc
{
  "kind": 31340,
  "pubkey": "<escrow-pubkey>",
  "tags": [
    ["d", "<contract-id>"],
    ["e", "<contract-id>"],
    ["a", "<GAME>"],
    ["status", "funded"],
    ["t", "ngp-bet"]
  ],
  "content": "{\"stakeSats\":1000,\"participants\":[\"<pk1>\",\"<pk2>\"],\"deposits\":[{\"p\":\"<pk1>\",\"receipt\":\"<9735-id>\"},{\"p\":\"<pk2>\",\"receipt\":\"<9735-id>\"}],\"feePct\":2}"
}
```

`status`: `accepted | rejected | funded | resolved | void | expired`. In
`resolved`, the content references the result event and the payout receipts,
so the entire settlement is auditable from one event.

### Wager result (kind:1341)

Regular (immutable) event signed by the **oracle declared in the contract**.
The signature is the authentication.

```jsonc
{
  "kind": 1341,
  "pubkey": "<oracle-pubkey>",
  "tags": [
    ["e", "<contract-id>"],
    ["a", "<GAME>"],
    ["p", "<winner-pubkey>"],
    ["status", "win"],
    ["t", "ngp-bet"]
  ],
  "content": ""
}
```

- `win` + 1..N `p` tags splits the pot among winners; `draw` (no `p`) refunds
  seats equally; `void` cancels with refunds and MAY also be signed by the
  challenger while no seat is funded yet.
- Escrows MUST verify: valid signature; signer equals the contract's declared
  oracle; contract is `funded`; winners ⊆ participants; and no earlier valid
  result exists (**first valid result wins**; later ones are ignored).
- Payouts are zaps (kind:9735) from the escrow to the winners, so third
  parties can check that amounts match `stake × seats − published fees`.

### Third-party audit chain

Any client can reconstruct a wager without contacting the escrow: contract
(1339) → declared oracle matches the game article → deposit receipts (9735
embedding each participant's 9734) → state transitions (31340) → result
(1341) → payout receipts (9735). If the escrow misbehaves, the event chain
proves it.

## Kinds summary

| kind | description | signer | type |
|---|---|---|---|
| 31337 | player score (per board) | player | addressable |
| 31338 | oracle attestation | oracle | addressable |
| 1339 | wager contract | challenger | regular |
| 1341 | wager result | oracle | regular |
| 31340 | escrow state / terms | escrow | addressable |

A companion protocol, **NGE** (encrypted request/response coordination with an
escrow over ephemeral kinds 24940/24941/24942, modeled on NIP-47), is
deliberately out of scope for this NIP and may be proposed separately.

## Implementations

- `nostr-game-protocol` (TypeScript SDK — reference wire implementation with
  signed test vectors): https://github.com/soyezequiel/Nostr-Game-Protocol
- Luna Negra (game store / transparent escrow / managed oracle), in production
  with real-sats wagers.
- Tetris for Luna Negra (game: scores, attestations, presence, challenges,
  contracts, BYO oracle).
