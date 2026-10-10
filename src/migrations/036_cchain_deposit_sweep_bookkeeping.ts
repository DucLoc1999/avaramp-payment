import type { Knex } from 'knex';

const schema = process.env.DB_SCHEMA ?? 'avaramp';

/**
 * 036: C-Chain deposit sweep bookkeeping.
 *
 * The sweep lifecycle (`detected → confirmed → sweeping → swept | failed`) had no
 * retry metadata, which left two failure modes unfixable:
 *
 *   - A row stranded in `sweeping` (process death mid-flight, or a throw from
 *     `sweepUsdt` outside its try/catch) was never re-selected, so the funds were
 *     unreachable with no way to recover them.
 *   - A row in `failed` was re-selected on *every* poll, forever, submitting real
 *     permit/transferFrom transactions each time and burning Master Wallet gas.
 *
 * `sweeping_started_at` lets the listener reclaim abandoned in-flight sweeps,
 * `sweep_attempts` + `next_sweep_attempt_at` give retries a bounded exponential
 * backoff, and `last_sweep_error` makes failures observable — the previous code
 * discarded `sweepResult.error` entirely, so a permanently failing sweep looked
 * identical to a healthy poll.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema(schema).alterTable('cchain_deposits', (t) => {
    t.timestamp('sweeping_started_at').nullable();
    t.integer('sweep_attempts').notNullable().defaultTo(0);
    t.timestamp('next_sweep_attempt_at').nullable();
    t.string('last_sweep_error', 512).nullable();
  });

  await knex.schema.withSchema(schema).alterTable('cchain_deposits', (t) => {
    t.index(['status', 'next_sweep_attempt_at'], 'cchain_deposits_sweep_queue_idx');
    t.index(['status', 'sweeping_started_at'], 'cchain_deposits_stale_sweep_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema(schema).alterTable('cchain_deposits', (t) => {
    t.dropIndex('cchain_deposits_sweep_queue_idx');
    t.dropIndex('cchain_deposits_stale_sweep_idx');
    t.dropColumn('sweeping_started_at');
    t.dropColumn('sweep_attempts');
    t.dropColumn('next_sweep_attempt_at');
    t.dropColumn('last_sweep_error');
  });
}
