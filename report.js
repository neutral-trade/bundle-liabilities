#!/usr/bin/env node
/**
 * NT Bundle Liabilities — point-in-time share liability report for Neutral Trade
 * bundle vaults, read directly from Solana mainnet.
 *
 * For each bundle vault this reports:
 *   - price per share
 *   - total shares issued
 *   - total value (redemption liability, in the vault's deposit token)
 *
 * Zero dependencies. Requires Node 18+.
 *
 * Usage:
 *   node report.js                     report every Bundle vault in the public registry
 *   node report.js <address> [...]     report specific bundle accounts
 *   node report.js --csv               CSV output (stdout)
 *   node report.js --rpc <url>         custom RPC endpoint (or SOLANA_RPC env var)
 */

"use strict";
const crypto = require("node:crypto");

const DEFAULT_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const DEFAULT_REGISTRY = "https://cdn.jsdelivr.net/gh/neutral-trade/sdk@main/src/registry/vaults.json";

// Bundle program deployments. The account's owner decides which struct layout applies:
// v2 ("jupiter" build) added min_deposit_amount, oracle_update_time_limit and
// oracle_max_age in the middle of the struct; v1 appended them after the original fields.
const PROGRAM_VERSIONS = {
  BUNDDh4P5XviMm1f3gCvnq2qKx6TGosAGnoUK12e7cXU: 1,
  BUNDeH5A4c47bcEoAjBhN3sCjLgYnRsmt9ibMztqVkC9: 2,
};

const KNOWN_MINTS = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
};

const STALE_ORACLE_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------- base58

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

