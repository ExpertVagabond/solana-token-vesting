import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { SolanaTokenVesting } from "../target/types/solana_token_vesting";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("solana-token-vesting", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .solanaTokenVesting as Program<SolanaTokenVesting>;
  const connection = provider.connection;

  // Keypairs
  const authority = Keypair.generate();
  const beneficiary = Keypair.generate();

  // Mint
  let mint: PublicKey;

  // PDA addresses
  let vestingSchedulePda: PublicKey;
  let vestingBump: number;
  let vaultPda: PublicKey;

  // Token accounts
  let authorityAta: PublicKey;
  let beneficiaryAta: PublicKey;

  const decimals = 6;
  const totalAmount = new BN(10_000_000); // 10 tokens

  // Vesting timeline — using absolute timestamps in the past/future so that
  // the on-chain Clock (which starts near 0 on localnet) is consistent.
  // We use very early timestamps so the test validator clock can reach them.
  let startTs: BN;
  let cliffTs: BN;
  let endTs: BN;

  before(async () => {
    // Airdrop SOL
    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const sigs = await Promise.all([
      connection.requestAirdrop(authority.publicKey, airdropAmount),
      connection.requestAirdrop(beneficiary.publicKey, airdropAmount),
    ]);
    await Promise.all(
      sigs.map((sig) => connection.confirmTransaction(sig, "confirmed"))
    );

    // Create mint
    mint = await createMint(
      connection,
      authority,
      authority.publicKey,
      null,
      decimals
    );

    // Create token accounts and fund authority
    authorityAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        authority,
        mint,
        authority.publicKey
      )
    ).address;
    await mintTo(
      connection,
      authority,
      mint,
      authorityAta,
      authority,
      100_000_000
    );

    beneficiaryAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        beneficiary,
        mint,
        beneficiary.publicKey
      )
    ).address;

    // Derive PDAs
    [vestingSchedulePda, vestingBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vesting"),
        beneficiary.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), vestingSchedulePda.toBuffer()],
      program.programId
    );

    // Get current clock time from the cluster
    const slot = await connection.getSlot();
    const clockTime = await connection.getBlockTime(slot);
    const now = clockTime ?? Math.floor(Date.now() / 1000);

    // Set up a vesting schedule:
    // start = now - 100  (started 100 seconds ago)
    // cliff = now - 50   (cliff 50 seconds ago)
    // end   = now + 100  (ends 100 seconds from now)
    // Total duration: 200 seconds. Elapsed since start: ~100s. Vested ~ 50%.
    startTs = new BN(now - 100);
    cliffTs = new BN(now - 50);
    endTs = new BN(now + 100);
  });

  // -------------------------------------------------------------------------
  // create_vesting — creates schedule and deposits tokens in vault
  // -------------------------------------------------------------------------
  it("creates a vesting schedule and deposits tokens into vault", async () => {
    const authorityBefore = (await getAccount(connection, authorityAta)).amount;

    await program.methods
      .createVesting(totalAmount, startTs, cliffTs, endTs)
      .accounts({
        authority: authority.publicKey,
        beneficiary: beneficiary.publicKey,
        mint,
        authorityTokenAccount: authorityAta,
        vestingSchedule: vestingSchedulePda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    // Verify vesting schedule data
    const schedule = await program.account.vestingSchedule.fetch(
      vestingSchedulePda
    );
    assert.ok(schedule.authority.equals(authority.publicKey));
    assert.ok(schedule.beneficiary.equals(beneficiary.publicKey));
    assert.ok(schedule.mint.equals(mint));
    assert.ok(schedule.totalAmount.eq(totalAmount));
    assert.ok(schedule.releasedAmount.eq(new BN(0)));
    assert.ok(schedule.startTs.eq(startTs));
    assert.ok(schedule.cliffTs.eq(cliffTs));
    assert.ok(schedule.endTs.eq(endTs));
    assert.isFalse(schedule.revoked);

    // Verify vault received the tokens
    const vaultAccount = await getAccount(connection, vaultPda);
    assert.equal(vaultAccount.amount, BigInt(totalAmount.toNumber()));

    // Verify authority's balance decreased
    const authorityAfter = (await getAccount(connection, authorityAta)).amount;
    assert.equal(
      authorityBefore - authorityAfter,
      BigInt(totalAmount.toNumber())
    );
  });

  // -------------------------------------------------------------------------
  // Error: create_vesting with zero amount should fail
  // -------------------------------------------------------------------------
  it("fails to create vesting with zero amount", async () => {
    const otherBeneficiary = Keypair.generate();
    const [otherPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vesting"),
        otherBeneficiary.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );
    const [otherVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), otherPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .createVesting(new BN(0), startTs, cliffTs, endTs)
        .accounts({
          authority: authority.publicKey,
          beneficiary: otherBeneficiary.publicKey,
          mint,
          authorityTokenAccount: authorityAta,
          vestingSchedule: otherPda,
          vault: otherVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();
      assert.fail("Expected ZeroAmount error");
    } catch (err: any) {
      assert.include(err.toString(), "ZeroAmount");
    }
  });

  // -------------------------------------------------------------------------
  // Error: cliff before start should fail
  // -------------------------------------------------------------------------
  it("fails to create vesting with cliff before start", async () => {
    const otherBeneficiary = Keypair.generate();
    const [otherPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vesting"),
        otherBeneficiary.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );
    const [otherVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), otherPda.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .createVesting(
          totalAmount,
          new BN(1000), // start
          new BN(500), // cliff BEFORE start
          new BN(2000) // end
        )
        .accounts({
          authority: authority.publicKey,
          beneficiary: otherBeneficiary.publicKey,
          mint,
          authorityTokenAccount: authorityAta,
          vestingSchedule: otherPda,
          vault: otherVault,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();
      assert.fail("Expected CliffBeforeStart error");
    } catch (err: any) {
      assert.include(err.toString(), "CliffBeforeStart");
    }
  });

  // -------------------------------------------------------------------------
  // claim — after cliff, correct vested amount
  // -------------------------------------------------------------------------
  it("claims vested tokens after the cliff", async () => {
    const beneficiaryBefore = (await getAccount(connection, beneficiaryAta))
      .amount;

    await program.methods
      .claim()
      .accounts({
        beneficiary: beneficiary.publicKey,
        vestingSchedule: vestingSchedulePda,
        vault: vaultPda,
        beneficiaryTokenAccount: beneficiaryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([beneficiary])
      .rpc();

    const schedule = await program.account.vestingSchedule.fetch(
      vestingSchedulePda
    );
    const beneficiaryAfter = (await getAccount(connection, beneficiaryAta))
      .amount;
    const claimed = beneficiaryAfter - beneficiaryBefore;

    // The released amount should be > 0 (we are past the cliff)
    assert.isTrue(schedule.releasedAmount.gt(new BN(0)));
    assert.isTrue(claimed > 0n);

    // The claimed amount should be less than total (we are before end)
    assert.isTrue(schedule.releasedAmount.lt(totalAmount));

    // released_amount on schedule should match what beneficiary received
    assert.equal(claimed, BigInt(schedule.releasedAmount.toNumber()));
  });

  // -------------------------------------------------------------------------
  // claim — second claim gets additional vested tokens (not double)
  // -------------------------------------------------------------------------
  it("second claim gets only the newly vested portion", async () => {
    // Wait a tiny bit for more tokens to vest
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const scheduleBefore = await program.account.vestingSchedule.fetch(
      vestingSchedulePda
    );
    const releasedBefore = scheduleBefore.releasedAmount;
    const beneficiaryBefore = (await getAccount(connection, beneficiaryAta))
      .amount;

    await program.methods
      .claim()
      .accounts({
        beneficiary: beneficiary.publicKey,
        vestingSchedule: vestingSchedulePda,
        vault: vaultPda,
        beneficiaryTokenAccount: beneficiaryAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([beneficiary])
      .rpc();

    const scheduleAfter = await program.account.vestingSchedule.fetch(
      vestingSchedulePda
    );
    const beneficiaryAfter = (await getAccount(connection, beneficiaryAta))
      .amount;
    const newClaimed = beneficiaryAfter - beneficiaryBefore;

    // Should have claimed some additional tokens
    assert.isTrue(newClaimed > 0n);

    // Total released should equal sum of both claims
    assert.isTrue(scheduleAfter.releasedAmount.gt(releasedBefore));
  });

  // -------------------------------------------------------------------------
  // revoke — unvested tokens returned to authority
  // -------------------------------------------------------------------------
  it("revokes the vesting schedule and returns unvested tokens", async () => {
    const scheduleBefore = await program.account.vestingSchedule.fetch(
      vestingSchedulePda
    );
    const authorityBefore = (await getAccount(connection, authorityAta)).amount;
    const vaultBefore = (await getAccount(connection, vaultPda)).amount;

    await program.methods
      .revoke()
      .accounts({
        authority: authority.publicKey,
        vestingSchedule: vestingSchedulePda,
        vault: vaultPda,
        authorityTokenAccount: authorityAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const scheduleAfter = await program.account.vestingSchedule.fetch(
      vestingSchedulePda
    );
    const authorityAfter = (await getAccount(connection, authorityAta)).amount;
    const vaultAfter = (await getAccount(connection, vaultPda)).amount;

    // Schedule should be marked revoked
    assert.isTrue(scheduleAfter.revoked);

    // Authority should have received the unvested tokens
    const authorityGained = authorityAfter - authorityBefore;
    assert.isTrue(authorityGained > 0n);

    // Vault should have decreased by the unvested amount
    const vaultDecreased = vaultBefore - vaultAfter;
    assert.equal(authorityGained, vaultDecreased);

    // total_amount should now be reduced to the vested portion
    assert.isTrue(scheduleAfter.totalAmount.lt(scheduleBefore.totalAmount));
  });

  // -------------------------------------------------------------------------
  // Error: revoke already revoked should fail
  // -------------------------------------------------------------------------
  it("fails to revoke an already revoked schedule", async () => {
    try {
      await program.methods
        .revoke()
        .accounts({
          authority: authority.publicKey,
          vestingSchedule: vestingSchedulePda,
          vault: vaultPda,
          authorityTokenAccount: authorityAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();
      assert.fail("Expected AlreadyRevoked error");
    } catch (err: any) {
      assert.include(err.toString(), "AlreadyRevoked");
    }
  });

  // -------------------------------------------------------------------------
  // Error: claim on revoked schedule should fail
  // -------------------------------------------------------------------------
  it("fails to claim on a revoked schedule", async () => {
    try {
      await program.methods
        .claim()
        .accounts({
          beneficiary: beneficiary.publicKey,
          vestingSchedule: vestingSchedulePda,
          vault: vaultPda,
          beneficiaryTokenAccount: beneficiaryAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([beneficiary])
        .rpc();
      assert.fail("Expected AlreadyRevoked error");
    } catch (err: any) {
      assert.include(err.toString(), "AlreadyRevoked");
    }
  });

  // -------------------------------------------------------------------------
  // claim before cliff — should fail (separate vesting schedule)
  // -------------------------------------------------------------------------
  describe("claim before cliff", () => {
    const earlyBeneficiary = Keypair.generate();
    let earlyVestingPda: PublicKey;
    let earlyVaultPda: PublicKey;
    let earlyBeneficiaryAta: PublicKey;

    before(async () => {
      const sig = await connection.requestAirdrop(
        earlyBeneficiary.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");

      earlyBeneficiaryAta = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          earlyBeneficiary,
          mint,
          earlyBeneficiary.publicKey
        )
      ).address;

      [earlyVestingPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("vesting"),
          earlyBeneficiary.publicKey.toBuffer(),
          mint.toBuffer(),
        ],
        program.programId
      );
      [earlyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), earlyVestingPda.toBuffer()],
        program.programId
      );

      // Get current clock time
      const slot = await connection.getSlot();
      const clockTime = await connection.getBlockTime(slot);
      const now = clockTime ?? Math.floor(Date.now() / 1000);

      // Create a schedule where cliff is far in the future
      const futureStart = new BN(now - 10);
      const futureCliff = new BN(now + 10_000); // cliff 10,000 seconds from now
      const futureEnd = new BN(now + 20_000);

      await program.methods
        .createVesting(totalAmount, futureStart, futureCliff, futureEnd)
        .accounts({
          authority: authority.publicKey,
          beneficiary: earlyBeneficiary.publicKey,
          mint,
          authorityTokenAccount: authorityAta,
          vestingSchedule: earlyVestingPda,
          vault: earlyVaultPda,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();
    });

    it("fails to claim before the cliff", async () => {
      try {
        await program.methods
          .claim()
          .accounts({
            beneficiary: earlyBeneficiary.publicKey,
            vestingSchedule: earlyVestingPda,
            vault: earlyVaultPda,
            beneficiaryTokenAccount: earlyBeneficiaryAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([earlyBeneficiary])
          .rpc();
        assert.fail("Expected NothingToClaim error");
      } catch (err: any) {
        assert.include(err.toString(), "NothingToClaim");
      }
    });
  });
});
