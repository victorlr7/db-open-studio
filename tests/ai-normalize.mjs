import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeAiProposalPayload } = jiti("../src/lib/ai-proposal.ts");

const proposal = normalizeAiProposalPayload({
  message: "Propuesta preparada.",
  changes: [
    {
      type: "message",
      message: "Necesito ignorar esta nota conversacional.",
    },
    {
      type: "add_table",
      name: "contact_type",
      columns: [{ name: "id", type: "uuid", primaryKey: true }],
    },
    {
      type: "add_relation",
      fromTableName: "contact",
      fromColumnName: "profile_id",
      toTableName: "profile",
      toColumnName: "id",
      cardinality: "one_to_one",
      onDelete: "SET_NULL",
      onUpdate: "NO ACTION",
    },
  ],
});

assert.equal(proposal.message, "Propuesta preparada.");
assert.equal(proposal.changes.length, 2);
assert.deepEqual(proposal.changes[0], {
  type: "add_table",
  name: "contact_type",
  columns: [{ name: "id", type: "uuid", primaryKey: true }],
});
assert.deepEqual(proposal.changes[1], {
  type: "add_relation",
  fromTableName: "contact",
  fromColumnName: "profile_id",
  toTableName: "profile",
  toColumnName: "id",
  cardinality: "one-to-one",
  onDelete: "set null",
  onUpdate: "no action",
});
assert.deepEqual(proposal.warnings, ["Necesito ignorar esta nota conversacional."]);

const incompleteProposal = normalizeAiProposalPayload({
  message: "Propuesta preparada.",
  changes: [
    {
      type: "update_column",
      tableName: "address",
      columnName: "country_id",
    },
    {
      type: "update_column",
      tableName: "address",
      columnName: "city",
      updates: { nullable: false },
    },
  ],
});

assert.equal(incompleteProposal.changes.length, 0);
assert.equal(incompleteProposal.message, "The AI returned an incomplete proposal. No model changes were prepared.");
assert.deepEqual(incompleteProposal.warnings, ["Ignored incomplete AI change of type update_column."]);

const normalizedPatchProposal = normalizeAiProposalPayload({
  message: "Propuesta preparada.",
  changes: [
    {
      type: "update_column",
      tableName: "address",
      columnName: "city",
      updates: { nullable: false },
    },
  ],
});

assert.equal(normalizedPatchProposal.changes.length, 1);
assert.deepEqual(normalizedPatchProposal.changes[0], {
  type: "update_column",
  tableName: "address",
  columnName: "city",
  updates: { nullable: false },
  patch: { nullable: false },
});

const aliasProposal = normalizeAiProposalPayload({
  message: "Propuesta preparada.",
  changes: [
    {
      type: "create_table",
      tableName: "public.country",
      fields: [
        { fieldName: "id", dataType: "uuid", pk: true },
        { fieldName: "name", dataType: "text", isNullable: false },
      ],
    },
    {
      type: "create_foreign_key",
      source: "public.user.country_id",
      targetTable: "public.country",
      onDelete: "SET_NULL",
    },
  ],
});

assert.equal(aliasProposal.changes.length, 2);
assert.deepEqual(aliasProposal.changes[0], {
  type: "add_table",
  tableName: "public.country",
  fields: [
    { fieldName: "id", dataType: "uuid", pk: true },
    { fieldName: "name", dataType: "text", isNullable: false },
  ],
  schema: "public",
  name: "country",
  columns: [
    { fieldName: "id", dataType: "uuid", pk: true, name: "id", type: "uuid", primaryKey: true },
    { fieldName: "name", dataType: "text", isNullable: false, name: "name", type: "text", nullable: false },
  ],
});
assert.deepEqual(aliasProposal.changes[1], {
  type: "add_relation",
  source: "public.user.country_id",
  targetTable: "public.country",
  onDelete: "set null",
  fromTableName: "public.user",
  fromColumnName: "country_id",
  toTableName: "public.country",
  toColumnName: "id",
  cardinality: undefined,
  onUpdate: undefined,
});
