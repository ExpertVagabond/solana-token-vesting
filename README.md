# solana-token-vesting

Token vesting contracts with cliff and linear unlock. Lock team tokens, investor allocations, or grant vesting with on-chain enforcement.

![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-9945FF?logo=solana&logoColor=white)
![Anchor](https://img.shields.io/badge/Anchor-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

## Features

- Cliff period support
- Linear unlock schedule
- Multiple beneficiaries
- On-chain vesting enforcement

## Program Instructions

`initialize` | `create_vesting` | `claim`

## Build

```bash
anchor build
```

## Test

```bash
anchor test
```

## Deploy

```bash
# Devnet
anchor deploy --provider.cluster devnet

# Mainnet
anchor deploy --provider.cluster mainnet
```

## Project Structure

```
programs/
  solana-token-vesting/
    src/
      lib.rs          # Program entry point and instructions
    Cargo.toml
tests/
  solana-token-vesting.ts           # Integration tests
Anchor.toml             # Anchor configuration
```

## License

MIT — see [LICENSE](LICENSE) for details.

## Author

Built by [Purple Squirrel Media](https://purplesquirrelmedia.io)
