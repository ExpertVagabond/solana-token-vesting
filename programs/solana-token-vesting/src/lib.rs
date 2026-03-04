use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PDdBRCev5VXyU6PQyuupCCjRQCBcH8KvsVZhBMMVvGr");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum VestingError {
    #[msg("Cliff timestamp must be >= start timestamp")]
    CliffBeforeStart,
    #[msg("End timestamp must be strictly greater than cliff timestamp")]
    EndNotAfterCliff,
    #[msg("Total vesting amount must be greater than zero")]
    ZeroAmount,
    #[msg("No tokens are available to claim at this time")]
    NothingToClaim,
    #[msg("Vesting schedule has already been revoked")]
    AlreadyRevoked,
    #[msg("No unvested tokens remain to revoke")]
    NothingToRevoke,
    #[msg("Arithmetic overflow")]
    Overflow,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod solana_token_vesting {
    use super::*;

    /// Create a new token-vesting schedule.
    ///
    /// The authority funds a PDA-owned vault with `total_amount` tokens and
    /// defines the vesting timeline (start, cliff, end) for the beneficiary.
    pub fn create_vesting(
        ctx: Context<CreateVesting>,
        total_amount: u64,
        start_ts: i64,
        cliff_ts: i64,
        end_ts: i64,
    ) -> Result<()> {
        require!(total_amount > 0, VestingError::ZeroAmount);
        require!(cliff_ts >= start_ts, VestingError::CliffBeforeStart);
        require!(end_ts > cliff_ts, VestingError::EndNotAfterCliff);

        // Populate the vesting schedule PDA.
        let schedule = &mut ctx.accounts.vesting_schedule;
        schedule.authority = ctx.accounts.authority.key();
        schedule.beneficiary = ctx.accounts.beneficiary.key();
        schedule.mint = ctx.accounts.mint.key();
        schedule.total_amount = total_amount;
        schedule.released_amount = 0;
        schedule.start_ts = start_ts;
        schedule.cliff_ts = cliff_ts;
        schedule.end_ts = end_ts;
        schedule.revoked = false;
        schedule.bump = ctx.bumps.vesting_schedule;

        // Transfer tokens from authority's account into the PDA vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            total_amount,
        )?;

        msg!(
            "Vesting created: {} tokens for {}, cliff at {}",
            total_amount,
            ctx.accounts.beneficiary.key(),
            cliff_ts,
        );
        Ok(())
    }

    /// Claim vested tokens.
    ///
    /// The beneficiary can call this at any time. Before the cliff, nothing is
    /// claimable. After the cliff, the claimable amount follows a linear
    /// schedule: `vested = total * (now - start) / (end - start)`.
    /// The actual payout is `vested - already_released`.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let schedule = &ctx.accounts.vesting_schedule;
        require!(!schedule.revoked, VestingError::AlreadyRevoked);

        let now = Clock::get()?.unix_timestamp;
        let vested = compute_vested_amount(schedule, now)?;
        let claimable = vested
            .checked_sub(schedule.released_amount)
            .ok_or(VestingError::Overflow)?;
        require!(claimable > 0, VestingError::NothingToClaim);

        // Build PDA signer seeds for the vault transfer.
        let beneficiary_key = schedule.beneficiary;
        let mint_key = schedule.mint;
        let bump = schedule.bump;
        let seeds: &[&[u8]] = &[
            b"vesting",
            beneficiary_key.as_ref(),
            mint_key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.beneficiary_token_account.to_account_info(),
                    authority: ctx.accounts.vesting_schedule.to_account_info(),
                },
                signer_seeds,
            ),
            claimable,
        )?;

        // Update the released amount on the schedule.
        let schedule = &mut ctx.accounts.vesting_schedule;
        schedule.released_amount = schedule
            .released_amount
            .checked_add(claimable)
            .ok_or(VestingError::Overflow)?;

        msg!("Claimed {} tokens", claimable);
        Ok(())
    }

    /// Revoke the vesting schedule.
    ///
    /// Only the original authority can revoke. All unvested tokens are returned
    /// to the authority's token account. The schedule is marked revoked so no
    /// further claims succeed. The beneficiary can still claim any already-
    /// vested-but-unreleased tokens via a separate `claim` before revocation,
    /// but after revocation the schedule is frozen.
    pub fn revoke(ctx: Context<Revoke>) -> Result<()> {
        let schedule = &ctx.accounts.vesting_schedule;
        require!(!schedule.revoked, VestingError::AlreadyRevoked);

        let now = Clock::get()?.unix_timestamp;
        let vested = compute_vested_amount(schedule, now)?;
        let unvested = schedule
            .total_amount
            .checked_sub(vested)
            .ok_or(VestingError::Overflow)?;

        require!(unvested > 0, VestingError::NothingToRevoke);

        // Build PDA signer seeds.
        let beneficiary_key = schedule.beneficiary;
        let mint_key = schedule.mint;
        let bump = schedule.bump;
        let seeds: &[&[u8]] = &[
            b"vesting",
            beneficiary_key.as_ref(),
            mint_key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.authority_token_account.to_account_info(),
                    authority: ctx.accounts.vesting_schedule.to_account_info(),
                },
                signer_seeds,
            ),
            unvested,
        )?;

        // Mark revoked and cap total to vested portion so released bookkeeping
        // stays consistent (beneficiary already claimed up to released_amount).
        let schedule = &mut ctx.accounts.vesting_schedule;
        schedule.revoked = true;
        schedule.total_amount = vested;

        msg!("Revoked: {} unvested tokens returned to authority", unvested);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Vesting math
