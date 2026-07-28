# NT Bundle Liabilities

Point-in-time report of the **share liabilities** of Neutral Trade bundle vaults, read
directly from Solana mainnet account data.

Neutral Trade bundle vaults do not issue SPL tokens. Vault shares are internal
accounting recorded in each vault's on-chain `Bundle` account. Those shares are
redeemable claims on the vault's equity — a liability: what would have to be paid out
if every holder redeemed at once. This tool quantifies that claim per vault:

- **price per share** — the exact redemption rate the program uses on-chain
- **total shares** — all shares issued by the vault
- **total value** — the full redemption liability, in the vault's deposit token

Everything is read from public mainnet state via standard JSON-RPC. No Neutral Trade
infrastructure is involved, so the numbers are independently reproducible by anyone.

## Requirements

Node.js 18 or newer. **No dependencies** — nothing to `npm install`; the report is a
single auditable file ([report.js](report.js)).

## Usage

```sh
# every Bundle vault in the public registry
node report.js

# specific bundle accounts
node report.js J7qhMAKnB6G5dvoAN9281ufabajKbyGQxxd2bq6R7fPJ

# CSV (includes raw base-unit integers, mints, oracle timestamps)
node report.js --csv > liabilities.csv
```

Options:

| Option | Description |
| --- | --- |
| `--csv` | CSV output instead of a table |
| `--rpc <url>` | Solana RPC endpoint (default: `$SOLANA_RPC` or `https://api.mainnet-beta.solana.com`) |
| `--registry <url>` | vault registry JSON (default: [Neutral Trade public registry](https://cdn.jsdelivr.net/gh/neutral-trade/sdk@main/src/registry/vaults.json)) |

The public default RPC is fine for this tool (it makes only a handful of batched
calls); pass `--rpc` if you prefer your own endpoint.

Sample output:

```
NT Bundle Vault Liabilities
Snapshot: slot 435746479 | 2026-07-28T12:51:28.786Z | 24 vault(s)

Vault                          Address                                       Token  Price/Share      Total Shares       Total Value
-----------------------------  --------------------------------------------  -----  -----------  ----------------  ----------------
Velox-Cross-USDC-Bundle        De47QBuMP7xukYBek5r4ScZF4HEk1kHW34ymKASz3DLt  USDC      1.012253  2,421,305.104138  2,450,975.679900
NT-Master-USDC-Bundle          J7qhMAKnB6G5dvoAN9281ufabajKbyGQxxd2bq6R7fPJ  USDC      1.013636  2,327,209.116888  2,358,943.127430
...

TOTAL USDC: 12,298,097.905086 across 11,849,093.512682 shares in 22 vault(s)
TOTAL USDE: 5,101.187700000 across 5,041.312036937 shares in 1 vault(s)
TOTAL USDT: 578.446523 across 567.918673 shares in 1 vault(s)
```

## Methodology

For each bundle vault address the tool reads two accounts:

1. the **`Bundle`** account (the address itself), and
2. its **`OracleData`** account — a PDA derived with seeds `["ORACLE", bundle_address]`
   under the program that owns the bundle account.

From those, using the same integer math the program itself uses to process
redemptions:

```
total value      = bundle_underlying_balance + average_external_equity
price per share  = total value × asset_precision ÷ total_shares
```

- `bundle_underlying_balance` (`Bundle`) — deposit tokens held by the vault itself
- `average_external_equity` (`OracleData`) — keeper-reported value of capital deployed
  outside the vault (exchange-smoothed on-chain oracle)
- `total_shares` (`Bundle`) — all shares issued; shares are denominated in the deposit
  token's base units (the first deposit mints shares 1:1, the ratio then floats with
  performance), so shares and values share one precision (`asset_precision = 10^decimals`)
- all amounts are in base units of the vault's deposit token (USDC/USDT = 6 decimals,
  shown in human units in the report)

`total_shares` includes shares held by the vault manager (accrued fees) — those are
redeemable claims like any others, so they belong in the gross liability figure.

### Program deployments

| Program | Layout |
| --- | --- |
| `BUNDDh4P5XviMm1f3gCvnq2qKx6TGosAGnoUK12e7cXU` | v1 |
| `BUNDeH5A4c47bcEoAjBhN3sCjLgYnRsmt9ibMztqVkC9` | v2 (adds `min_deposit_amount`, `oracle_update_time_limit`, `oracle_max_age` mid-struct) |

The account's owner (returned by the RPC) selects the layout; account discriminators
are verified before decoding. Reference IDLs for both layouts are in [idl/](idl/).

## Verifying independently

None of this needs to be taken on trust:

- Fetch any bundle account with your own RPC (`getAccountInfo`, base64) or an explorer
  and decode it against the IDLs in [idl/](idl/) — e.g. with `anchor account`, or by
  following the borsh layout in `report.js` (plain sequential little-endian fields).
- The report prints the **slot** it read from; both accounts for every vault are
  fetched in a single batched call for a consistent snapshot.
- The CSV includes the raw base-unit integers (`total_shares_raw`, `total_value_raw`)
  so derived figures can be checked without rounding ambiguity.

### Caveats

- `average_external_equity` is reported by Neutral Trade's keeper via an on-chain
  oracle. The CSV includes each vault's `oracle_last_update_utc`, and the tool warns on
  stderr when an oracle is older than 24h (typical for wound-down vaults).
- Values are denominated in each vault's deposit token, not USD. Totals are given per
  token; USD conversion is left to the reader.
- Deposits and withdrawals pending between netting cycles are not yet part of
  `total_shares` / vault equity; the report is a consistent snapshot of issued shares.
- This covers **Bundle** vaults only. Other Neutral Trade products (e.g. the Kamino
  USDC Max Yield vault) issue their own tokens and are accounted for separately.

## Registry

The default vault list is the public registry:
`https://cdn.jsdelivr.net/gh/neutral-trade/sdk@main/src/registry/vaults.json`
(entries with `"type": "Bundle"`). Passing explicit addresses bypasses the registry
filter, so any bundle account can be queried directly.
