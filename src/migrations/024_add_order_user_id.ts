import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (t) => {
    // Logical reference to web-be.users.id (owned by web-be); no FK because the
    // users table lives in a different schema/service.
    t.integer('user_id').nullable();
    t.index('user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('orders', (t) => {
    t.dropIndex('user_id');
    t.dropColumn('user_id');
  });
}