// ---------------------------------------------------------------------------

/// Compute the total number of tokens that have vested as of `now`.
///
/// - Before cliff: 0
/// - After end:    total_amount
/// - Between cliff and end: `total_amount * (now - start) / (end - start)`
fn compute_vested_amount(schedule: &VestingSchedule, now: i64) -> Result<u64> {
    if now < schedule.cliff_ts {
        return Ok(0);
    }
    if now >= schedule.end_ts {
        return Ok(schedule.total_amount);
    }

    // Use u128 intermediate to avoid overflow on large token amounts.
    let elapsed = (now - schedule.start_ts) as u128;
    let duration = (schedule.end_ts - schedule.start_ts) as u128;
    let total = schedule.total_amount as u128;

    let vested = total
        .checked_mul(elapsed)
        .ok_or(VestingError::Overflow)?
        .checked_div(duration)
        .ok_or(VestingError::Overflow)?;

    Ok(vested as u64)
}

// ---------------------------------------------------------------------------
// Account structs
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct CreateVesting<'info> {
    /// The authority who funds and can later revoke the vesting schedule.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The beneficiary who will receive vested tokens. Does not need to sign.
    /// CHECK: Arbitrary public key used only as a PDA seed and stored on-chain.
    pub beneficiary: AccountInfo<'info>,

    /// The SPL token mint for the vesting tokens.
    pub mint: Account<'info, Mint>,

    /// The authority's token account that funds the vault.
    #[account(
        mut,
        constraint = authority_token_account.mint == mint.key(),
        constraint = authority_token_account.owner == authority.key(),
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    /// The vesting schedule PDA.
    #[account(
        init,
        payer = authority,
        space = 8 + VestingSchedule::INIT_SPACE,
        seeds = [b"vesting", beneficiary.key().as_ref(), mint.key().as_ref()],
        bump,
    )]
    pub vesting_schedule: Account<'info, VestingSchedule>,

    /// PDA-owned vault that holds the vesting tokens.
    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = vesting_schedule,
        seeds = [b"vault", vesting_schedule.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// The beneficiary claiming vested tokens.
    pub beneficiary: Signer<'info>,

    /// The vesting schedule PDA.
    #[account(
        mut,
        seeds = [b"vesting", beneficiary.key().as_ref(), vesting_schedule.mint.as_ref()],
        bump = vesting_schedule.bump,
        has_one = beneficiary,
    )]
    pub vesting_schedule: Account<'info, VestingSchedule>,

    /// PDA-owned vault holding the vesting tokens.
    #[account(
        mut,
        seeds = [b"vault", vesting_schedule.key().as_ref()],
        bump,
        token::mint = vesting_schedule.mint,
        token::authority = vesting_schedule,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The beneficiary's token account to receive claimed tokens.
    #[account(
        mut,
        constraint = beneficiary_token_account.mint == vesting_schedule.mint,
        constraint = beneficiary_token_account.owner == beneficiary.key(),
    )]
    pub beneficiary_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Revoke<'info> {
    /// The authority who created the vesting schedule.
    pub authority: Signer<'info>,

    /// The vesting schedule PDA.
    #[account(
        mut,
        seeds = [b"vesting", vesting_schedule.beneficiary.as_ref(), vesting_schedule.mint.as_ref()],
        bump = vesting_schedule.bump,
        has_one = authority,
    )]
    pub vesting_schedule: Account<'info, VestingSchedule>,

    /// PDA-owned vault holding the vesting tokens.
    #[account(
        mut,
        seeds = [b"vault", vesting_schedule.key().as_ref()],
        bump,
        token::mint = vesting_schedule.mint,
        token::authority = vesting_schedule,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// The authority's token account to receive returned unvested tokens.
    #[account(
        mut,
        constraint = authority_token_account.mint == vesting_schedule.mint,
        constraint = authority_token_account.owner == authority.key(),
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct VestingSchedule {
    /// The authority who created and can revoke the schedule.
    pub authority: Pubkey,       // 32
    /// The beneficiary who receives vested tokens.
    pub beneficiary: Pubkey,     // 32
    /// The SPL token mint.
    pub mint: Pubkey,            // 32
    /// Total number of tokens to vest (reduced on revoke).
    pub total_amount: u64,       // 8
    /// Number of tokens already released to the beneficiary.
    pub released_amount: u64,    // 8
    /// Unix timestamp when vesting begins.
    pub start_ts: i64,           // 8
    /// Unix timestamp of the cliff.
    pub cliff_ts: i64,           // 8
    /// Unix timestamp when vesting is fully complete.
    pub end_ts: i64,             // 8
    /// Whether the schedule has been revoked.
    pub revoked: bool,           // 1
    /// PDA bump seed.
    pub bump: u8,                // 1
}
