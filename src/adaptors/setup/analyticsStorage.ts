import type { SetupDatabase } from "~/interfaces/setup";

export const ANALYTICS_VERSION = 1;
type Column = {
  name: string;
  kind: "string" | "integer" | "time";
  length?: number;
  nullable?: boolean;
};
type Table = {
  name: string;
  model: string;
  columns: Column[];
  key: string[];
  indexes: { name: string; fields: string[] }[];
};
export const analyticsTables: Table[] = [
  {
    name: "xp_analytics_destinations",
    model: "XpAnalyticsDestination",
    columns: [
      { name: "destination_key", kind: "string", length: 64 },
      { name: "provider", kind: "string", length: 64 },
    ],
    key: ["destination_key"],
    indexes: [],
  },
  {
    name: "xp_analytics_deliveries",
    model: "XpAnalyticsDelivery",
    columns: [
      { name: "event_id", kind: "string", length: 36 },
      { name: "destination_key", kind: "string", length: 64 },
      { name: "provider", kind: "string", length: 64 },
      { name: "subject_id", kind: "string" },
      { name: "event_json", kind: "string" },
      { name: "state", kind: "string", length: 16 },
      { name: "attempts", kind: "integer" },
      { name: "created_at", kind: "time" },
      { name: "due_at", kind: "time" },
      { name: "lease_token", kind: "string", length: 36, nullable: true },
      { name: "completed_at", kind: "time", nullable: true },
      { name: "failure_reason", kind: "string", length: 128, nullable: true },
    ],
    key: ["event_id", "destination_key"],
    indexes: [
      { name: "xp_analytics_due_idx", fields: ["destination_key", "state", "due_at"] },
      { name: "xp_analytics_history_idx", fields: ["state", "completed_at"] },
      { name: "xp_analytics_age_idx", fields: ["destination_key", "state", "created_at"] },
    ],
  },
];

export function analyticsSqlType(column: Column, database: SetupDatabase) {
  if (column.kind === "time") return "BIGINT";
  if (column.kind === "integer") return "INTEGER";
  if (!column.length) return database === "mssql" ? "NVARCHAR(MAX)" : "TEXT";
  const type = `VARCHAR(${column.length})`;
  if (database === "mysql") return type + " COLLATE utf8mb4_0900_bin";
  if (database === "mssql") return type + " COLLATE Latin1_General_100_BIN2";
  return type;
}

export function renderAnalyticsSql(database: SetupDatabase) {
  const up: string[] = [];
  for (const table of analyticsTables) {
    const definitions = table.columns.map(
      (col) =>
        `${col.name} ${analyticsSqlType(col, database)} ${col.nullable ? "NULL" : "NOT NULL"}`,
    );
    definitions.push(`CONSTRAINT ${table.name}_pk PRIMARY KEY (${table.key.join(", ")})`);
    const suffix = database === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : "";
    up.push(`CREATE TABLE ${table.name} (\n  ${definitions.join(",\n  ")}\n)${suffix};`);
    for (const idx of table.indexes)
      up.push(`CREATE INDEX ${idx.name} ON ${table.name} (${idx.fields.join(", ")});`);
  }
  return { up, down: analyticsTables.toReversed().map((table) => `DROP TABLE ${table.name};`) };
}

export function analyticsMongoIndexes(table: Table) {
  return [
    {
      fields: table.key,
      name: table.key.length === 1 ? "xp_analytics_dest_key" : "xp_analytics_event_dest_key",
      unique: true,
    },
    ...table.indexes.map((idx) => ({ ...idx, unique: false })),
  ];
}