function b58decode(str) {
  let n = 0n;
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base58 character "${ch}"`);
    n = n * 58n + BigInt(idx);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let body = Buffer.from(hex, "hex");
  if (n === 0n) body = Buffer.alloc(0);
  let zeros = 0;
  for (const ch of str) {
    if (ch !== "1") break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

function parseAddress(str) {
  let buf;
  try {
    buf = b58decode(str);
  } catch {
    buf = null;
  }
  if (!buf || buf.length !== 32) throw new Error(`"${str}" is not a valid Solana address`);
  return buf;
}

// ------------------------------------------- ed25519 / PDA derivation

const ED25519_P = 2n ** 255n - 19n;
const ED25519_D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function powmod(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

// RFC 8032 point decompression check: a 32-byte value is on the ed25519 curve
// iff its y coordinate decompresses to a valid x.
function isOnCurve(bytes) {
  const y = BigInt("0x" + Buffer.from(bytes).reverse().toString("hex")) & ((1n << 255n) - 1n);
  if (y >= ED25519_P) return false;
  const yy = (y * y) % ED25519_P;
  const u = (yy - 1n + ED25519_P) % ED25519_P;
  const v = (ED25519_D * yy + 1n) % ED25519_P;
  const v3 = (((v * v) % ED25519_P) * v) % ED25519_P;
  const v7 = (((v3 * v3) % ED25519_P) * v) % ED25519_P;
  let x = (((u * v3) % ED25519_P) * powmod((u * v7) % ED25519_P, (ED25519_P - 5n) / 8n, ED25519_P)) % ED25519_P;
  const vxx = (((v * x) % ED25519_P) * x) % ED25519_P;
  if (vxx !== u) {
    if (vxx !== (ED25519_P - u) % ED25519_P) return false;
    x = (x * powmod(2n, (ED25519_P - 1n) / 4n, ED25519_P)) % ED25519_P;
  }
  const signBit = (bytes[31] & 0x80) !== 0;
  if (x === 0n && signBit) return false;
  return true;
}

// Standard find_program_address: seeds ["ORACLE", bundle], owner program.
function deriveOraclePda(vaultBytes, programBytes) {
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = crypto
      .createHash("sha256")
      .update(Buffer.from("ORACLE"))
      .update(vaultBytes)
      .update(Buffer.from([bump]))
      .update(programBytes)
      .update(Buffer.from("ProgramDerivedAddress"))
      .digest();
    if (!isOnCurve(candidate)) return candidate;
  }
  throw new Error("unable to find oracle PDA");
}

// ---------------------------------------------------------- borsh decode

function anchorDiscriminator(accountName) {
  return crypto.createHash("sha256").update(`account:${accountName}`).digest().subarray(0, 8);
}

const BUNDLE_DISCRIMINATOR = anchorDiscriminator("Bundle");
const ORACLE_DISCRIMINATOR = anchorDiscriminator("OracleData");

function cursor(buf) {
  let offset = 0;
  return {
    skip(n) { offset += n; },
    bytes(n) { const b = buf.subarray(offset, offset + n); offset += n; return b; },
    u8() { return buf[offset++]; },
    u32() { const v = buf.readUInt32LE(offset); offset += 4; return v; },
    u64() { const v = buf.readBigUInt64LE(offset); offset += 8; return v; },
    i64() { const v = buf.readBigInt64LE(offset); offset += 8; return v; },
    u128() {
      const lo = buf.readBigUInt64LE(offset);
      const hi = buf.readBigUInt64LE(offset + 8);
      offset += 16;
      return lo + (hi << 64n);
    },
  };
}

function checkDiscriminator(data, expected, what, address) {
  if (data.length < 8 || !data.subarray(0, 8).equals(expected)) {
    throw new Error(`${address}: account is not a ${what} account (discriminator mismatch)`);
  }
}

function decodeBundle(data, version) {
  const c = cursor(data);
  c.skip(8); // discriminator
  const name = c.bytes(32).toString("utf8").replace(/\0/g, "").trim();
  c.skip(96); // manager, keeper, treasury_account
  c.skip(32 * c.u32()); // allocated_receivers: Vec<Pubkey>
  const underlyingBalance = c.u64(); // bundle_underlying_balance
  c.skip(8); // max_deposit_amount
  if (version === 2) c.skip(8); // min_deposit_amount
  c.skip(8); // withdrawal_delay
  c.skip(16); // performance_fee, management_fee_bps, deposit_fee, withdrawal_fee
  c.skip(16); // manager_pfee_shares
  c.skip(4); // current_allocation_bps
  c.skip(8); // oracle_buffer
  if (version === 2) c.skip(16); // oracle_update_time_limit, oracle_max_age
  const totalShares = c.u128();
  const assetPrecision = c.u64();
  const assetMint = b58encode(c.bytes(32)); // asset_address
  const assetDecimals = c.u8();
  return { name, underlyingBalance, totalShares, assetPrecision, assetMint, assetDecimals };
}

function decodeOracle(data) {
  const c = cursor(data);
  c.skip(8); // discriminator
  const externalEquity = c.u64(); // average_external_equity
  const lastUpdateTime = c.i64(); // last_update_time
  return { externalEquity, lastUpdateTime };
}

// ---------------------------------------------------------------- RPC

async function fetchJson(url, options) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function rpcCall(rpcUrl, method, params) {
  const body = { jsonrpc: "2.0", id: 1, method, params };
  const json = await fetchJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (json.error) throw new Error(`RPC error from ${method}: ${json.error.message}`);
  return json.result;
}

// Returns { slot, accounts: [{owner, data: Buffer} | null] }, chunked at the RPC's
// 100-key limit per getMultipleAccounts call.
async function getMultipleAccounts(rpcUrl, addresses) {
  const accounts = [];
  let slot = 0;
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const result = await rpcCall(rpcUrl, "getMultipleAccounts", [chunk, { encoding: "base64" }]);
    slot = Math.max(slot, result.context.slot);
    for (const acc of result.value) {
      accounts.push(acc ? { owner: acc.owner, data: Buffer.from(acc.data[0], "base64") } : null);
    }
  }
  return { slot, accounts };
}

// ---------------------------------------------------------- formatting

function fmtUnits(raw, precision, decimals, grouped) {
  const whole = raw / precision;
  const frac = raw % precision;
  const wholeStr = grouped ? whole.toLocaleString("en-US") : whole.toString();
  return decimals > 0 ? `${wholeStr}.${frac.toString().padStart(decimals, "0")}` : wholeStr;
}

function csvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function renderTable(rows, totals, snapshot) {
  const header = ["Vault", "Address", "Token", "Price/Share", "Total Shares", "Total Value"];
  const cells = rows.map((r) => [
    r.name,
    r.address,
    r.token,
    fmtUnits(r.ppsRaw, r.assetPrecision, r.assetDecimals, false),
    fmtUnits(r.totalShares, r.assetPrecision, r.assetDecimals, true),
    fmtUnits(r.totalValue, r.assetPrecision, r.assetDecimals, true),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const numeric = [false, false, false, true, true, true];
  const line = (row) =>
    row.map((cell, i) => (numeric[i] ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join("  ");

  console.log("NT Bundle Vault Liabilities");
  console.log(`Snapshot: slot ${snapshot.slot} | ${snapshot.time} | ${rows.length} vault(s)\n`);
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of cells) console.log(line(row));
  console.log("");
  for (const t of totals) {
    console.log(
      `TOTAL ${t.token}: ${fmtUnits(t.totalValue, t.assetPrecision, t.assetDecimals, true)} ` +
      `across ${fmtUnits(t.totalShares, t.assetPrecision, t.assetDecimals, true)} shares in ${t.count} vault(s)`
    );
  }
}

function renderCsv(rows, snapshot) {
  const header = [
    "vault_name", "vault_address", "deposit_token", "deposit_mint",
    "price_per_share", "total_shares", "total_value",
    "total_shares_raw", "total_value_raw",
    "oracle_last_update_utc", "snapshot_slot", "snapshot_time_utc",
  ];
  console.log(header.join(","));
  for (const r of rows) {
    console.log([
      csvField(r.name),
      r.address,
      r.token,
      r.assetMint,
      fmtUnits(r.ppsRaw, r.assetPrecision, r.assetDecimals, false),
      fmtUnits(r.totalShares, r.assetPrecision, r.assetDecimals, false),
      fmtUnits(r.totalValue, r.assetPrecision, r.assetDecimals, false),
      r.totalShares.toString(),
      r.totalValue.toString(),
      new Date(Number(r.oracleLastUpdate) * 1000).toISOString(),
      snapshot.slot,
      snapshot.time,
    ].join(","));
  }
}

// ------------------------------------------------------------------ main

function parseArgs(argv) {
  const opts = { csv: false, rpc: DEFAULT_RPC, registry: DEFAULT_REGISTRY, addresses: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--csv") opts.csv = true;
    else if (arg === "--rpc") opts.rpc = argv[++i];
    else if (arg === "--registry") opts.registry = argv[++i];
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else opts.addresses.push(arg);
  }
  if ((opts.rpc === undefined) || (opts.registry === undefined)) throw new Error("--rpc/--registry require a value");
  return opts;
}

const HELP = `NT Bundle Liabilities — share liability report for Neutral Trade bundle vaults

Usage:
  node report.js                     report every Bundle vault in the public registry
  node report.js <address> [...]     report specific bundle accounts
Options:
  --csv              CSV output instead of a table
  --rpc <url>        Solana RPC endpoint (default: $SOLANA_RPC or ${DEFAULT_RPC})
  --registry <url>   vault registry JSON (default: Neutral Trade public registry)
  --help             show this help`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  // Resolve the vault list and registry metadata (token symbols, names).
  let registry = [];
  try {
    const json = await fetchJson(opts.registry);
    if (Array.isArray(json)) registry = json;
  } catch (e) {
    if (!opts.addresses.length) throw new Error(`failed to load vault registry: ${e.message}`);
    process.stderr.write(`warning: failed to load vault registry (${e.message}); token symbols may be missing\n`);
  }
  const registryByAddress = new Map(registry.map((v) => [v.vaultAddress, v]));
  const addresses = opts.addresses.length
    ? [...new Set(opts.addresses)]
    : registry.filter((v) => v.type === "Bundle").map((v) => v.vaultAddress);
  if (!addresses.length) throw new Error("no bundle vaults to report on");

  const errors = [];
  const vaults = [];
  for (const address of addresses) {
    try {
      vaults.push({ address, bytes: parseAddress(address) });
    } catch (e) {
      errors.push(e.message);
    }
  }

  // Phase 1: discover each account's owner program (decides layout + PDA derivation).
  const phase1 = await getMultipleAccounts(opts.rpc, vaults.map((v) => v.address));
  const live = [];
  vaults.forEach((vault, i) => {
    const acc = phase1.accounts[i];
    if (!acc) return errors.push(`${vault.address}: account not found on mainnet`);
    const version = PROGRAM_VERSIONS[acc.owner];
    if (!version) return errors.push(`${vault.address}: owned by unknown program ${acc.owner} (not an NT bundle)`);
    const programBytes = parseAddress(acc.owner);
    live.push({ ...vault, version, oracleAddress: b58encode(deriveOraclePda(vault.bytes, programBytes)) });
  });

  // Phase 2: fetch every bundle and oracle account in one pass for a consistent slot.
  const keys = [...live.map((v) => v.address), ...live.map((v) => v.oracleAddress)];
  const phase2 = await getMultipleAccounts(opts.rpc, keys);
  const snapshot = { slot: phase2.slot, time: new Date().toISOString() };

  const rows = [];
  live.forEach((vault, i) => {
    try {
      const bundleAcc = phase2.accounts[i];
      const oracleAcc = phase2.accounts[live.length + i];
      if (!bundleAcc) throw new Error(`${vault.address}: bundle account disappeared between fetches`);
      if (!oracleAcc) throw new Error(`${vault.address}: oracle account ${vault.oracleAddress} not found`);
      checkDiscriminator(bundleAcc.data, BUNDLE_DISCRIMINATOR, "Bundle", vault.address);
      checkDiscriminator(oracleAcc.data, ORACLE_DISCRIMINATOR, "OracleData", vault.oracleAddress);

      const bundle = decodeBundle(bundleAcc.data, vault.version);
      const oracle = decodeOracle(oracleAcc.data);
      const precision = BigInt(bundle.assetPrecision);
      const totalValue = bundle.underlyingBalance + oracle.externalEquity;
      const ppsRaw = bundle.totalShares > 0n ? (totalValue * precision) / bundle.totalShares : precision;

      rows.push({
        name: bundle.name || registryByAddress.get(vault.address)?.name || "(unnamed)",
        address: vault.address,
        token: registryByAddress.get(vault.address)?.depositToken
          || KNOWN_MINTS[bundle.assetMint]
          || `${bundle.assetMint.slice(0, 4)}…${bundle.assetMint.slice(-4)}`,
        assetMint: bundle.assetMint,
        assetPrecision: precision,
        assetDecimals: bundle.assetDecimals,
        totalShares: bundle.totalShares,
        totalValue,
        ppsRaw,
        oracleLastUpdate: oracle.lastUpdateTime,
      });
    } catch (e) {
      errors.push(e.message);
    }
  });

  rows.sort((a, b) => (a.token === b.token ? (b.totalValue > a.totalValue ? 1 : -1) : a.token.localeCompare(b.token)));

  const totalsByMint = new Map();
  for (const row of rows) {
    const t = totalsByMint.get(row.assetMint) ||
      { token: row.token, assetPrecision: row.assetPrecision, assetDecimals: row.assetDecimals, totalValue: 0n, totalShares: 0n, count: 0 };
    t.totalValue += row.totalValue;
    t.totalShares += row.totalShares;
    t.count++;
    totalsByMint.set(row.assetMint, t);
  }

  if (opts.csv) renderCsv(rows, snapshot);
  else renderTable(rows, [...totalsByMint.values()], snapshot);

  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    const age = nowSeconds - Number(row.oracleLastUpdate);
    if (age > STALE_ORACLE_SECONDS) {
      process.stderr.write(`warning: ${row.name} (${row.address}) oracle last updated ${Math.floor(age / 3600)}h ago\n`);
    }
  }
  for (const err of errors) process.stderr.write(`error: ${err}\n`);
  return errors.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
);
